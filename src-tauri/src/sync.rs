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
use tauri::{AppHandle, Manager, Runtime};
use zeroize::Zeroizing;

use crate::crypto::{self, hex, unhex, RootSecret};
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
    /// Bumped every time sync is enabled/disabled. A pass snapshots it before it starts and
    /// re-checks before touching the network, so disabling mid-pass actually stops the upload
    /// instead of letting an already-spawned thread keep pushing the user's data. See
    /// [`cancelled`].
    generation: u64,
    /// Wall-clock time (ms) before which the client must not retry the server, because the last
    /// pass was refused with `429`. `0` / a value in the past means "no backoff in force".
    /// Deliberately NOT in `state_json` — it is retry bookkeeping, not user-visible state, and
    /// adding it would change the `shared/types.ts` IPC contract for no user-facing reason.
    rate_limit_until_ms: i64,
    /// Consecutive rate-limited passes, driving the exponential curve in
    /// [`rate_limit_backoff`]. Reset to 0 by the first pass that is not rate-limited.
    consecutive_rate_limits: u32,
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
            generation: 0,
            rate_limit_until_ms: 0,
            consecutive_rate_limits: 0,
        }))
    }
}

/// True when sync was enabled/disabled since `gen` was captured, i.e. the pass that
/// snapshotted `gen` must stop touching the network.
///
/// This is what makes "stop syncing" mean *stop now*. Previously `sync.disable` cleared the
/// root and set `Status::Disabled`, but a pass that had already snapshotted the root kept
/// pushing every namespace to the server, and then unconditionally wrote `Status::Idle` on
/// completion — so the UI showed a disabled account as idle while the upload finished.
fn cancelled<R: Runtime>(app: &AppHandle<R>, gen: u64) -> bool {
    let st = app.try_state::<SyncState>();
    let Some(st) = st else { return true };
    let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
    g.generation != gen || !g.enabled
}

// A durable "user disabled sync" marker so disable() sticks across restarts (the seed may
// remain in the keychain when not forgotten, but boot must NOT auto-re-enable).
fn disabled_flag_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-disabled.flag"))
}
fn set_disabled_flag<R: Runtime>(app: &AppHandle<R>, disabled: bool) {
    if let Some(p) = disabled_flag_path(app) {
        if disabled {
            let _ = std::fs::write(&p, b"1");
        } else {
            let _ = std::fs::remove_file(&p);
        }
    }
}
fn is_disabled_flag<R: Runtime>(app: &AppHandle<R>) -> bool {
    disabled_flag_path(app).map(|p| p.exists()).unwrap_or(false)
}

/// Whether sync is currently enabled for this install (i.e. the account is set up and not
/// disabled by the durable user-disabled marker). Read WITHOUT taking the state lock into a
/// long-held guard by callers that also need other state, so this is the cheap accessor the
/// vault bridge uses to decide whether it may sync at all.
pub fn is_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    app.try_state::<SyncState>()
        .map(|s| s.0.lock().unwrap_or_else(|e| e.into_inner()).enabled)
        .unwrap_or(false)
}

fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let st = app.state::<SyncState>();
    let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
    json!({
        "enabled": g.enabled,
        "status": g.status.as_str(),
        "serverUrl": crate::settings::sync_server_url(app),
        // The core's own view of the `syncAllowInsecure` waiver, so the UI can report the
        // decision that is actually in force rather than echoing the checkbox back.
        "allowInsecure": crate::settings::sync_allow_insecure(app),
        "lastSyncMs": g.last_sync_ms,
        "lastError": g.last_error,
        "deviceId": g.device_id,
        "accountId": g.account_id,
        "vaultBacking": g.backing,
        "hasStoredRoot": sync_keystore::has_stored_root(app),
    })
}

fn emit_state<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "sync.state", state_json(app));
}

// --- wire (ciphertext) record <-> local record. The testable crypto seam. ---

/// Seal a local record into a wire record `{uuid, hlc, deleted, nonce, ct}` — cleartext
/// uuid/hlc/deleted (so the server can key/order without decrypting) + the sealed record.
pub(crate) fn seal_wire(data_key: &[u8; 32], ns: &str, rec: &Value) -> Result<Value, String> {
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
pub(crate) fn open_wire(data_key: &[u8; 32], ns: &str, w: &Value) -> Result<Value, String> {
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
    // The recovered plaintext is user data (history titles, favorite URLs, vault records). Wrap
    // it in `Zeroizing` so the buffer is wiped as soon as this function returns instead of being
    // left on the freed heap — the sync root path already does this.
    let pt = crypto::open(data_key, &nonce, &ct, ns, uuid, &hlc.bytes())?;
    let pt = zeroize::Zeroizing::new(pt);
    let mut rec: Value = serde_json::from_slice(&pt).map_err(|e| e.to_string())?;
    // Adopt the server's ORDERING stamp. `hlc` is AEAD-bound (see `crypto::aad_for`), so the
    // server must never rewrite it — when it needs to break a cross-record HLC tie it records
    // the bump in a separate `ord` field and leaves `hlc` byte-identical. We take `ord` as the
    // record's HLC so our merge and our HLC clock agree with the server's total order instead of
    // re-deriving an arbitrary local tie-break. The AAD check above is unaffected: it ran against
    // the wire `hlc`, exactly as sent. Safe to repeat — the next push seals with whatever we
    // adopted, and the server echoes that same value back as `hlc`.
    //
    // BUT `ord` is the one field the server AUTHORS instead of relaying, so the AEAD check does
    // not cover it and it needs its own bound: adopted blind, `ord.wall_ms = i64::MAX` is a
    // namespace-wide permanent poison (no later local edit can ever dominate it, on any device).
    // `ord_is_adoptable` requires a well-formed HLC no further ahead than the same
    // `MAX_REMOTE_SKEW_MS` window the receive path already trusts; a refused `ord` falls back to
    // the wire `hlc`, which IS authenticated, so the cost is a lost tie-break and nothing else.
    if let Some(ord) = w
        .get("ord")
        .filter(|o| !o.is_null())
        .filter(|o| crate::sync_envelope::ord_is_adoptable(o, crate::jsonstore::now_ms()))
    {
        if Some(ord) != w.get("hlc") {
            if let Some(o) = rec.as_object_mut() {
                o.insert("hlc".to_string(), ord.clone());
            }
        }
    }
    Ok(rec)
}

// --- HTTP (reqwest blocking on a dedicated thread, per the subs.rs pattern) ---

/// Background sync/registration HTTP timeout (these run off the UI thread, so generous).
const SYNC_TIMEOUT_SECS: u64 = 30;
/// Interactive HTTP timeout for user-initiated device calls that still run on the IPC
/// thread — kept short so a slow/unreachable server can't freeze the window for long.
const INTERACTIVE_TIMEOUT_SECS: u64 = 8;

fn http(
    method: &'static str,
    url: String,
    auth: String,
    body: Option<Value>,
    timeout_secs: u64,
) -> Result<Value, String> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(timeout_secs))
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
        // A 429 is the ONE failure the client can do something useful about: the server is
        // rate-limiting this device, and the lockout is a sliding window that only clears as
        // the tokens already issued expire (`sync_auth::DEFAULT_TTL_MS`). Retrying sooner just
        // re-enters the window, so it gets a recognisable prefix and drives an exponential
        // backoff in `nudge`. Every other status is genuinely indistinguishable to us, so it
        // keeps the plain form. Tagged (not merely formatted) so `is_rate_limit_error` cannot
        // match on a server's own body text by accident.
        if status == reqwest::StatusCode::TOO_MANY_REQUESTS {
            return Err(format!("{RATE_LIMIT_ERR_PREFIX} ({text})"));
        }
        return Err(format!("HTTP {status}: {text}"));
    }
    if text.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_str(&text).map_err(|e| e.to_string())
}

/// The canonical prefix of the error [`http`] returns for `429 Too Many Requests`.
///
/// A single source of truth shared by the producer ([`http`]) and the consumer
/// ([`is_rate_limit_error`]), so the two cannot drift apart. The error channel is a plain
/// `String` end-to-end (≈10 call sites, surfaced to the UI verbatim as `lastError`), so a
/// documented marker is the cheapest way to carry the one piece of structured information the
/// retry policy needs.
pub(crate) const RATE_LIMIT_ERR_PREFIX: &str = "rate limited by the sync server";

/// Whether an error from [`http`] is the server refusing new requests from this device.
///
/// The server returns `429` from two caps in its replay-nonce map — per-device and global (see
/// `sync-server/src/main.rs`). The cap check runs BEFORE the nonce is recorded, so a refused
/// request consumes nothing: retrying immediately is *safe* but pointless, because the map is
/// only swept of entries that have EXPIRED, and a token lives [`crate::sync_auth::DEFAULT_TTL_MS`]
/// (5 minutes). A client that cannot tell a rate-limit from a real error therefore retries every
/// `syncIntervalSec` — the minimum is 1 second — for up to 5 minutes, i.e. up to ~300 wasted
/// signed round trips, and reports a bare "HTTP 429" to the user with no hint that waiting is
/// the fix.
pub(crate) fn is_rate_limit_error(e: &str) -> bool {
    e.starts_with(RATE_LIMIT_ERR_PREFIX)
}

/// How long to stop retrying for after `consecutive` consecutive rate-limited passes.
///
/// Exponential, because the server's own lockout is a sliding window that only clears as tokens
/// expire — a constant short delay would keep the client inside it, and a constant long one
/// would stall sync long after the server would have accepted it again. The cap is the token TTL
/// itself: waiting longer than that can never help, because by then every nonce this device minted
/// has expired and the map has necessarily been swept.
pub(crate) fn rate_limit_backoff(consecutive: u32) -> Duration {
    const BASE_SECS: u64 = 30;
    // Cap the shift at 32 so a client left rate-limited for a very long time cannot overflow the
    // shift into nonsense; the `min` then saturates it at the TTL, which is the right answer
    // anyway because waiting longer than the TTL can never help.
    let shift = consecutive.saturating_sub(1).min(32);
    let secs = BASE_SECS
        .saturating_mul(1u64 << shift)
        .min(crate::sync_auth::DEFAULT_TTL_MS as u64 / 1_000);
    Duration::from_secs(secs)
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
fn sync_once<R: Runtime>(app: &AppHandle<R>, gen: u64) -> Result<(), String> {
    // Snapshot what we need under the lock (clone the root; the clone zeroizes on drop).
    let (root, account_id, device_seed) = {
        let st = app.state::<SyncState>();
        let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        if !g.enabled {
            return Err("sync is not enabled".into());
        }
        match (&g.root, &g.device_seed) {
            (Some(r), Some(s)) => (r.clone(), g.account_id.clone(), Zeroizing::new(**s)),
            _ => return Err("sync is locked".into()),
        }
    };
    let server = crate::settings::sync_server_url(app);
    if server.trim().is_empty() {
        return Err("no sync server configured (set it in Settings → Sync)".into());
    }
    let base = validated_base_for(app, &server)?;

    // Clone app handle for use in threads (we'll clone it further inside each closure)
    let app_clone = app.clone();

    // Define the three sync operations - clone values separately for each closure
    let array_stores_op = {
        let root = root.clone();
        let account_id = account_id.clone();
        let device_seed = device_seed.clone();
        let base = base.clone();
        let app_clone = app_clone.clone();
        move || -> Result<Vec<(String, Vec<String>)>, String> {
            let app = app_clone.clone(); // Clone the app handle for this thread

            let mut changed_arrays = Vec::new();
            // Per-namespace tolerance. This loop used `?`, so the FIRST failure
            // stranded every namespace after it: one 413 on `favorites` meant
            // `allowlist` (which drives the ad-block engine) and `saved` silently
            // stopped syncing too. The outer `sync_once` handler already isolates
            // namespaces this way; this intra-thread loop did not.
            let mut first_err: Option<String> = None;
            for &ns in sync_stores::SYNCABLE {
                let dk = crypto::data_key(&root, ns);
                match sync_ns(
                    &app,
                    &base,
                    ns,
                    &dk,
                    &account_id,
                    &device_seed,
                    gen,
                    || sync_stores::read_all(&app, ns),
                    |remote| sync_stores::merge_into(&app, ns, remote),
                ) {
                    Ok(changed) => changed_arrays.push((ns.to_string(), changed)),
                    Err(e) => {
                        eprintln!("[aegis-sync] namespace {ns} failed: {e}");
                        if first_err.is_none() {
                            first_err = Some(format!("{ns}: {e}"));
                        }
                    }
                }
            }
            // A partial sync is far better than none, so only surface an error
            // when NOTHING synced — otherwise the caller would report the whole
            // pass as failed and the successful namespaces' changes would be lost.
            if changed_arrays.is_empty() {
                return Err(first_err.unwrap_or_else(|| "no namespaces synced".into()));
            }
            Ok(changed_arrays)
        }
    };

    let settings_op = {
        let root = root.clone();
        let account_id = account_id.clone();
        let device_seed = device_seed.clone();
        let base = base.clone();
        let app_clone = app_clone.clone();
        move || -> Result<(String, Vec<String>), String> {
            let app = app_clone.clone(); // Clone the app handle for this thread

            let dk = crypto::data_key(&root, "settings");
            let changed = sync_ns(
                &app,
                &base,
                "settings",
                &dk,
                &account_id,
                &device_seed,
                gen,
                || crate::settings::sync_records(&app),
                |remote| crate::settings::merge_remote(&app, remote),
            )?;
            Ok(("settings".to_string(), changed))
        }
    };

    let custom_filters_op = {
        let root = root.clone();
        let account_id = account_id.clone();
        let device_seed = device_seed.clone();
        let base = base.clone();
        let app_clone = app_clone.clone();
        move || -> Result<(String, Vec<String>), String> {
            let app = app_clone.clone(); // Clone the app handle for this thread

            let dk = crypto::data_key(&root, "customFilters");
            let changed = sync_ns(
                &app,
                &base,
                "customFilters",
                &dk,
                &account_id,
                &device_seed,
                gen,
                || vec![crate::customfilters::sync_record(&app)],
                |remote| {
                    let mut ch = Vec::new();
                    for r in remote {
                        if crate::customfilters::merge_remote(&app, r) {
                            if let Some(u) = r.get("uuid").and_then(Value::as_str) {
                                ch.push(u.to_string());
                            }
                        }
                    }
                    ch
                },
            )?;
            Ok(("customFilters".to_string(), changed))
        }
    };

    // The vault is a FOURTH, independent operation, and deliberately not one of the array
    // stores: its records are sealed under a master-password key, so the generic
    // pull→merge→push shape does not apply (see `sync_vault`'s module docs). It also runs even
    // when the vault is locked, because the salt-publication half of the handshake must still
    // reach the account for a device that is waiting to adopt it.
    let vault_op = {
        let root = root.clone();
        let account_id = account_id.clone();
        let device_seed = device_seed.clone();
        let base = base.clone();
        let app_clone = app_clone.clone();
        move || -> Result<(Vec<String>, Vec<String>), String> {
            let app = app_clone.clone();
            crate::sync_vault::sync_vault_once(&app, &base, &account_id, &device_seed, &root, gen)
        }
    };

    // Execute the four operations in parallel
    let array_handles = std::thread::spawn(array_stores_op);
    let settings_handle = std::thread::spawn(settings_op);
    let custom_filters_handle = std::thread::spawn(custom_filters_op);
    let vault_handle = std::thread::spawn(vault_op);

    // Collect results
    let array_results = array_handles
        .join()
        .map_err(|_| "Array stores thread panicked".to_string())?;
    let settings_result = settings_handle
        .join()
        .map_err(|_| "Settings thread panicked".to_string())?;
    let custom_filters_result = custom_filters_handle
        .join()
        .map_err(|_| "Custom filters thread panicked".to_string())?;
    let vault_result = vault_handle
        .join()
        .map_err(|_| "Vault thread panicked".to_string())?;

    // Emit changed events.
    //
    // Every merge thread has ALREADY run and written its store by this point, so a failure in
    // one of them must not suppress the events for the others — the renderer would otherwise
    // keep showing pre-merge data for stores that were in fact updated, with no way to notice.
    // Emit whatever succeeded, then surface the first error (if any) so the caller still learns
    // that this pass was incomplete.
    let mut first_err: Option<String> = None;

    match array_results {
        Ok(results) => {
            for (ns, changed) in results {
                emit_changed(app, &ns, &changed);
            }
        }
        Err(e) => first_err = Some(e),
    }
    match settings_result {
        Ok((ns, changed)) => emit_changed(app, &ns, &changed),
        Err(e) if first_err.is_none() => first_err = Some(e),
        Err(_) => {}
    }
    match custom_filters_result {
        Ok((ns, changed)) => emit_changed(app, &ns, &changed),
        Err(e) if first_err.is_none() => first_err = Some(e),
        Err(_) => {}
    }
    // The vault reports `(changed, quarantined)`. Quarantined records are ones a peer sent that
    // did not authenticate under this device's vault key — they are dropped, never written, and
    // logged by `vault::merge_remote`. Surfacing the count as an event (rather than an error) is
    // deliberate: an unauthenticated write is a rejected attack, not a sync failure, and the
    // user's other namespaces must not be reported as failed because of it.
    match vault_result {
        Ok((changed, quarantined)) => {
            if !changed.is_empty() {
                crate::emit_event(
                    app,
                    "sync.changed",
                    json!({ "namespace": "pwvault", "changedUuids": changed }),
                );
            }
            if !quarantined.is_empty() {
                crate::emit_event(
                    app,
                    "sync.vaultQuarantined",
                    json!({ "count": quarantined.len(), "uuids": quarantined }),
                );
            }
        }
        Err(e) if first_err.is_none() => first_err = Some(e),
        Err(_) => {}
    }

    match first_err {
        Some(e) => Err(e),
        None => Ok(()),
    }
}

fn emit_changed<R: Runtime>(app: &AppHandle<R>, ns: &str, changed: &[String]) {
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
///
/// The pull PAGE-LOOPS (see `MAX_PULL_PAGES`): one `GET` only ever returns the server's
/// page-sized slice of a namespace, so a namespace larger than that cap is not fully pulled
/// without following the `next` cursor.
#[allow(clippy::too_many_arguments)]
/// Records per `POST /v1/records` request.
///
/// The server rejects a body with more than `MAX_RECORDS_PER_REQUEST` (1000) records, and
/// this client used to push a whole namespace in ONE un-chunked request. So a user with
/// 1001 favourites could **never push again**: the 413 was permanent (raising the server
/// cap or splitting the store were the only escapes) and silent — the sole symptom was
/// `lastError: "HTTP 413"` in the sync panel. 500 leaves headroom so a future server-side
/// cap reduction does not immediately re-break it.
const PUSH_CHUNK: usize = 500;

/// Split one namespace's sealed records into request-sized batches.
///
/// Pure and `pub(crate)` so the property that actually fixes the bug — *no single request
/// ever exceeds the cap* — is unit-testable without standing up an HTTP server (there is
/// no mock transport in this module, which is why `sync_ns` itself has no test).
///
/// An empty namespace yields exactly ONE empty batch: the pre-chunking code always issued
/// a POST per namespace, and dropping that would silently stop proving the device is alive.
pub(crate) fn push_batches(wire: &[Value]) -> Vec<&[Value]> {
    if wire.is_empty() {
        return vec![&[]];
    }
    wire.chunks(PUSH_CHUNK).collect()
}

/// Maximum number of `GET /v1/records` pages one `sync_ns` will fetch for a single namespace.
///
/// The server caps one response at `MAX_RESPONSE_RECORDS` and hands back a `next` cursor when
/// there is more, so a namespace larger than that cap is only fully pullable by following the
/// cursor. This bound is what stops a hostile or buggy server from spinning the client forever
/// by always returning a cursor: on exhaustion we keep what we pulled (a partial pull beats
/// none — the next sync run resumes from the start and converges) and warn.
const MAX_PULL_PAGES: usize = 64;

/// Build the `GET /v1/records` URL for one page of a namespace pull.
///
/// `cursor` is the opaque value the SERVER handed back in the previous page's `next`. It is
/// server-supplied text, so it is percent-encoded as a query value: a raw `&`, `#` or `=` in it
/// would otherwise truncate or re-parse the query string and silently fetch the wrong page.
/// `ns` is not encoded because it is a fixed internal string (never user input), matching the
/// pre-existing call.
pub(crate) fn pull_url(base: &str, ns: &str, cursor: Option<&str>) -> String {
    let Some(c) = cursor else {
        return format!("{base}/v1/records?ns={ns}");
    };
    // `form_urlencoded` rather than a hand-rolled `replace('&', "%26")`: a cursor is
    // server-supplied, so it can contain `&`, `#`, `+` or `%`, and getting any of them wrong
    // either truncates the query or silently re-encodes to a DIFFERENT cursor value.
    let enc = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("cursor", c)
        .finish();
    format!("{base}/v1/records?ns={ns}&{enc}")
}

/// The cursor for the next page, or `None` when this was the last page.
///
/// `next` is absent on a server that does not paginate (so this client stays compatible with an
/// older sync-server), `null` on the final page, and a non-empty string otherwise. An EMPTY
/// string is treated as the end too: a server that echoed `""` back would otherwise re-request
/// page 1 forever, since the server's own retain is `uuid > cursor` and every uuid is `> ""`.
/// A non-string `next` is likewise ignored rather than stringified into a bogus cursor.
pub(crate) fn next_cursor(page: &Value) -> Option<String> {
    page.get("next")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
}

/// Decide whether a completed pull of one namespace should be reported as a success.
///
/// `served` is how many wire records the server returned for this namespace across every page,
/// and `opened` how many of them decrypted. The distinction matters because the two failure
/// modes are otherwise indistinguishable to the caller: a namespace with nothing to pull returns
/// `Ok(())`, and a namespace where EVERY record failed to open used to return `Ok(())` too — so
/// `sync_ns` reported success, the engine cleared the namespace's dirty flag, and the UI showed
/// a clean sync while not one record was readable.
///
/// The overwhelmingly likely cause is a data key that no longer matches the key the records were
/// sealed under (a re-key, a restored backup, an account restored on a second device before its
/// key arrived). Continuing is what makes that destructive: `sync_ns` pushes the local records up
/// afterwards, sealing them under the key it thinks is right, and then clears the dirty flag —
/// so the namespace is left with records that NO device can open, and nothing reports an error.
///
/// Only a TOTAL failure is an error. A partial one is tolerated on purpose: a single corrupt or
/// legacy-keyed record must not block the rest of a namespace from syncing, and
/// `open_wire`'s own reason (logged per record) is the diagnostic for those.
pub(crate) fn pull_verdict(ns: &str, served: usize, opened: usize) -> Result<(), String> {
    if served > 0 && opened == 0 {
        return Err(format!(
            "namespace `{ns}`: all {served} record(s) the sync server returned failed to \
             decrypt. This is almost always a data-key mismatch (a re-key, a restored backup, or \
             an account restored before its key arrived). Nothing was merged and nothing was \
             uploaded — fix the key and sync again."
        ));
    }
    Ok(())
}

// The nine parameters are genuinely independent (transport base, namespace, its derived
// key, the two auth inputs, the cancellation generation, and the two store seams) and
// every one is threaded straight into a helper that takes it alone. Bundling them into
// a context struct would move the arity problem rather than solve it while making the
// single call site harder to read. Clippy's 7-arg default is a style rule, not a
// correctness one, and CI runs `-D warnings`, so the lint is allowed explicitly here
// rather than left to fail the build.
// `read_local`/`merge` are the store seams: they let the array stores and the vault share
// this transport without either knowing about the other's storage.
#[allow(clippy::too_many_arguments)]
pub(crate) fn sync_ns<R: Runtime>(
    app: &AppHandle<R>,
    base: &str,
    ns: &str,
    data_key: &[u8; 32],
    account_id: &str,
    device_seed: &[u8; 32],
    gen: u64,
    read_local: impl Fn() -> Vec<Value>,
    merge: impl Fn(&[Value]) -> Vec<String>,
) -> Result<Vec<String>, String> {
    // Page through the namespace. The server caps one response at MAX_RESPONSE_RECORDS and hands
    // back a `next` cursor when there is more, so a namespace larger than that cap is only fully
    // pullable by following it. The bound is what stops a server that always answers with a
    // cursor from spinning us forever; see MAX_PULL_PAGES.
    let mut decrypted: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    // `served` counts what the SERVER returned and `decrypted.len()` what we could actually open,
    // so the two "nothing to do" shapes stay distinguishable: an empty namespace and a namespace
    // in which nothing opens both used to look like "nothing changed".
    let mut served: usize = 0;
    for page_no in 0..MAX_PULL_PAGES {
        // A fresh token (fresh nonce) per HTTP request: the server enforces single-use nonces for
        // replay defense (sync-server `verify_auth`), so reusing one token across the GETs (or
        // the POSTs) below would get the later request rejected. Minting is cheap (one Ed25519
        // sign).
        let pulled = http(
            "GET",
            pull_url(base, ns, cursor.as_deref()),
            auth_header(account_id, device_seed)?,
            None,
            SYNC_TIMEOUT_SECS,
        )?;
        if let Some(arr) = pulled.get("records").and_then(Value::as_array) {
            served += arr.len();
            for w in arr {
                match open_wire(data_key, ns, w) {
                    Ok(rec) => decrypted.push(rec),
                    Err(e) => eprintln!("[aegis-sync] skip undecryptable {ns} record: {e}"),
                }
            }
        }
        match next_cursor(&pulled) {
            Some(next) => cursor = Some(next),
            None => break,
        }
        if page_no + 1 == MAX_PULL_PAGES {
            eprintln!(
                "[aegis-sync] {ns}: stopped after {MAX_PULL_PAGES} pages without reaching the \
                 last one; keeping what was pulled rather than spinning or discarding it"
            );
        }
    }
    // BEFORE the merge and, critically, before the push below. This used to return `Ok(())`
    // indistinguishably from an empty namespace, so the engine cleared the namespace's dirty flag
    // and the UI showed a clean sync while nothing was readable — and then the push sealed the
    // local records under a key that does not open them, leaving the namespace unreadable on
    // every device. See `pull_verdict` for why a PARTIAL failure is still tolerated.
    pull_verdict(ns, served, decrypted.len())?;
    let changed = merge(&decrypted);
    // Re-check immediately before the push: a `sync.disable` during the pull must not be
    // followed by an upload the user explicitly asked us to stop. The merge above is local
    // and already durable, so returning here loses nothing that wasn't already saved.
    if cancelled(app, gen) {
        return Ok(changed);
    }
    let local = read_local();
    let mut wire = Vec::with_capacity(local.len());
    for r in &local {
        match seal_wire(data_key, ns, r) {
            Ok(w) => wire.push(w),
            Err(e) => eprintln!("[aegis-sync] skip unsealable {ns} record: {e}"),
        }
    }
    // Chunk the push — see `push_batches` for why the 413 cliff was permanent.
    let batches = push_batches(&wire);
    for (i, batch) in batches.iter().enumerate() {
        if cancelled(app, gen) {
            return Ok(changed);
        }
        http(
            "POST",
            format!("{base}/v1/records"),
            auth_header(account_id, device_seed)?,
            Some(json!({ "ns": ns, "records": batch })),
            SYNC_TIMEOUT_SECS,
        )
        .map_err(|e| format!("{ns}: push batch {}/{} failed: {e}", i + 1, batches.len()))?;
    }
    // Reap tombstones that are older than the GC horizon. This is the ONLY safe place to do
    // it, and the placement is the whole point: the pull's `merge` above has already landed
    // durably, and every push batch above returned `Ok` (the `?` would have bailed out
    // otherwise). So any tombstone still sitting locally is one the server has now seen. Run
    // it on the pull path instead and a namespace whose PUSH failed would have its fresh,
    // never-uploaded delete silently discarded — losing the delete permanently and letting
    // the record reappear from a peer. Scoped to the array stores, which are the ones whose
    // tombstones ride `merge_into`; the settings/vault projections have their own lifecycle.
    if sync_stores::SYNCABLE.contains(&ns) {
        let reaped = sync_stores::gc_tombstones(app, ns, crate::jsonstore::now_ms());
        if reaped > 0 {
            eprintln!("[aegis-sync] reaped {reaped} expired {ns} tombstone(s)");
        }
    }
    Ok(changed)
}

/// Register this device with the server (best-effort; needs a configured server). Carries
/// an ACCOUNT-ROOT signature over (accountId, deviceId): the account id is the account's
/// public key, so the server verifies this proves possession of the root — without it,
/// anyone who learned the public account id could self-register a rogue device.
fn register_device<R: Runtime>(
    app: &AppHandle<R>,
    account_id: &str,
    device_id: &str,
    device_seed: &[u8; 32],
    root: &RootSecret,
) {
    let server = crate::settings::sync_server_url(app);
    if server.trim().is_empty() {
        return;
    }
    // Best-effort: a URL that fails validation skips device registration rather than
    // sending the device token in the clear. The sync pass surfaces the error to the user.
    let base = match validated_base_for(app, &server) {
        Ok(b) => b,
        Err(e) => {
            eprintln!("[aegis-sync] skipping device registration: {e}");
            return;
        }
    };
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
            SYNC_TIMEOUT_SECS,
        );
    }
}

/// Bring sync up for `root` (new or restored): derive identity, persist the seed, register,
/// set state. Returns the chosen vault backing.
fn enable_with_root<R: Runtime>(app: &AppHandle<R>, root: RootSecret, passphrase: Option<&str>) {
    set_disabled_flag(app, false); // re-enabling clears any prior durable "disabled" marker
    let salt = sync_keystore::device_local_salt(app);
    let device_seed = crypto::device_signing_seed(&root, &salt);
    let device_id = sync_auth::device_id_for(&device_seed);
    let account_id = crypto::account_id(&root);
    let backing = sync_keystore::store_root(app, &root, passphrase);

    {
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        g.root = Some(root.clone());
        g.device_seed = Some(device_seed.clone()); // already Zeroizing (crypto::device_signing_seed)
        g.enabled = true;
        g.account_id = account_id.clone();
        g.device_id = device_id.clone();
        g.backing = backing.as_str().to_string();
        g.status = Status::Idle;
        g.last_error.clear();
    }
    emit_state(app);
    let app_bg = app.clone();
    let root_bg = root;
    let account_id_bg = account_id;
    let device_id_bg = device_id;
    let device_seed_bg = Zeroizing::new(*device_seed);
    std::thread::spawn(move || {
        register_device(
            &app_bg,
            &account_id_bg,
            &device_id_bg,
            &device_seed_bg,
            &root_bg,
        );
        nudge(&app_bg); // kick off an initial sync if a server is configured
    });
}

/// Persist the root and unlock sync before returning to the renderer. Device registration
/// and the first sync still run in the background, but the seed is durable once this returns.
fn unlock_with_root<R: Runtime>(app: &AppHandle<R>, root: RootSecret, passphrase: Option<String>) {
    {
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        g.status = Status::Syncing;
        g.last_error.clear();
    }
    emit_state(app);
    enable_with_root(app, root, passphrase.as_deref());
}

/// Trigger a background sync pass (no-op if disabled). Debounced only by the engine status.
pub fn nudge<R: Runtime>(app: &AppHandle<R>) {
    let gen;
    {
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        if !g.enabled || g.status == Status::Syncing {
            return;
        }
        g.status = Status::Syncing;
        gen = g.generation;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        // Panic-safe: a panic in sync_once must reset status to Error, not leave it stuck
        // on "syncing" forever (SyncState's lock isn't held across sync_once, so no poison).
        let result =
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sync_once(&app, gen))) {
                Ok(r) => r,
                Err(_) => Err("sync task panicked".to_string()),
            };
        let st = app.state::<SyncState>();
        let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
        // A disable/enable that landed while this pass was in flight owns the status now —
        // don't stomp `Disabled` (or a fresh `Syncing`) with this pass's outcome.
        if g.generation != gen {
            drop(g);
            emit_state(&app);
            return;
        }
        match result {
            Ok(()) => {
                g.status = Status::Idle;
                g.last_sync_ms = crate::jsonstore::now_ms();
                g.last_error.clear();
                // The server is answering again, so whatever window it was enforcing has cleared.
                // Forgetting the counter is what makes the next rate-limit start from the short
                // end of the curve again instead of inheriting an hours-old streak.
                g.rate_limit_until_ms = 0;
                g.consecutive_rate_limits = 0;
            }
            Err(e) => {
                g.status = Status::Error;
                if is_rate_limit_error(&e) {
                    // Bump BEFORE computing, so the first refusal waits the base delay rather
                    // than the doubled one.
                    g.consecutive_rate_limits = g.consecutive_rate_limits.saturating_add(1);
                    let wait = rate_limit_backoff(g.consecutive_rate_limits);
                    g.rate_limit_until_ms = crate::jsonstore::now_ms()
                        .saturating_add(i64::try_from(wait.as_millis()).unwrap_or(i64::MAX));
                    eprintln!(
                        "[aegis-sync] rate limited ({} consecutive); backing off {}s",
                        g.consecutive_rate_limits,
                        wait.as_secs()
                    );
                }
                g.last_error = e;
            }
        }
        drop(g);
        emit_state(&app);
    });
}

/// How long the periodic thread should wait before the next pass, given the configured
/// interval AND the rate-limit backoff window: the periodic thread must not retry before
/// `rate_limit_until_ms`, because a retry inside that window is guaranteed to be refused
/// and each attempt costs a full TLS round trip and an Ed25519 signature verification.
///
/// `None` means "poll the setting again instead of passing".
///
/// `syncIntervalSec == 0` is the documented way to switch periodic sync off, and it used to
/// be a hot spin: `sleep(0)` returns immediately, `nudge` only short-circuits while a pass is
/// already `Syncing`, and the gap between passes is milliseconds — so the app free-ran
/// pull → merge → push forever, burning CPU and hammering the server. It is reachable from an
/// imported `data.export` bundle as well as the settings UI, so it is not merely a footgun.
///
/// The backoff can only ever *lengthen* the wait, never shorten it, and it never resurrects a
/// pass the user switched off: `secs == 0` still returns `None`. `rate_limit_until_ms <= now_ms`
/// means "no backoff in force" and leaves the configured interval untouched.
pub(crate) fn next_periodic_delay(
    secs: u64,
    now_ms: i64,
    rate_limit_until_ms: i64,
) -> Option<Duration> {
    let base = periodic_base(secs)?;
    let remaining = rate_limit_until_ms.saturating_sub(now_ms);
    Some(if remaining > base.as_millis() as i64 {
        Duration::from_millis(remaining as u64)
    } else {
        base
    })
}

fn periodic_base(secs: u64) -> Option<Duration> {
    if secs == 0 {
        None
    } else {
        Some(Duration::from_secs(secs))
    }
}

/// How often the periodic thread re-reads the interval while periodic sync is switched off.
/// Bounded so re-enabling it takes effect promptly without the thread spinning.
const PERIODIC_OFF_POLL_SECS: u64 = 30;

/// At boot: spawn the periodic background sync, then (unless the user durably disabled
/// sync) auto-unlock from the OS keychain and enable.
pub fn start<R: Runtime>(app: &AppHandle<R>) {
    // Low-frequency periodic sync so peers converge even without local edits. A no-op while
    // disabled; debounced by the Syncing guard. One thread for the process lifetime.
    {
        let app = app.clone();
        std::thread::spawn(move || loop {
            // Read the backoff under the lock here, not the configured interval alone, so a
            // 429 seen by any pass (periodic or user-initiated) actually delays the next one.
            let rate_limit_until_ms = {
                let st = app.state::<SyncState>();
                let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                g.rate_limit_until_ms
            };
            match next_periodic_delay(
                crate::settings::sync_interval_sec(&app),
                crate::jsonstore::now_ms(),
                rate_limit_until_ms,
            ) {
                Some(d) => {
                    std::thread::sleep(d);
                    nudge(&app);
                }
                // Periodic sync is switched off. Park instead of passing — but keep reading the
                // setting so switching it back on resumes without a restart.
                None => std::thread::sleep(Duration::from_secs(PERIODIC_OFF_POLL_SECS)),
            }
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

/// Validate a user-entered sync server URL and return it with trailing slashes trimmed.
///
/// Every sync request carries a real per-device `Authorization` header (an Ed25519-signed
/// credential derived from the sync root), and the request/response bodies are the user's
/// settings, history, bookmarks, subscriptions and custom filters. Plaintext transport is
/// therefore only acceptable for a loopback server the user runs on their own machine, where
/// the bytes never leave the host. Everything else must be https — unless the user has
/// explicitly set `syncAllowInsecure`, which waives the rule for a plaintext remote server.
///
/// `allow_insecure` is that setting, read at the point of use by the callers. What the waiver
/// does and does not buy, stated plainly: the record bodies are sealed under the sync root, so
/// their *contents* stay unreadable, and a forged body fails the AEAD check. What a network
/// attacker still gets is everything outside that envelope — which endpoints you talk to and
/// when (full traffic analysis), the ability to drop, delay or reorder records (so deletions
/// and edits can be selectively withheld or resurrected), and the ability to capture a
/// `Authorization` header and replay it (the replay set is in-memory, so a restart clears it
/// but a live process does not).
///
/// This is enforced here — at the point of use — rather than only when the setting is
/// written, because `syncServerUrl` is a free-text setting that `settings.set` and an imported
/// `data.export` bundle can both write. Those two write paths are the equivalent of the user
/// typing the box: the same trust, not a bypass around it.
fn validated_base(raw: &str, allow_insecure: bool) -> Result<String, String> {
    let base = raw.trim().trim_end_matches('/');
    if base.is_empty() {
        return Err("sync server URL is not configured".into());
    }
    let lower = base.to_ascii_lowercase();
    if lower.starts_with("https://") {
        return Ok(base.to_string());
    }
    if let Some(rest) = lower.strip_prefix("http://") {
        // Host = authority up to the first '/', '?' or '#', minus any userinfo and port.
        let authority = rest.split(['/', '?', '#']).next().unwrap_or("");
        let authority = authority
            .rsplit_once('@')
            .map(|(_, h)| h)
            .unwrap_or(authority);
        // Split off the port. A bracketed IPv6 literal is `[::1]:8787`, where the port colon
        // is the one AFTER the closing bracket — splitting on the first colon would cut a
        // hole in the middle of the address and reject a legitimate loopback server.
        let host = if authority.starts_with('[') {
            // `[::1]:8787` — the port colon is the one after the closing bracket, so slice
            // the literal out by its own brackets rather than splitting on ':'.
            authority
                .find(']')
                .map(|close| &authority[1..close])
                .unwrap_or("")
        } else {
            authority.split(':').next().unwrap_or("")
        };
        let is_loopback = host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<std::net::IpAddr>()
                .map(|ip| ip.is_loopback())
                .unwrap_or(false);
        if is_loopback {
            return Ok(base.to_string());
        }
        if allow_insecure {
            return Ok(base.to_string());
        }
    }
    Err("sync server must be https:// — plain http:// is only allowed for localhost (or when you allow an unencrypted server in Settings → Sync)".into())
}

/// Validate `syncServerUrl` as it is configured, honoring the `syncAllowInsecure` waiver.
fn validated_base_for<R: Runtime>(app: &AppHandle<R>, raw: &str) -> Result<String, String> {
    validated_base(raw, crate::settings::sync_allow_insecure(app))
}

/// Build the unauthenticated health-probe URL from a user-entered server URL. `None` for an
/// empty/whitespace entry. Trims surrounding whitespace and any trailing slashes. The scheme
/// is validated first so the probe can't be pointed at a plaintext remote host.
fn healthz_url(raw: &str, allow_insecure: bool) -> Option<String> {
    let base = validated_base(raw, allow_insecure).ok()?;
    Some(format!("{base}/healthz"))
}

/// Probe `{url}/healthz` (unauthenticated) with a short timeout. Returns a STRUCTURED result —
/// a failed probe is a value, not a thrown IPC error. Uses the spawn-thread + reqwest::blocking
/// pattern (blocking client can't run in the command's async context); 8s keeps it interactive.
fn test_connection<R: Runtime>(app: &AppHandle<R>, raw_url: &str) -> Value {
    let allow_insecure = crate::settings::sync_allow_insecure(app);
    let Some(target) = healthz_url(raw_url, allow_insecure) else {
        // Distinguish "you left it blank" from "that URL would send your device token in
        // the clear", so the user learns *why* rather than just seeing a failed probe.
        return match validated_base(raw_url, allow_insecure) {
            Err(e) => json!({ "ok": false, "error": e }),
            Ok(_) => json!({ "ok": false, "error": "Enter a server URL first" }),
        };
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

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
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
            let passphrase = payload
                .get("passphrase")
                .and_then(Value::as_str)
                .map(String::from);
            unlock_with_root(app, root, passphrase);
            // Show-once: the phrase is returned here and never retrievable without confirm.
            Some(Ok(json!({ "recoveryPhrase": phrase })))
        }

        "sync.enableFromPhrase" => {
            let phrase = payload.get("phrase").and_then(Value::as_str).unwrap_or("");
            let root = match crypto::phrase_to_root(phrase) {
                Ok(r) => r,
                Err(e) => return Some(Err(e)),
            };
            let passphrase = payload
                .get("passphrase")
                .and_then(Value::as_str)
                .map(String::from);
            unlock_with_root(app, root, passphrase);
            Some(Ok(state_json(app)))
        }

        "sync.unlock" => {
            let passphrase = payload
                .get("passphrase")
                .and_then(Value::as_str)
                .unwrap_or("");
            if passphrase.trim().is_empty() {
                return Some(Err("passphrase required".into()));
            }
            let root = match sync_keystore::unlock_with_passphrase(app, passphrase) {
                Ok(root) => root,
                Err(e) => return Some(Err(e)),
            };
            unlock_with_root(app, root, Some(passphrase.to_string()));
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
                let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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
                st.0.lock().unwrap_or_else(|e| e.into_inner()).backing = "none".into();
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
            Some(Ok(test_connection(app, url)))
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
            let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
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
                let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                match &g.device_seed {
                    Some(s) => (g.account_id.clone(), Zeroizing::new(**s)),
                    None => return Some(Ok(json!([]))),
                }
            };
            let server = crate::settings::sync_server_url(app);
            if server.trim().is_empty() {
                return Some(Ok(json!([])));
            }
            let base = match validated_base_for(app, &server) {
                Ok(b) => b,
                Err(e) => return Some(Err(e)),
            };
            let auth = match auth_header(&account_id, &device_seed) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            match http(
                "GET",
                format!("{base}/v1/devices"),
                auth,
                None,
                INTERACTIVE_TIMEOUT_SECS,
            ) {
                Ok(v) => {
                    let this = app
                        .state::<SyncState>()
                        .0
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .device_id
                        .clone();
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
                let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                match &g.device_seed {
                    Some(s) => (g.account_id.clone(), Zeroizing::new(**s)),
                    None => return Some(Err("sync is locked".into())),
                }
            };
            let server = crate::settings::sync_server_url(app);
            let base = match validated_base_for(app, &server) {
                Ok(b) => b,
                Err(e) => return Some(Err(e)),
            };
            let auth = match auth_header(&account_id, &device_seed) {
                Ok(a) => a,
                Err(e) => return Some(Err(e)),
            };
            let result = http(
                "POST",
                format!("{base}/v1/devices/remove"),
                auth,
                Some(json!({ "deviceId": device_id })),
                INTERACTIVE_TIMEOUT_SECS,
            );
            if let Err(e) = result {
                return Some(Err(format!("failed to remove device: {e}")));
            }
            // Return the refreshed list.
            dispatch(app, "sync.listDevices", &Value::Null)
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A restart must bring the Settings → Sync panel back ENABLED. `boot_restore` is the
    /// body of `start()` minus the perpetual periodic-sync thread (a test must not leak one).
    fn boot_restore<R: Runtime>(app: &AppHandle<R>) {
        if is_disabled_flag(app) {
            return;
        }
        if !sync_keystore::has_stored_root(app) {
            return;
        }
        if let Some(root) = sync_keystore::load_root(app, None) {
            enable_with_root(app, root, None);
        }
    }

    /// The cleartext `hlc` on a wire record is AEAD-associated data, so a peer that rewrites it
    /// invalidates the tag and the record can never be opened again. The reference server used to
    /// do exactly that — bumping `hlc` to break a cross-record HLC tie without re-sealing `ct` —
    /// which permanently bricked every record it touched (and, because the retry then lost the
    /// per-uuid LWW gate as stale, made them unwritable too). Pin the client half of that
    /// contract: a rewritten `hlc` must be REJECTED, never silently accepted.
    /// The core of Wave 3(8): a pull in which the server served records and NOT ONE of them
    /// decrypted must be an ERROR, not an empty success. Otherwise `sync_ns` reports success,
    /// the engine clears the namespace's dirty flag and the UI shows a clean sync, while the
    /// namespace is in fact unreadable — and because `sync_ns` pushes local records afterwards,
    /// it seals them under a key that does not match and leaves the namespace unreadable on
    /// every device.
    #[test]
    fn a_pull_where_nothing_decrypts_is_an_error_not_an_empty_success() {
        let e = super::pull_verdict("favorites", 12, 0).expect_err(
            "12 records served and 0 opened is a total decryption failure, which must surface \
             as an error rather than an empty success",
        );
        assert!(
            e.contains("favorites"),
            "the error must name the namespace the user can act on: {e}"
        );
    }

    /// The inverse, and the case a careless fix would break: an EMPTY namespace is the normal
    /// "nothing to pull" case and must stay a success, or every fresh namespace would report an
    /// error forever.
    #[test]
    fn a_pull_that_served_nothing_is_a_success() {
        super::pull_verdict("favorites", 0, 0).expect("an empty namespace is not a failure");
    }

    /// A PARTIAL failure is tolerated on purpose — one corrupt or legacy-keyed record must not
    /// block the rest of a namespace from syncing, and `open_wire`'s per-record log line is the
    /// diagnostic for it. This is the guard against an over-broad fix ("fail on any error").
    #[test]
    fn a_pull_where_some_records_open_is_still_a_success() {
        super::pull_verdict("history", 12, 11).expect("11 of 12 opened is a partial success");
        super::pull_verdict("history", 1, 1).expect("everything opened is a success");
    }

    #[test]
    fn open_wire_rejects_a_record_whose_hlc_was_rewritten() {
        let key = [7u8; 32];
        let rec = json!({
            "uuid": "u1",
            "name": "Fav",
            "hlc": { "wall_ms": 1000, "counter": 0, "node": "n1" },
        });
        let sealed = seal_wire(&key, "favorites", &rec).unwrap();

        let mut tampered = sealed.clone();
        tampered["hlc"] = json!({ "wall_ms": 9_999, "counter": 0, "node": "n1" });
        assert!(
            open_wire(&key, "favorites", &tampered).is_err(),
            "a rewritten hlc must fail the AEAD check, not open"
        );

        // Same record untouched still opens — the guard must not be vacuously true.
        assert!(open_wire(&key, "favorites", &sealed).is_ok());
    }

    /// The server's tie-break now lands in a SEPARATE `ord` field so `hlc` stays
    /// authenticating. The client must adopt `ord` as the record's HLC, otherwise its own merge
    /// would re-derive an arbitrary local tie-break and disagree with the server's total order.
    #[test]
    fn open_wire_adopts_the_servers_ordering_stamp() {
        let key = [7u8; 32];
        let rec = json!({
            "uuid": "u1",
            "name": "Fav",
            "hlc": { "wall_ms": 1000, "counter": 0, "node": "n1" },
        });
        let mut sealed = seal_wire(&key, "favorites", &rec).unwrap();
        let ord = json!({ "wall_ms": 1000, "counter": 3, "node": "n1" });
        sealed["ord"] = ord.clone();

        let opened = open_wire(&key, "favorites", &sealed).unwrap();
        assert_eq!(
            opened["hlc"], ord,
            "the server's ordering stamp must win so our merge matches its order"
        );
        // The rest of the record is untouched by the adoption.
        assert_eq!(opened["name"], json!("Fav"));
        assert_eq!(opened["uuid"], json!("u1"));
    }

    /// `ord` is the ONE field on a wire record the server authors rather than merely relays, and
    /// `open_wire` adopts it as the record's HLC. That makes it the one place a hostile party can
    /// write a stamp the client cannot authenticate: `wall_ms: i64::MAX` is a namespace-wide,
    /// permanent poison — every pulled record lands beyond the reach of any real clock, so no
    /// later local edit can ever dominate it and the user can never change a favorite, bookmark,
    /// or history row again on any device. It needs a compromised server, or just an on-path
    /// attacker, since `syncAllowInsecure` permits a plain `http://` endpoint.
    ///
    /// The genuine tie-break `ord` exists for is always a *local* ordering concern: the server
    /// bumps a counter it owns, on a record whose wall it did not choose. So requiring the stamp
    /// to be a well-formed HLC and no further ahead than the same `MAX_REMOTE_SKEW_MS` window the
    /// receive path already trusts keeps every real tie-break working while refusing the poison.
    #[test]
    fn open_wire_refuses_a_server_stamp_outside_the_skew_window() {
        let key = [7u8; 32];
        let now = crate::jsonstore::now_ms();
        let hlc = json!({ "wall_ms": now - 1_000, "counter": 4, "node": "n1" });
        let base = seal_wire(
            &key,
            "favorites",
            &json!({ "uuid": "u1", "name": "Fav", "hlc": hlc.clone() }),
        )
        .unwrap();
        let stamped = |ord: Value| {
            let mut w = base.clone();
            w["ord"] = ord;
            open_wire(&key, "favorites", &w).unwrap()
        };

        // Far future: the poison. The wire `hlc` is AEAD-authenticated, so it is the only stamp
        // this record can be trusted to carry — falling back to it is the whole point.
        let poisoned = stamped(json!({ "wall_ms": i64::MAX, "counter": 0, "node": "srv" }));
        assert_eq!(
            poisoned["hlc"], hlc,
            "a server stamp far beyond the skew window must not be adopted; the record keeps \
             its authenticated wire hlc"
        );

        // Not an HLC at all. Adopting this would either fail the later merge or, worse, be
        // stored verbatim and break the next push's `seal_wire`.
        let malformed = stamped(json!({ "wall_ms": "soon", "counter": 9, "node": "srv" }));
        assert_eq!(
            malformed["hlc"], hlc,
            "an `ord` that is not a well-formed HLC must be ignored, not adopted"
        );

        // The genuine article still lands, so a fix that simply refused every `ord` could not
        // pass this. The reject margin here is deliberately COMFORTABLE rather than 1 ms tight:
        // `open_wire` reads the wall clock itself, so the `now` captured above and the `now` its
        // check uses are two different reads, and anything within a millisecond or two of the
        // boundary is decided by how long the test took to get there. That is a property of the
        // measurement, not of the code — an earlier version of this test used `+60_001` and
        // failed roughly one run in six. The exact boundary is asserted in
        // `the_ord_window_boundary_is_exact` below, against the pure function where `now_ms` is
        // an argument and therefore cannot drift.
        for (delta, expect_adopted) in [
            (30_000i64, true),   // inside the accepted window
            (-30_000i64, true),  // in the past: LWW just loses, which is harmless
            (120_000i64, false), // a full minute past the window
        ] {
            let ord = json!({ "wall_ms": now + delta, "counter": 9, "node": "srv" });
            let got = stamped(ord.clone())["hlc"].clone();
            if expect_adopted {
                assert_eq!(
                    got, ord,
                    "a legitimate tie-break at {delta:+}ms must still be adopted"
                );
            } else {
                assert_eq!(
                    got, hlc,
                    "a tie-break {delta:+}ms out is poison, not a tie-break"
                );
            }
        }
    }

    /// The boundary itself, tested where it is deterministic.
    ///
    /// `ord_is_adoptable` takes `now_ms` as an argument, so "exactly at the window edge" is a
    /// fact about the function rather than a race between two reads of the wall clock. Without
    /// this test the boundary is only observable through `open_wire`, which cannot express it.
    #[test]
    fn the_ord_window_boundary_is_exact() {
        let now = 1_700_000_000_000i64;
        let ord = |wall: i64| json!({ "wall_ms": wall, "counter": 1, "node": "srv" });
        let skew = crate::sync_envelope::MAX_REMOTE_SKEW_MS;
        assert!(
            crate::sync_envelope::ord_is_adoptable(&ord(now + skew), now),
            "exactly at the window edge must be accepted — the window is inclusive, and a record \
             sitting exactly on it is a legitimate tie-break"
        );
        assert!(
            !crate::sync_envelope::ord_is_adoptable(&ord(now + skew + 1), now),
            "one millisecond past the window must be refused"
        );
        assert!(
            crate::sync_envelope::ord_is_adoptable(&ord(now - skew - 1), now),
            "a stamp in the past is harmless (LWW just loses) and must stay adoptable, or a \
             device whose clock runs slow could never merge anything"
        );
        // The counter is bounds-checked by the same serde path: an out-of-range `u32` is
        // unopenable by the client, so adopting it writes a stamp nothing can ever read back.
        assert!(
            !crate::sync_envelope::ord_is_adoptable(
                &json!({ "wall_ms": now, "counter": u32::MAX as u64 + 1, "node": "srv" }),
                now
            ),
            "a counter past u32::MAX must be refused — the client cannot deserialize it"
        );
    }

    /// An old server (or a record from before `ord` existed) sends no `ord` at all. The adoption
    /// must be a no-op there, not an error and not a clobber.
    #[test]
    fn open_wire_leaves_hlc_alone_when_the_server_sent_no_ord() {
        let key = [7u8; 32];
        let hlc = json!({ "wall_ms": 1000, "counter": 2, "node": "n1" });
        let sealed = seal_wire(
            &key,
            "favorites",
            &json!({ "uuid": "u1", "name": "Fav", "hlc": hlc.clone() }),
        )
        .unwrap();
        assert!(
            sealed.get("ord").is_none(),
            "seal_wire must not invent an ord"
        );
        assert_eq!(open_wire(&key, "favorites", &sealed).unwrap()["hlc"], hlc);
    }

    #[test]
    fn restart_restores_an_enabled_sync_state() {
        // The whole point of this test is that `store_root` lands in the OS keychain, so
        // it is meaningless where there is no keychain to land in. On a headless CI
        // runner (no `org.freedesktop.secrets` owner) `store_root` correctly falls back
        // to `VaultBacking::None`, the root is in-memory only, the simulated restart
        // wipes it, and `boot_restore` has nothing to restore — a real environment gap,
        // not the regression. Rust has no runtime skip, so return early; `keyring_available`
        // eprintln's the reason so the skip is visible in CI output rather than silent.
        #[cfg(any(target_os = "linux", target_os = "windows", target_os = "macos"))]
        if !crate::sync_keystore::keyring_available() {
            return;
        }
        crate::test_support::with_tmp_app(|app| {
            // 1. First run: the user enables sync from Settings → Sync.
            let enabled = dispatch(app, "sync.enableNew", &Value::Null)
                .unwrap()
                .unwrap();
            assert!(enabled["recoveryPhrase"].as_str().is_some());
            assert_eq!(state_json(app)["enabled"], json!(true));
            let account = state_json(app)["accountId"].as_str().unwrap().to_string();

            // 2. Restart: a FRESH SyncState (as a new process would have) + the same keychain.
            *app.state::<SyncState>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Inner {
                root: None,
                device_seed: None,
                enabled: false,
                account_id: String::new(),
                device_id: String::new(),
                backing: "none".into(),
                status: Status::Disabled,
                generation: 0,
                last_sync_ms: 0,
                last_error: String::new(),
                rate_limit_until_ms: 0,
                consecutive_rate_limits: 0,
            };

            // 3. Boot. The panel must render the ENABLED view again, for the SAME account.
            boot_restore(app);
            let after = state_json(app);
            assert_eq!(after["enabled"], json!(true), "sync must re-enable at boot");
            // The regression this guards: store_root silently fell through to
            // VaultBacking::None (the OS keychain rejected the non-UTF-8 seed), so the
            // root was never durable and the next boot had nothing to restore.
            assert_eq!(
                after["vaultBacking"],
                json!("keychain"),
                "the seed must be persisted in the OS keychain, not held in memory only"
            );
            // `status` is deliberately not asserted to an exact value: enable_with_root
            // spawns a background register_device + nudge pass that flips it to
            // "syncing"/"error", so any exact read here races that thread. What must
            // never happen is a boot that leaves sync disabled — the original symptom.
            assert_ne!(after["status"], json!("disabled"));
            assert_eq!(
                after["accountId"].as_str(),
                Some(account.as_str()),
                "the restored root must be the one the user enabled"
            );
            assert_eq!(after["hasStoredRoot"], json!(true));
        });
    }

    #[test]
    fn restart_respects_a_durable_disable() {
        crate::test_support::with_tmp_app(|app| {
            dispatch(app, "sync.enableNew", &Value::Null)
                .unwrap()
                .unwrap();
            // Disable WITHOUT forgetting, so the seed is still in the keychain.
            let _ = dispatch(app, "sync.disable", &json!({ "forget": false })).unwrap();
            *app.state::<SyncState>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner()) = Inner {
                root: None,
                device_seed: None,
                enabled: false,
                account_id: String::new(),
                device_id: String::new(),
                backing: "none".into(),
                status: Status::Disabled,
                generation: 0,
                last_sync_ms: 0,
                last_error: String::new(),
                rate_limit_until_ms: 0,
                consecutive_rate_limits: 0,
            };
            // The durable marker wins over the still-present keychain seed.
            boot_restore(app);
            assert_eq!(state_json(app)["enabled"], json!(false));
        });
    }

    /// A `429` must actually change the retry cadence. Before this, the periodic thread slept
    /// exactly `syncIntervalSec` and the minimum non-zero value is 1 second, so a rate-limited
    /// client re-entered a server window that can only clear as its already-issued tokens expire
    /// (up to `sync_auth::DEFAULT_TTL_MS` = 5 minutes) — up to ~300 signed round trips, each
    /// costing an Ed25519 verification, with a bare "HTTP 429" shown to the user and no hint
    /// that waiting is the fix.
    #[test]
    fn a_rate_limit_backoff_lengthens_the_periodic_wait() {
        let now = 1_700_000_000_000i64;
        let backoff_until = now + 120_000;
        assert_eq!(
            next_periodic_delay(1, now, backoff_until),
            Some(Duration::from_secs(120)),
            "a 1-second sync interval must NOT be the retry cadence while the server is refusing \
             this device; the backoff window has to win"
        );
        // Once the window has passed, the configured cadence resumes unchanged.
        assert_eq!(
            next_periodic_delay(1, backoff_until, backoff_until),
            Some(Duration::from_secs(1)),
            "after the backoff expires the configured interval must resume, not stay lengthened"
        );
    }

    /// The curve has to be exponential, because the server's limit is a sliding window: a
    /// constant short delay keeps knocking inside a window that has not opened yet, and a
    /// constant long one stalls sync for minutes after the server would have accepted again. It
    /// has to terminate at the token TTL, because waiting longer than that can never help.
    #[test]
    fn the_rate_limit_backoff_doubles_and_stops_at_the_token_ttl() {
        let ttl_secs = (crate::sync_auth::DEFAULT_TTL_MS / 1_000) as u64;
        let mut prev = rate_limit_backoff(1);
        assert_eq!(
            prev,
            Duration::from_secs(30),
            "the first refusal waits the base delay"
        );
        for n in 2..=8 {
            let now = rate_limit_backoff(n);
            assert!(
                now <= Duration::from_secs(ttl_secs),
                "refusal {n} waited {now:?}, longer than the {ttl_secs}s token TTL, which can \
                 never help — every nonce this device minted has expired by then"
            );
            // Strictly longer while it is still under the cap; pinned at the cap once it is not.
            // Asserting "grows" outright would be the wrong invariant, because reaching the cap
            // IS the termination property.
            if now < Duration::from_secs(ttl_secs) {
                assert!(
                    now > prev,
                    "refusal {n} must wait longer than refusal {} ({:?} -> {:?})",
                    n - 1,
                    prev,
                    now
                );
            } else {
                assert_eq!(
                    now,
                    Duration::from_secs(ttl_secs),
                    "refusal {n} reached the cap and must stay pinned there"
                );
            }
            prev = now;
        }
        assert_eq!(
            rate_limit_backoff(u32::MAX),
            Duration::from_secs(ttl_secs),
            "an absurdly long rate-limited streak must saturate at the cap, not overflow the shift"
        );
    }

    /// The backoff may only ever LENGTHEN a wait. Two ways it could wrongly shorten or invent
    /// one: a stale `rate_limit_until_ms` left in state from a previous window, and the user
    /// turning periodic sync off while a backoff is in force.
    #[test]
    fn the_backoff_never_shortens_a_wait_or_resurrects_a_disabled_periodic_sync() {
        let now = 1_700_000_000_000i64;
        // A backoff that has already elapsed must not shorten a 10-minute interval.
        assert_eq!(
            next_periodic_delay(600, now, now - 5_000),
            Some(Duration::from_secs(600)),
            "an expired backoff must leave the configured interval completely alone"
        );
        // `syncIntervalSec == 0` is the documented off switch. A backoff must not turn it back
        // on, or the app would keep polling a server that just told it to stop.
        assert_eq!(
            next_periodic_delay(0, now, now + 300_000),
            None,
            "periodic sync switched off must stay off even while a rate-limit backoff is in force"
        );
    }

    /// Drift guard: the retry bookkeeping is internal and must NOT reach the IPC contract, which
    /// lives in `shared/types.ts`. If it ever does, the renderer and the shared types have to
    /// change together.
    #[test]
    fn the_rate_limit_backoff_is_not_exposed_over_ipc() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            let st = app.state::<SyncState>();
            let mut g = st.0.lock().unwrap_or_else(|e| e.into_inner());
            g.rate_limit_until_ms = 1_700_000_000_000;
            g.consecutive_rate_limits = 7;
            drop(g);
            let s = state_json(app);
            assert!(
                s.get("rateLimitUntilMs").is_none() && s.get("consecutiveRateLimits").is_none(),
                "the backoff is retry bookkeeping, not user-visible state; exposing it would \
                 change the shared/types.ts contract for no reason: {s}"
            );
        });
    }

    /// `syncIntervalSec == 0` means "no periodic pass". It must NOT become `sleep(0)`,
    /// which returns instantly and free-runs pull -> merge -> push forever.
    ///
    /// Called with no backoff in force (`now_ms == rate_limit_until_ms == 0`), so these assert
    /// the configured interval is used verbatim. The backoff's own lengthening is covered
    /// separately by `the_backoff_never_shortens_a_wait_or_resurrects_a_disabled_periodic_sync`.
    #[test]
    fn a_zero_interval_disables_the_periodic_pass_instead_of_spinning() {
        assert_eq!(next_periodic_delay(0, 0, 0), None);
        assert_eq!(
            next_periodic_delay(300, 0, 0),
            Some(Duration::from_secs(300))
        );
        assert_eq!(next_periodic_delay(1, 0, 0), Some(Duration::from_secs(1)));
        // The parked thread still re-reads the setting, so this poll interval is what decides
        // how long re-enabling periodic sync takes. It must be long enough to be cheap and
        // short enough to feel immediate.
        const {
            assert!(
                PERIODIC_OFF_POLL_SECS >= 5 && PERIODIC_OFF_POLL_SECS <= 60,
                "the off-poll must stay responsive without spinning"
            )
        }
    }

    /// Disabling mid-pass must actually stop the upload. Before the generation counter,
    /// `sync.disable` cleared the root and set `Disabled`, but the already-spawned pass kept
    /// pushing every namespace and then unconditionally wrote `Idle` over `Disabled`.
    #[test]
    fn a_generation_change_cancels_an_in_flight_pass() {
        crate::test_support::with_tmp_app(|app| {
            // Not cancelled while enabled at the same generation.
            let enabled = dispatch(app, "sync.enableNew", &Value::Null)
                .unwrap()
                .unwrap();
            assert_eq!(state_json(app)["enabled"], json!(true));
            let gen = {
                let st = app.state::<SyncState>();
                let g = st.0.lock().unwrap_or_else(|e| e.into_inner());
                g.generation
            };
            assert!(!cancelled(app, gen), "a live pass must not cancel itself");
            // A pass that started one generation ago is cancelled — this is the disable case.
            assert!(cancelled(app, gen + 1), "a bumped generation must cancel");
            // Disabling must bump the generation, not just clear the root.
            let _ = dispatch(app, "sync.disable", &Value::Null).unwrap();
            assert_eq!(state_json(app)["enabled"], json!(false));
            assert!(
                cancelled(app, gen),
                "disabling must cancel the pass that was already in flight"
            );
            let _ = enabled;
        });
    }

    #[test]
    fn healthz_url_builds_or_rejects() {
        assert_eq!(healthz_url("", false), None);
        assert_eq!(healthz_url("   ", false), None);
        // Plaintext is refused for a remote host, so the probe can't be aimed at one.
        assert_eq!(healthz_url("http://sync.example.com:8787", false), None);
        // ...but a loopback server the user runs themselves is fine.
        assert_eq!(
            healthz_url("http://127.0.0.1:8787", false),
            Some("http://127.0.0.1:8787/healthz".to_string())
        );
        assert_eq!(
            healthz_url("http://localhost:8787", false),
            Some("http://localhost:8787/healthz".to_string())
        );
        assert_eq!(
            healthz_url("http://[::1]:8787", false),
            Some("http://[::1]:8787/healthz".to_string())
        );
        assert_eq!(
            healthz_url("  https://sync.example.com/  ", false),
            Some("https://sync.example.com/healthz".to_string())
        );
        // A double trailing slash (copy-paste artifact) collapses to one — no `//healthz`.
        assert_eq!(
            healthz_url("http://127.0.0.1:8787//", false),
            Some("http://127.0.0.1:8787/healthz".to_string())
        );
        // The waiver applies to the probe too, so "Test connection" can reach a plaintext
        // server the user has explicitly allowed (it is the only way to confirm one works).
        assert_eq!(
            healthz_url("http://sync.example.com:8787", true),
            Some("http://sync.example.com:8787/healthz".to_string())
        );
    }

    /// The sync transport carries a per-device `Authorization` credential and the user's
    /// stores, so plaintext must be confined to loopback. These cases are the security
    /// property, not incidental formatting. The `false` here is the DEFAULT posture — the
    /// `syncAllowInsecure` waiver is opt-in, and `allow_insecure_waiver_opens_plaintext_remote`
    /// covers what it changes.
    #[test]
    fn validated_base_requires_https_except_loopback() {
        // https: always fine, trailing slashes trimmed.
        assert_eq!(
            validated_base("https://sync.example.com/", false),
            Ok("https://sync.example.com".into())
        );
        assert_eq!(
            validated_base("  https://sync.example.com//  ", false),
            Ok("https://sync.example.com".into())
        );
        // Uppercase scheme is still https.
        assert_eq!(
            validated_base("HTTPS://Sync.Example.com", false),
            Ok("HTTPS://Sync.Example.com".into())
        );

        // http: loopback forms allowed.
        for ok in [
            "http://localhost",
            "http://localhost:8787",
            "http://LOCALHOST:8787",
            "http://127.0.0.1:8787",
            "http://127.0.0.2",
            "http://[::1]:8787",
            // userinfo must not smuggle a remote host past the check.
            "http://user:pw@localhost:8787",
        ] {
            assert!(
                validated_base(ok, false).is_ok(),
                "expected loopback http to be allowed: {ok}"
            );
        }

        // http: everything else rejected, including the near-misses people actually type.
        for bad in [
            "http://sync.example.com",
            "http://sync.example.com:8787",
            "http://192.168.1.10:8787", // RFC1918 — still leaves the host
            "http://10.0.0.5",
            "http://169.254.169.254",    // link-local metadata endpoint
            "http://[::ffff:127.0.0.1]", // v4-mapped must not sneak through
            "http://localhost.evil.com", // suffix trick
            "http://notlocalhost",
            "ftp://sync.example.com", // no scheme we trust at all
            "sync.example.com",       // scheme-less
        ] {
            assert!(
                validated_base(bad, false).is_err(),
                "expected rejection for: {bad}"
            );
        }

        // Empty / whitespace is "not configured", not a validation failure.
        assert!(validated_base("", false).is_err());
        assert!(validated_base("    ", false).is_err());
        assert!(validated_base("///", false).is_err());
    }

    /// The `syncAllowInsecure` waiver: with it on, a plaintext REMOTE server is accepted —
    /// and only that changes. https/loopback keep working, an empty URL stays "not
    /// configured", and a scheme we have no business speaking (`ftp:`, scheme-less) is still
    /// refused, because the waiver relaxes *transport* encryption, not URL parsing.
    #[test]
    fn allow_insecure_waiver_opens_plaintext_remote() {
        for ok in [
            "http://sync.example.com",
            "http://sync.example.com:8787",
            "http://192.168.1.10:8787",  // a LAN self-hoster
            "http://localhost:8787",     // unchanged
            "https://sync.example.com/", // unchanged
        ] {
            assert!(
                validated_base(ok, true).is_ok(),
                "expected the waiver to allow: {ok}"
            );
        }
        // The same values still fail with the waiver OFF — the default posture is untouched.
        for bad in ["http://sync.example.com", "http://192.168.1.10:8787"] {
            assert!(validated_base(bad, false).is_err());
        }
        // Not a blanket "accept any string": unparseable/absent schemes stay rejected.
        for still_bad in [
            "",
            "   ",
            "///",
            "ftp://sync.example.com",
            "sync.example.com",
        ] {
            assert!(
                validated_base(still_bad, true).is_err(),
                "waiver must not accept: {still_bad}"
            );
        }
    }

    #[test]
    fn push_batches_never_exceeds_the_servers_request_cap() {
        // The regression this pins: one request per namespace meant a store that grew past
        // the server's `MAX_RECORDS_PER_REQUEST` (1000) could never sync again, silently.
        for n in [0usize, 1, 499, 500, 501, 1000, 1001, 5001] {
            let wire: Vec<Value> = (0..n).map(|i| json!({ "uuid": format!("r{i}") })).collect();
            let batches = push_batches(&wire);
            for b in &batches {
                assert!(
                    b.len() <= PUSH_CHUNK,
                    "n={n}: a batch carried {} records, over the {PUSH_CHUNK} cap",
                    b.len()
                );
            }
            // Nothing dropped, nothing duplicated, order preserved.
            let flat: Vec<&Value> = batches.iter().flat_map(|b| b.iter()).collect();
            assert_eq!(flat.len(), n, "n={n}: record count changed");
            for (i, r) in flat.iter().enumerate() {
                assert_eq!(
                    r["uuid"],
                    json!(format!("r{i}")),
                    "n={n}: record {i} out of order"
                );
            }
        }
    }

    #[test]
    fn push_batches_splits_just_past_the_cap_and_keeps_one_empty_batch() {
        // 1001 favourites = exactly the user the single-request bug locked out.
        let wire: Vec<Value> = (0..1001)
            .map(|i| json!({ "uuid": format!("r{i}") }))
            .collect();
        let batches = push_batches(&wire);
        assert_eq!(batches.len(), 3, "1001 records should split into 500+500+1");
        assert_eq!(batches[0].len(), PUSH_CHUNK);
        assert_eq!(batches[1].len(), PUSH_CHUNK);
        assert_eq!(batches[2].len(), 1);
        // Empty still POSTs once, so the device keeps proving it is alive.
        let empty = push_batches(&[]);
        assert_eq!(empty.len(), 1);
        assert!(empty[0].is_empty());
    }

    /// The mirror of the `push_batches` bug, on the pull side.
    ///
    /// The server caps one `GET /v1/records` response at `MAX_RESPONSE_RECORDS` and hands back
    /// a `next` cursor when a namespace is larger than that. This client issued exactly ONE
    /// un-paged GET and read `records` off it, so a namespace above the cap could never be
    /// pulled — and after the server was taught to page, the same client would have silently
    /// kept only page 1 and reported a successful pull, which is worse than the 413 it
    /// replaced: the user would see a sync that "works" while their other device's bookmarks
    /// never arrive.
    ///
    /// The two halves are tested separately because they are the two halves of the loop: the
    /// cursor must reach the wire (`pull_url`), and the server's answer must reach the loop
    /// (`next_cursor`). Testing only one would let a "fix" that pages forever, or one that
    /// pages once, pass.
    #[test]
    fn a_paged_pull_follows_the_servers_cursor() {
        // The cursor reaches the request. It is server-supplied text, so it is percent-encoded:
        // a raw `&`/`#`/`=` would re-parse the query string and fetch the wrong page.
        let first = pull_url("http://h:8787", "favorites", None);
        assert_eq!(first, "http://h:8787/v1/records?ns=favorites");
        let second = pull_url("http://h:8787", "favorites", Some("ab&cd=ef"));
        assert!(
            second.contains("cursor="),
            "page 2 must ask for the next page, but the URL is {second:?} — the client is \
             re-fetching page 1 forever or stopping after one page"
        );
        assert!(
            !second.contains("cursor=ab&cd=ef"),
            "the cursor must be percent-encoded, not pasted raw: {second:?}"
        );
        // Re-parsing the URL must yield the cursor back verbatim — the property that proves the
        // encoding is correct rather than merely present.
        let parsed = url::Url::parse(&second).expect("built URL must parse");
        assert_eq!(
            parsed
                .query_pairs()
                .find(|(k, _)| k == "cursor")
                .map(|(_, v)| v.into_owned()),
            Some("ab&cd=ef".to_string()),
            "the cursor must survive a URL round-trip unchanged"
        );

        // The server's answer reaches the loop. `null`/absent/empty all mean "last page" — an
        // echoed `""` would otherwise re-request page 1 forever, because the server's own
        // retain is `uuid > cursor` and every uuid sorts after the empty string.
        assert_eq!(
            next_cursor(&json!({ "records": [], "next": "zz" })),
            Some("zz".to_string()),
            "a cursor in the response must continue the pull"
        );
        for last in [
            json!({ "records": [] }),
            json!({ "records": [], "next": null }),
            json!({ "records": [], "next": "" }),
            json!({ "records": [], "next": 7 }),
        ] {
            assert_eq!(
                next_cursor(&last),
                None,
                "no further page is implied by {last} — the pull must stop, not spin"
            );
        }
    }

    /// The loop bound is a real bound, not decoration: it is what stops a server that always
    /// answers with a cursor from spinning the client forever.
    ///
    /// `black_box` on both sides: clippy's `assertions_on_constants` is right that a comparison
    /// of two literals is decided at compile time, which would make this a build-time check
    /// dressed up as a test. The point being pinned here is that someone lowering
    /// `MAX_PULL_PAGES` — to "stop the loop from being slow", say — re-creates the very dead-end
    /// this wave removed, just at a higher record count.
    #[test]
    fn the_pull_page_bound_is_finite_and_bounded() {
        let pages = std::hint::black_box(MAX_PULL_PAGES);
        // The server's own ceiling for one account (`MAX_RECORDS_PER_ACCOUNT` in
        // sync-server/src/main.rs): a bound below ceil(50_000 / 5_000) would make the largest
        // account a legitimate server will hold unpullable.
        let per_page = std::hint::black_box(5_000usize);
        let account_ceiling = std::hint::black_box(50_000usize);
        assert!(pages > 0, "a zero bound would pull nothing at all");
        assert!(
            pages * per_page >= account_ceiling,
            "the bound must still let a client pull an account at the server's own ceiling of \
             {account_ceiling} records, or the dead-end just moves from `> 5000` to `> {}`",
            pages * per_page
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
