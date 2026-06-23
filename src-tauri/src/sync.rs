//! The sync engine (F2b): enable/disable, device pairing, and the encrypted pull→merge→
//! push loop against a user-configured server (`syncServerUrl`, empty by default).
//!
//! Design (v1): per namespace, PULL all records → decrypt → `sync_stores::merge_into`
//! (per-uuid HLC last-writer-wins) → PUSH the merged-latest. The server stores opaque
//! ciphertext keyed by (accountId, ns, uuid) and applies the SAME HLC-LWW on store (it has
//! the cleartext HLC, never the plaintext), so a stale push can't clobber a newer record —
//! no cursors needed for v1 (the synced stores are small; history is not synced). Requests
//! carry a per-device Ed25519 signed token (sync_auth). HTTP runs on a dedicated thread
//! (the proven reqwest-blocking pattern from subs.rs/update.rs).
//!
//! Only `favorites`/`saved`/`allowlist` sync in v1 (the array stores with the clean
//! merge_into seam). The settings + custom-filter projections are built in F2a and are a
//! documented fast-follow. An allowlist merge re-applies the engine (handled in merge_into).
use std::sync::Mutex;
use std::time::Duration;

use ed25519_dalek::Signer;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};
use zeroize::Zeroizing;

use crate::crypto::{self, RootSecret};
use crate::sync_keystore;
use crate::{sync_auth, sync_stores};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Status {
    Disabled,
    Idle,
    Syncing,
    Error,
}

impl Status {
    fn as_str(&self) -> &'static str {
        match self {
            Status::Disabled => "disabled",
            Status::Idle => "idle",
            Status::Syncing => "syncing",
            Status::Error => "error",
        }
    }
}

pub struct SyncState(pub Mutex<Inner>);

pub struct Inner {
    /// The master secret while unlocked (zeroized on drop when sync is disabled/locked).
    root: Option<RootSecret>,
    /// This device's Ed25519 signing seed (HKDF-derived per install). Zeroized on drop.
    device_seed: Option<Zeroizing<[u8; 32]>>,
    enabled: bool,
    account_id: String,
    device_id: String,
    backing: String,
    status: Status,
    last_sync_ms: i64,
    last_error: String,
}

impl Default for SyncState {
    fn default() -> Self {
        SyncState(Mutex::new(Inner {
            root: None,
            device_seed: None,
            enabled: false,
            account_id: String::new(),
            device_id: String::new(),
            backing: "none".into(),
            status: Status::Disabled,
            last_sync_ms: 0,
            last_error: String::new(),
        }))
    }
}

fn hex(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for x in b {
        s.push_str(&format!("{x:02x}"));
    }
    s
}

fn unhex(s: &str) -> Option<Vec<u8>> {
    if s.len() % 2 != 0 {
        return None;
    }
    (0..s.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(s.get(i..i + 2)?, 16).ok())
        .collect()
}

// A durable "user disabled sync" marker so disable() sticks across restarts (the seed may
// remain in the keychain when not forgotten, but boot must NOT auto-re-enable).
fn disabled_flag_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-disabled.flag"))
}
fn set_disabled_flag(app: &AppHandle, disabled: bool) {
    if let Some(p) = disabled_flag_path(app) {
        if disabled {
            let _ = std::fs::write(&p, b"1");
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
}
fn is_disabled_flag(app: &AppHandle) -> bool {
    disabled_flag_path(app).map(|p| p.exists()).unwrap_or(false)
}

fn state_json(app: &AppHandle) -> Value {
    let st = app.state::<SyncState>();
    let g = st.0.lock().unwrap();
    json!({
        "enabled": g.enabled,
        "status": g.status.as_str(),
        "serverUrl": crate::settings::sync_server_url(app),
        "lastSyncMs": g.last_sync_ms,
        "lastError": g.last_error,
        "deviceId": g.device_id,
        "accountId": g.account_id,
        "vaultBacking": g.backing,
    })
}

fn emit_state(app: &AppHandle) {
    crate::emit_event(app, "sync.state", state_json(app));
}

// --- wire (ciphertext) record <-> local record. The testable crypto seam. ---

/// Seal a local record into a wire record `{uuid, hlc, deleted, nonce, ct}` — cleartext
/// uuid/hlc/deleted (so the server can key/order without decrypting) + the sealed record.
fn seal_wire(data_key: &[u8; 32], ns: &str, rec: &Value) -> Result<Value, String> {
    let uuid = rec
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or("record missing uuid")?;
    let hlc = crate::sync_envelope::from_value(rec).ok_or("record missing hlc")?;
    let deleted = crate::jsonstore::is_deleted(rec);
    let plaintext = serde_json::to_vec(rec).map_err(|e| e.to_string())?;
    let (nonce, ct) = crypto::seal(data_key, ns, uuid, &hlc.bytes(), &plaintext)?;
    Ok(json!({
        "uuid": uuid,
        "hlc": rec.get("hlc").cloned().unwrap_or(Value::Null),
        "deleted": deleted,
        "nonce": hex(&nonce),
        "ct": hex(&ct),
    }))
}

/// Open a wire record back into the local record, authenticating it against the cleartext
/// uuid/hlc (the AAD binding). Returns the decrypted local record.
fn open_wire(data_key: &[u8; 32], ns: &str, w: &Value) -> Result<Value, String> {
    let uuid = w
        .get("uuid")
        .and_then(Value::as_str)
        .ok_or("wire missing uuid")?;
    let hlc = crate::sync_envelope::from_value(w).ok_or("wire missing hlc")?;
    let nonce = w
        .get("nonce")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("wire bad nonce")?;
    let ct = w
        .get("ct")
        .and_then(Value::as_str)
        .and_then(unhex)
        .ok_or("wire bad ct")?;
    let pt = crypto::open(data_key, &nonce, &ct, ns, uuid, &hlc.bytes())?;
    serde_json::from_slice(&pt).map_err(|e| e.to_string())
}

// --- HTTP (reqwest blocking on a dedicated thread, per the subs.rs pattern) ---

fn http(
    method: &'static str,
    url: String,
    auth: String,
    body: Option<Value>,
) -> Result<Value, String> {
    std::thread::spawn(move || -> Result<Value, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| e.to_string())?;
        let mut req = match method {
            "GET" => client.get(&url),
            "POST" => client.post(&url),
            _ => return Err("bad method".into()),
        };
        req = req.header("Authorization", auth);
        if let Some(b) = body {
            req = req.json(&b);
        }
        let resp = req.send().map_err(|e| e.to_string())?;
        let status = resp.status();
        let text = resp.text().unwrap_or_default();
        if !status.is_success() {
            return Err(format!("HTTP {status}: {text}"));
        }
        if text.is_empty() {
            return Ok(Value::Null);
        }
        serde_json::from_str(&text).map_err(|e| e.to_string())
    })
    .join()
    .map_err(|_| "http thread panicked".to_string())?
}

fn auth_header(account_id: &str, device_seed: &[u8; 32]) -> Result<String, String> {
    let (token, sig) = sync_auth::mint(
        device_seed,
        account_id,
        crate::jsonstore::now_ms(),
        sync_auth::DEFAULT_TTL_MS,
    )?;
    let token_json = serde_json::to_vec(&token).map_err(|e| e.to_string())?;
    Ok(format!(
        "AegisSig {}.{}.{}",
        account_id,
        hex(&token_json),
        sig
    ))
}

/// One sync pass: per namespace pull→merge→push. Runs on the caller's (background) thread.
fn sync_once(app: &AppHandle) -> Result<(), String> {
    // Snapshot what we need under the lock (clone the root; the clone zeroizes on drop).
    let (root, account_id, device_seed) = {
        let st = app.state::<SyncState>();
        let g = st.0.lock().unwrap();
        if !g.enabled {
            return Err("sync is not enabled".into());
        }
        match (&g.root, &g.device_seed) {
            (Some(r), Some(s)) => (r.clone(), g.account_id.clone(), Zeroizing::new(**s)),
            _ => return Err("sync is locked".into()),
        }
    };
    let server = crate::settings::sync_server_url(app);
    if server.is_empty() {
        return Err("no sync server configured (set it in Settings → Sync)".into());
    }
    let base = server.trim_end_matches('/').to_string();

    // Array stores (favorites/saved/allowlist) — per-uuid HLC-LWW via merge_into.
    for &ns in sync_stores::SYNCABLE {
        let dk = Zeroizing::new(crypto::data_key(&root, ns));
        let changed = sync_ns(
            app,
            &base,
            ns,
            &dk,
            &account_id,
            &device_seed,
            || sync_stores::read_all(app, ns),
            |remote| sync_stores::merge_into(app, ns, remote),
        )?;
        emit_changed(app, ns, &changed);
    }

    // Settings — per-KEY HLC-LWW applied to the flat file.
    {
        let dk = Zeroizing::new(crypto::data_key(&root, "settings"));
        let changed = sync_ns(
            app,
            &base,
            "settings",
            &dk,
            &account_id,
            &device_seed,
            || crate::settings::sync_records(app),
            |remote| crate::settings::merge_remote(app, remote),
        )?;
        emit_changed(app, "settings", &changed);
    }

    // Custom filters — a single record (HLC-LWW).
    {
        let dk = Zeroizing::new(crypto::data_key(&root, "customFilters"));
        let changed = sync_ns(
            app,
            &base,
            "customFilters",
            &dk,
            &account_id,
            &device_seed,
            || vec![crate::customfilters::sync_record(app)],
            |remote| {
                let mut ch = Vec::new();
                for r in remote {
                    if crate::customfilters::merge_remote(app, r) {
                        if let Some(u) = r.get("uuid").and_then(Value::as_str) {
                            ch.push(u.to_string());
                        }
                    }
                }
                ch
            },
        )?;
        emit_changed(app, "customFilters", &changed);
    }
    Ok(())
}

fn emit_changed(app: &AppHandle, ns: &str, changed: &[String]) {
    if !changed.is_empty() {
        crate::emit_event(
            app,
            "sync.changed",
            json!({ "namespace": ns, "changedUuids": changed }),
        );
    }
}

/// Pull → decrypt → merge → push for ONE namespace. `read_local` is read AFTER the merge so
/// the push reflects the merged-latest (the server applies HLC-LWW, so a stale push is
/// ignored). Decrypt/seal failures on a single record are skipped + logged, never aborting.
#[allow(clippy::too_many_arguments)]
fn sync_ns(
    _app: &AppHandle,
    base: &str,
    ns: &str,
    data_key: &[u8; 32],
    account_id: &str,
    device_seed: &[u8; 32],
    read_local: impl Fn() -> Vec<Value>,
    merge: impl Fn(&[Value]) -> Vec<String>,
) -> Result<Vec<String>, String> {
    let auth = auth_header(account_id, device_seed)?;
    let pulled = http(
        "GET",
        format!("{base}/v1/records?ns={ns}"),
        auth.clone(),
        None,
    )?;
    let mut decrypted = Vec::new();
    if let Some(arr) = pulled.get("records").and_then(Value::as_array) {
        for w in arr {
            match open_wire(data_key, ns, w) {
                Ok(rec) => decrypted.push(rec),
                Err(e) => eprintln!("[aegis-sync] skip undecryptable {ns} record: {e}"),
            }
        }
    }
    let changed = merge(&decrypted);
    let local = read_local();
    let mut wire = Vec::with_capacity(local.len());
    for r in &local {
        match seal_wire(data_key, ns, r) {
            Ok(w) => wire.push(w),
            Err(e) => eprintln!("[aegis-sync] skip unsealable {ns} record: {e}"),
        }
    }
    http(
        "POST",
        format!("{base}/v1/records"),
        auth,
        Some(json!({ "ns": ns, "records": wire })),
    )?;
    Ok(changed)
}

/// Register this device with the server (best-effort; needs a configured server). Carries
/// an ACCOUNT-ROOT signature over (accountId, deviceId): the account id is the account's
/// public key, so the server verifies this proves possession of the root — without it,
/// anyone who learned the public account id could self-register a rogue device.
fn register_device(
    app: &AppHandle,
    account_id: &str,
    device_id: &str,
    device_seed: &[u8; 32],
    root: &RootSecret,
) {
    let server = crate::settings::sync_server_url(app);
    if server.is_empty() {
        return;
    }
    let base = server.trim_end_matches('/').to_string();
    let account_sig = {
        let sk = crypto::account_signing_key(root);
        let msg = format!("aegis-register-v1\n{account_id}\n{device_id}");
        hex(&sk.sign(msg.as_bytes()).to_bytes())
    };
    if let Ok(auth) = auth_header(account_id, device_seed) {
        let label = format!("{} device", std::env::consts::OS);
        let _ = http(
            "POST",
            format!("{base}/v1/devices"),
            auth,
            Some(json!({
                "accountId": account_id, "deviceId": device_id,
                "label": label, "accountSig": account_sig,
            })),
        );
    }
}

/// Bring sync up for `root` (new or restored): derive identity, persist the seed, register,
/// set state. Returns the chosen vault backing.
fn enable_with_root(app: &AppHandle, root: RootSecret, passphrase: Option<&str>) {
    set_disabled_flag(app, false); // re-enabling clears any prior durable "disabled" marker
    let salt = sync_keystore::device_local_salt(app);
    let device_seed = crypto::device_signing_seed(&root, &salt);
    let device_id = sync_auth::device_id_for(&device_seed);
    let account_id = crypto::account_id(&root);
    let backing = sync_keystore::store_root(app, &root, passphrase);

    register_device(app, &account_id, &device_id, &device_seed, &root);

    {
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap();
        g.root = Some(root);
        g.device_seed = Some(Zeroizing::new(device_seed));
        g.enabled = true;
        g.account_id = account_id;
        g.device_id = device_id;
        g.backing = backing.as_str().to_string();
        g.status = Status::Idle;
        g.last_error.clear();
    }
    emit_state(app);
    nudge(app); // kick off an initial sync if a server is configured
}

/// Trigger a background sync pass (no-op if disabled). Debounced only by the engine status.
pub fn nudge(app: &AppHandle) {
    {
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap();
        if !g.enabled || g.status == Status::Syncing {
            return;
        }
        g.status = Status::Syncing;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Panic-safe: a panic in sync_once must reset status to Error, not leave it stuck
        // on "syncing" forever (SyncState's lock isn't held across sync_once, so no poison).
        let result =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sync_once(&app))) {
                Ok(r) => r,
                Err(_) => Err("sync task panicked".to_string()),
            };
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap();
        match result {
            Ok(()) => {
                g.status = Status::Idle;
                g.last_sync_ms = crate::jsonstore::now_ms();
                g.last_error.clear();
            }
            Err(e) => {
                g.status = Status::Error;
                g.last_error = e;
            }
        }
        drop(g);
        emit_state(&app);
    });
}

/// At boot: spawn the periodic background sync, then (unless the user durably disabled
/// sync) auto-unlock from the OS keychain and enable.
pub fn start(app: &AppHandle) {
    // Low-frequency periodic sync so peers converge even without local edits. A no-op while
    // disabled; debounced by the Syncing guard. One thread for the process lifetime.
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            std::thread::sleep(Duration::from_secs(300));
            nudge(&app);
        });
    }
    // Respect a durable disable (the seed may still be in the keychain if not forgotten).
    if is_disabled_flag(app) {
        return;
    }
    if !sync_keystore::has_stored_root(app) {
        return;
    }
    // Passphrase-backed vaults can't auto-unlock at boot (no passphrase yet) — they unlock
    // when the user provides it. The keychain path returns the root here.
    if let Some(root) = sync_keystore::load_root(app, None) {
        enable_with_root(app, root, None);
    }
}

/// Build the unauthenticated health-probe URL from a user-entered server URL. `None` for an
/// empty/whitespace entry. Trims surrounding whitespace and any trailing slashes.
fn healthz_url(raw: &str) -> Option<String> {
    let base = raw.trim().trim_end_matches('/');
    if base.is_empty() {
        return None;
    }
    Some(format!("{base}/healthz"))
}

/// Probe `{url}/healthz` (unauthenticated) with a short timeout. Returns a STRUCTURED result —
/// a failed probe is a value, not a thrown IPC error. Uses the spawn-thread + reqwest::blocking
/// pattern (blocking client can't run in the command's async context); 8s keeps it interactive.
fn test_connection(raw_url: &str) -> Value {
    let Some(target) = healthz_url(raw_url) else {
        return json!({ "ok": false, "error": "Enter a server URL first" });
    };
    let start = std::time::Instant::now();
    let probe = std::thread::spawn(move || -> Result<(), String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(8))
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&target).send().map_err(|e| e.to_string())?;
        let status = resp.status();
        if !status.is_success() {
            return Err(format!("HTTP {status}"));
        }
        Ok(())
    })
    .join()
    .map_err(|_| "probe thread panicked".to_string())
    .and_then(|r| r);
    match probe {
        Ok(()) => json!({ "ok": true, "latencyMs": start.elapsed().as_millis() as u64 }),
        Err(e) => json!({ "ok": false, "error": e }),
    }
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "sync.getState" => Some(Ok(state_json(app))),

        "sync.enableNew" => {
            let root = match crypto::generate_root() {
                Ok(r) => r,
                Err(e) => return Some(Err(e)),
            };
            let phrase = match crypto::root_to_phrase(&root) {
                Ok(p) => p,
                Err(e) => return Some(Err(e)),
            };
            let passphrase = payload.get("passphrase").and_then(Value::as_str);
            enable_with_root(app, root, passphrase);
            // Show-once: the phrase is returned here and never retrievable without confirm.
            Some(Ok(json!({ "recoveryPhrase": phrase })))
        }

        "sync.enableFromPhrase" => {
            let phrase = payload.get("phrase").and_then(Value::as_str).unwrap_or("");
            let root = match crypto::phrase_to_root(phrase) {
                Ok(r) => r,
                Err(e) => return Some(Err(e)),
            };
            let passphrase = payload.get("passphrase").and_then(Value::as_str);
            enable_with_root(app, root, passphrase);
            Some(Ok(state_json(app)))
        }

        "sync.disable" => {
            let forget = payload
                .get("forget")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            set_disabled_flag(app, true); // durable: don't auto-re-enable on next boot
            {
                let st = app.state::<SyncState>();
                let mut g = st.0.lock().unwrap();
                g.root = None; // dropped → zeroized
                g.device_seed = None;
                g.enabled = false;
                g.status = Status::Disabled;
                g.account_id.clear();
                g.device_id.clear();
            }
            if forget {
                sync_keystore::clear_root(app);
                let st = app.state::<SyncState>();
                st.0.lock().unwrap().backing = "none".into();
            }
            emit_state(app);
            Some(Ok(state_json(app)))
        }

        "sync.syncNow" => {
            nudge(app);
            Some(Ok(state_json(app)))
        }

        "sync.testConnection" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            Some(Ok(test_connection(url)))
        }

        "sync.getRecoveryPhrase" => {
            // Highest-sensitivity channel: gated on an explicit confirm; never logged.
            if !payload
                .get("confirm")
                .and_then(Value::as_bool)
                .unwrap_or(false)
            {
                return Some(Err("confirmation required".into()));
            }
            let st = app.state::<SyncState>();
            let g = st.0.lock().unwrap();
            match &g.root {
                Some(root) => match crypto::root_to_phrase(root) {
                    Ok(phrase) => Some(Ok(json!({ "recoveryPhrase": phrase }))),
                    Err(e) => Some(Err(e)),
                },
                None => Some(Err("sync is locked".into())),
            }
        }

        "sync.listDevices" => {
            let (account_id, device_seed) = {
                let st = app.state::<SyncState>();
                let g = st.0.lock().unwrap();
                match &g.device_seed {
                    Some(s) => (g.account_id.clone(), Zeroizing::new(**s)),
                    None => return Some(Ok(json!([]))),
                }
            };
            let server = crate::settings::sync_server_url(app);
            if server.is_empty() {
                return Some(Ok(json!([])));
            }
            let base = server.trim_end_matches('/').to_string();
            let auth = match auth_header(&account_id, &device_seed) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            match http("GET", format!("{base}/v1/devices"), auth, None) {
                Ok(v) => {
                    let this = app.state::<SyncState>().0.lock().unwrap().device_id.clone();
                    let devices: Vec<Value> = v
                        .get("devices")
                        .and_then(Value::as_array)
                        .cloned()
                        .unwrap_or_default()
                        .into_iter()
                        .map(|mut d| {
                            let is_this =
                                d.get("deviceId").and_then(Value::as_str) == Some(this.as_str());
                            if let Some(o) = d.as_object_mut() {
                                o.insert("isThisDevice".into(), json!(is_this));
                            }
                            d
                        })
                        .collect();
                    Some(Ok(json!(devices)))
                }
                Err(e) => Some(Err(e)),
            }
        }

        "sync.removeDevice" => {
            let device_id = payload
                .get("deviceId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let (account_id, device_seed) = {
                let st = app.state::<SyncState>();
                let g = st.0.lock().unwrap();
                match &g.device_seed {
                    Some(s) => (g.account_id.clone(), Zeroizing::new(**s)),
                    None => return Some(Err("sync is locked".into())),
                }
            };
            let server = crate::settings::sync_server_url(app);
            let base = server.trim_end_matches('/').to_string();
            let auth = match auth_header(&account_id, &device_seed) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            let _ = http(
                "POST",
                format!("{base}/v1/devices/remove"),
                auth,
                Some(json!({ "deviceId": device_id })),
            );
            // Return the refreshed list.
            dispatch(app, "sync.listDevices", &Value::Null)
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn healthz_url_builds_or_rejects() {
        assert_eq!(healthz_url(""), None);
        assert_eq!(healthz_url("   "), None);
        assert_eq!(
            healthz_url("http://h:8787"),
            Some("http://h:8787/healthz".to_string())
        );
        assert_eq!(
            healthz_url("http://h:8787/"),
            Some("http://h:8787/healthz".to_string())
        );
        assert_eq!(
            healthz_url("  https://sync.example.com/  "),
            Some("https://sync.example.com/healthz".to_string())
        );
        // A double trailing slash (copy-paste artifact) collapses to one — no `//healthz`.
        assert_eq!(
            healthz_url("http://h:8787//"),
            Some("http://h:8787/healthz".to_string())
        );
    }

    #[test]
    fn wire_seal_open_round_trips_a_record() {
        let key = crypto::data_key(&RootSecret([5u8; 32]), "favorites");
        let rec = json!({
            "id": 1, "name": "Example", "url": "https://example.com/",
            "uuid": "abc-123", "deleted": false,
            "hlc": { "wall_ms": 1234, "counter": 0, "node": "node-a" }
        });
        let wire = seal_wire(&key, "favorites", &rec).unwrap();
        // Cleartext routing fields are present; the body is sealed.
        assert_eq!(wire.get("uuid").and_then(Value::as_str), Some("abc-123"));
        assert_eq!(wire.get("deleted").and_then(Value::as_bool), Some(false));
        assert!(wire.get("ct").and_then(Value::as_str).is_some());
        // Round-trip back to the original record.
        let opened = open_wire(&key, "favorites", &wire).unwrap();
        assert_eq!(opened, rec);
    }

    #[test]
    fn wire_open_fails_with_the_wrong_namespace_key() {
        let key = crypto::data_key(&RootSecret([5u8; 32]), "favorites");
        let rec = json!({ "uuid": "u", "deleted": false, "hlc": { "wall_ms": 1, "counter": 0, "node": "n" } });
        let wire = seal_wire(&key, "favorites", &rec).unwrap();
        // Opening as a different namespace (different data key + AAD) must fail.
        let saved_key = crypto::data_key(&RootSecret([5u8; 32]), "saved");
        assert!(open_wire(&saved_key, "saved", &wire).is_err());
    }
}
