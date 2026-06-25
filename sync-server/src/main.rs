//! Reference self-hosted sync server for Aegis.
//!
//! It stores OPAQUE CIPHERTEXT only — it cannot decrypt anything. Records are keyed by
//! (accountId, namespace, uuid); the server applies HLC last-writer-wins on store using the
//! CLEARTEXT hlc the client sends (it never sees the plaintext). Per-device Ed25519 signed
//! tokens authenticate requests; a device self-registers on first contact (TOFU — the
//! account secret is the recovery phrase, from which the accountId + device keys derive).
//!
//! This is a minimal in-memory reference (a real deployment swaps the maps for a DB). Run:
//!   cargo run            # listens on 127.0.0.1:8787
//!   AEGIS_SYNC_ADDR=0.0.0.0:8787 cargo run
//! then set Aegis's Settings → Sync server URL to http://<host>:8787
//!
//! The auth `canonical()` + token shape below MUST match src-tauri/src/sync_auth.rs
//! byte-for-byte (kept in sync by hand; covered by the round-trip test).
use std::collections::HashMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

// ----------------------------------------------------------------------------- auth

#[derive(Serialize, Deserialize)]
struct AuthToken {
    account_id: String,
    device_id: String,
    issued_ms: i64,
    expires_ms: i64,
    nonce: String,
}

/// MUST match src-tauri/src/sync_auth.rs `canonical` byte-for-byte.
fn canonical(t: &AuthToken) -> Vec<u8> {
    format!(
        "aegis-auth-v1\n{}\n{}\n{}\n{}\n{}",
        t.account_id, t.device_id, t.issued_ms, t.expires_ms, t.nonce
    )
    .into_bytes()
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// Verify the `Authorization: AegisSig {accountId}.{tokenHex}.{sigHex}` header. Returns the
/// authenticated (accountId, deviceId). Does NOT check registration — the caller decides
/// whether to require it (data endpoints do; device registration is self-bootstrapping).
fn verify_auth(headers: &HeaderMap, state: &AppState) -> Result<(String, String), StatusCode> {
    let raw = headers
        .get("authorization")
        .and_then(|v| v.to_str().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let rest = raw
        .strip_prefix("AegisSig ")
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let mut parts = rest.splitn(3, '.');
    let account = parts.next().ok_or(StatusCode::UNAUTHORIZED)?;
    let token_hex = parts.next().ok_or(StatusCode::UNAUTHORIZED)?;
    let sig_hex = parts.next().ok_or(StatusCode::UNAUTHORIZED)?;

    let token: AuthToken = unhex(token_hex)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    if token.account_id != account {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let now = now_ms();
    if now > token.expires_ms || token.issued_ms > now + 60_000 {
        return Err(StatusCode::UNAUTHORIZED);
    }
    let vk_bytes: [u8; 32] = unhex(&token.device_id)
        .and_then(|b| b.try_into().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let vk = VerifyingKey::from_bytes(&vk_bytes).map_err(|_| StatusCode::UNAUTHORIZED)?;
    let sig_bytes: [u8; 64] = unhex(sig_hex)
        .and_then(|b| b.try_into().ok())
        .ok_or(StatusCode::UNAUTHORIZED)?;
    let sig = Signature::from_bytes(&sig_bytes);
    vk.verify_strict(&canonical(&token), &sig)
        .map_err(|_| StatusCode::UNAUTHORIZED)?;
    // Replay defense: a (device, nonce) pair is single-use. Recorded only AFTER the signature
    // verifies (so unauthenticated tokens can't bloat the set), and bounded by the TTL —
    // expired entries are swept (their tokens already fail the `now > expires_ms` check above).
    // The client mints a FRESH nonce per request (sync.rs `sync_ns`), so a legitimate request is
    // never rejected. Honest residual: the set is in-memory, so a server RESTART forgets spent
    // nonces — a token captured before a restart could replay within its (≤5-min) TTL after it.
    {
        let mut seen = state.seen_nonces.lock().unwrap();
        seen.retain(|_, exp| *exp > now);
        let key = (token.device_id.clone(), token.nonce.clone());
        if seen.contains_key(&key) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        seen.insert(key, token.expires_ms);
    }
    Ok((token.account_id, token.device_id))
}

// ----------------------------------------------------------------------------- store

#[derive(Clone, Serialize, Deserialize)]
struct WireRecord {
    uuid: String,
    hlc: Value,
    deleted: bool,
    nonce: String,
    ct: String,
}

/// Total order on the cleartext HLC (wall_ms, counter, node) — matches the client's Hlc Ord.
fn hlc_key(hlc: &Value) -> (i64, u64, String) {
    (
        hlc.get("wall_ms").and_then(Value::as_i64).unwrap_or(0),
        hlc.get("counter").and_then(Value::as_u64).unwrap_or(0),
        hlc.get("node")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_string(),
    )
}

#[derive(Clone, Serialize, Deserialize)]
struct Device {
    #[serde(rename = "deviceId")]
    device_id: String,
    label: String,
    #[serde(rename = "lastSeenMs")]
    last_seen_ms: i64,
}

#[derive(Default)]
struct Store {
    // (account, ns, uuid) -> record
    records: HashMap<(String, String, String), WireRecord>,
    // account -> deviceId -> device
    devices: HashMap<String, HashMap<String, Device>>,
}

// On-disk shape. The live Store is keyed by tuples (which JSON can't use as map keys),
// so we flatten to vectors for serialization and rebuild the maps on load.
#[derive(Serialize, Deserialize)]
struct SnapRecord {
    account: String,
    ns: String,
    record: WireRecord,
}

#[derive(Serialize, Deserialize)]
struct SnapDevice {
    account: String,
    device: Device,
}

#[derive(Serialize, Deserialize, Default)]
struct Snapshot {
    records: Vec<SnapRecord>,
    devices: Vec<SnapDevice>,
}

impl Snapshot {
    fn from_store(store: &Store) -> Snapshot {
        let records = store
            .records
            .iter()
            // _uuid == record.uuid by construction (see into_store); use the field value, not the key
            .map(|((account, ns, _uuid), record)| SnapRecord {
                account: account.clone(),
                ns: ns.clone(),
                record: record.clone(),
            })
            .collect();
        let devices = store
            .devices
            .iter()
            .flat_map(|(account, set)| {
                set.values().map(move |d| SnapDevice {
                    account: account.clone(),
                    device: d.clone(),
                })
            })
            .collect();
        Snapshot { records, devices }
    }

    fn into_store(self) -> Store {
        let mut store = Store::default();
        for sr in self.records {
            let key = (sr.account, sr.ns, sr.record.uuid.clone());
            store.records.insert(key, sr.record);
        }
        for sd in self.devices {
            let device_id = sd.device.device_id.clone();
            store
                .devices
                .entry(sd.account)
                .or_default()
                .insert(device_id, sd.device);
        }
        store
    }
}

/// Atomically write the snapshot to `path`: serialize to a sibling `.tmp`, fsync it, then
/// rename over the target (atomic on the same filesystem). Callers must serialize concurrent
/// writes externally (Task 3 wires this via the writer mutex); a fixed `.tmp` name is then
/// safe because only one write can be in flight at a time.
fn save_snapshot(path: &Path, snap: &Snapshot) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(snap)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut tmp_os = path.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Load a store from `path`. A missing file is a fresh start (empty store); an unparseable
/// file is a hard error so the operator fails loud rather than silently losing data.
fn load_store(path: &Path) -> std::io::Result<Store> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let snap: Snapshot = serde_json::from_slice(&bytes)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(snap.into_store())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e),
    }
}

type Db = Arc<Mutex<Store>>;

/// Shared request state: the in-memory store plus optional disk persistence. `writer`
/// serializes atomic writes so two concurrent mutations never clobber each other's temp file.
#[derive(Clone)]
struct AppState {
    db: Db,
    data_path: Option<Arc<PathBuf>>,
    writer: Arc<Mutex<()>>,
    // Spent auth-token nonces for replay defense: (device_id, nonce) -> token expiry_ms.
    // Bounded by the token TTL (expired entries are swept on each verify). In-memory only —
    // a restart forgets them (documented residual, bounded by the ≤5-min TTL).
    seen_nonces: Arc<Mutex<HashMap<(String, String), i64>>>,
}

impl AppState {
    fn new(store: Store, data_path: Option<PathBuf>) -> AppState {
        AppState {
            db: Arc::new(Mutex::new(store)),
            data_path: data_path.map(Arc::new),
            writer: Arc::new(Mutex::new(())),
            seen_nonces: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Snapshot the store under its lock, release it, then atomically write to disk under the
    /// writer lock — so requests never block on fsync. No-op when persistence is disabled.
    ///
    /// The snapshot and the write are taken under separate locks, so under heavy concurrent
    /// writes the on-disk file may lag the in-memory store by one mutation (e.g. snapshot A,
    /// then B fully persists, then A's older snapshot writes last). The write is always atomic
    /// (temp→fsync→rename), so the file is never torn — only at worst one mutation stale, and
    /// the next persist re-writes current state. The in-memory store stays fully serialized by
    /// the db mutex and is authoritative for all reads. Acceptable at the intended personal
    /// scale; tightening it (snapshot under the writer lock) would hold up writers on fsync.
    fn persist(&self) {
        let Some(path) = self.data_path.clone() else {
            return;
        };
        let snap = {
            let g = self.db.lock().unwrap();
            Snapshot::from_store(&g)
        };
        let _w = self.writer.lock().unwrap();
        if let Err(e) = save_snapshot(&path, &snap) {
            eprintln!(
                "[aegis-sync-server] WARN failed to persist to {}: {e}",
                path.display()
            );
        }
    }
}

fn require_registered(db: &Db, account: &str, device: &str) -> Result<(), StatusCode> {
    let g = db.lock().unwrap();
    match g.devices.get(account) {
        Some(set) if set.contains_key(device) => Ok(()),
        _ => Err(StatusCode::FORBIDDEN),
    }
}

// ----------------------------------------------------------------------------- quotas
// Bound authenticated resource use: a registered-but-malicious paired device (any holder of
// the recovery phrase, or a compromised device) must not be able to OOM the process or fill
// disk. Generous for a personal deployment; tighten via these constants if needed.
const MAX_RECORDS_PER_REQUEST: usize = 1000; // records in one POST /v1/records body
const MAX_RECORDS_PER_ACCOUNT: usize = 50_000; // total live records an account may hold
const MAX_FIELD_LEN: usize = 1024; // ns / uuid / nonce (short ids / hex)
const MAX_CT_LEN: usize = 64 * 1024; // ciphertext bytes per record (very generous for one item)
const MAX_LABEL_LEN: usize = 256; // device label
const MAX_BODY_BYTES: usize = 8 * 1024 * 1024; // coarse request-body backstop (axum layer)

// ----------------------------------------------------------------------------- handlers

#[derive(Deserialize)]
struct RecordsQuery {
    ns: String,
}

async fn get_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RecordsQuery>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers, &state)?;
    require_registered(&state.db, &account, &device)?;
    let g = state.db.lock().unwrap();
    let records: Vec<WireRecord> = g
        .records
        .iter()
        .filter(|((a, n, _), _)| a == &account && n == &q.ns)
        .map(|(_, r)| r.clone())
        .collect();
    Ok(Json(json!({ "records": records })))
}

#[derive(Deserialize)]
struct PostRecords {
    ns: String,
    records: Vec<WireRecord>,
}

async fn post_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PostRecords>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers, &state)?;
    require_registered(&state.db, &account, &device)?;
    // Quota: reject excessive / oversized input before touching the store.
    if body.records.len() > MAX_RECORDS_PER_REQUEST || body.ns.len() > MAX_FIELD_LEN {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    for r in &body.records {
        if r.uuid.len() > MAX_FIELD_LEN || r.nonce.len() > MAX_FIELD_LEN || r.ct.len() > MAX_CT_LEN
        {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
    }
    let mut changed = false;
    {
        let mut g = state.db.lock().unwrap();
        // Per-account total cap: refuse to GROW an account past the cap (updates to existing
        // records always pass — they don't add a key). Counts the new keys this request adds.
        let current = g.records.keys().filter(|(a, _, _)| a == &account).count();
        let new_keys = body
            .records
            .iter()
            .filter(|r| {
                !g.records
                    .contains_key(&(account.clone(), body.ns.clone(), r.uuid.clone()))
            })
            .count();
        if current + new_keys > MAX_RECORDS_PER_ACCOUNT {
            return Err(StatusCode::INSUFFICIENT_STORAGE);
        }
        for rec in body.records {
            let key = (account.clone(), body.ns.clone(), rec.uuid.clone());
            // HLC last-writer-wins: keep the incoming record only if it strictly dominates the
            // stored one (a stale push from a lagging device can't roll the server back).
            let keep = match g.records.get(&key) {
                Some(existing) => hlc_key(&rec.hlc) > hlc_key(&existing.hlc),
                None => true,
            };
            if keep {
                g.records.insert(key, rec);
                changed = true;
            }
        }
    }
    if changed {
        state.persist();
    }
    Ok(Json(json!({ "ok": true })))
}

#[derive(Deserialize)]
struct RegisterDevice {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    label: String,
    /// Account-root signature over `aegis-register-v1\n{accountId}\n{deviceId}`.
    #[serde(rename = "accountSig")]
    account_sig: String,
}

/// Verify that `account_sig` is a valid signature over the registration message by the
/// account key — and the account id IS that key's public half. So only a holder of the
/// account root (which derives the account signing key) can register a device; knowing the
/// public account id is not enough.
fn verify_account_root(account_id: &str, device_id: &str, account_sig: &str) -> bool {
    let Some(vk_bytes) = unhex(account_id).and_then(|b| <[u8; 32]>::try_from(b).ok()) else {
        return false;
    };
    let Ok(vk) = VerifyingKey::from_bytes(&vk_bytes) else {
        return false;
    };
    let Some(sig_bytes) = unhex(account_sig).and_then(|b| <[u8; 64]>::try_from(b).ok()) else {
        return false;
    };
    let sig = Signature::from_bytes(&sig_bytes);
    let msg = format!("aegis-register-v1\n{account_id}\n{device_id}");
    vk.verify_strict(msg.as_bytes(), &sig).is_ok()
}

async fn post_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterDevice>,
) -> Result<Json<Value>, StatusCode> {
    // The device token proves possession of the DEVICE key; it must name the same account +
    // device as the body.
    let (account, device) = verify_auth(&headers, &state)?;
    if account != body.account_id || device != body.device_id {
        return Err(StatusCode::FORBIDDEN);
    }
    if body.label.len() > MAX_LABEL_LEN {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    // PROOF-OF-ROOT: registration must be signed by the account key (whose public half IS
    // the account id). Without this, anyone who learned the public account id could
    // self-register a rogue device into the victim's account.
    if !verify_account_root(&body.account_id, &body.device_id, &body.account_sig) {
        return Err(StatusCode::FORBIDDEN);
    }
    {
        let mut g = state.db.lock().unwrap();
        g.devices.entry(account).or_default().insert(
            device.clone(),
            Device {
                device_id: device,
                label: body.label,
                last_seen_ms: now_ms(),
            },
        );
    }
    state.persist();
    Ok(Json(json!({ "ok": true })))
}

async fn get_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers, &state)?;
    require_registered(&state.db, &account, &device)?;
    let g = state.db.lock().unwrap();
    let devices: Vec<Device> = g
        .devices
        .get(&account)
        .map(|m| m.values().cloned().collect())
        .unwrap_or_default();
    Ok(Json(json!({ "devices": devices })))
}

#[derive(Deserialize)]
struct RemoveDevice {
    #[serde(rename = "deviceId")]
    device_id: String,
}

async fn remove_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RemoveDevice>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers, &state)?;
    require_registered(&state.db, &account, &device)?;
    let mut removed = false;
    {
        let mut g = state.db.lock().unwrap();
        if let Some(set) = g.devices.get_mut(&account) {
            removed = set.remove(&body.device_id).is_some();
        }
    }
    if removed {
        state.persist();
    }
    Ok(Json(json!({ "ok": true })))
}

/// Unauthenticated liveness probe for Docker/reverse proxies. Returns no account data.
async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

fn app(state: AppState) -> Router {
    Router::new()
        .route("/v1/records", get(get_records).post(post_records))
        .route("/v1/devices", get(get_devices).post(post_device))
        .route("/v1/devices/remove", post(remove_device))
        .route("/healthz", get(healthz))
        // Coarse pre-deserialization backstop on the request body (axum default is 2 MiB); the
        // per-field / per-request quotas above do the fine-grained bounding.
        .layer(DefaultBodyLimit::max(MAX_BODY_BYTES))
        .with_state(state)
}

#[tokio::main]
async fn main() {
    let addr = std::env::var("AEGIS_SYNC_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let data_path = std::env::var("AEGIS_SYNC_DATA").ok().map(PathBuf::from);
    let store = match &data_path {
        Some(p) => load_store(p)
            .unwrap_or_else(|e| panic!("[aegis-sync-server] failed to load {}: {e}", p.display())),
        None => Store::default(),
    };
    let state = AppState::new(store, data_path.clone());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    let storage = data_path
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "in-memory".to_string());
    println!(
        "[aegis-sync-server] listening on http://{addr} (storage: {storage}, ciphertext-only)"
    );
    axum::serve(listener, app(state)).await.expect("serve");
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    fn hex_bytes(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }

    /// Build an `Authorization: AegisSig …` header for a device key, with the given nonce.
    fn signed(key: &SigningKey, account: &str, nonce: &str, expires_ms: i64) -> HeaderMap {
        let device_id = hex_bytes(&key.verifying_key().to_bytes());
        let token = AuthToken {
            account_id: account.into(),
            device_id,
            issued_ms: now_ms(),
            expires_ms,
            nonce: nonce.into(),
        };
        let token_hex = hex_bytes(&serde_json::to_vec(&token).unwrap());
        let sig_hex = hex_bytes(&key.sign(&canonical(&token)).to_bytes());
        let mut h = HeaderMap::new();
        h.insert(
            "authorization",
            format!("AegisSig {account}.{token_hex}.{sig_hex}")
                .parse()
                .unwrap(),
        );
        h
    }

    /// A fresh AppState with one device registered under `account`, returning the device key.
    fn registered(seed: u8) -> (AppState, SigningKey, String) {
        let key = SigningKey::from_bytes(&[seed; 32]);
        let account = format!("acct-{seed}");
        let device_id = hex_bytes(&key.verifying_key().to_bytes());
        let state = AppState::new(Store::default(), None);
        state
            .db
            .lock()
            .unwrap()
            .devices
            .entry(account.clone())
            .or_default()
            .insert(
                device_id.clone(),
                Device {
                    device_id,
                    label: "L".into(),
                    last_seen_ms: 0,
                },
            );
        (state, key, account)
    }

    fn rec(uuid: &str, wall: i64, ct: &str) -> WireRecord {
        WireRecord {
            uuid: uuid.into(),
            hlc: json!({ "wall_ms": wall, "counter": 0, "node": "n" }),
            deleted: false,
            nonce: "n".into(),
            ct: ct.into(),
        }
    }

    #[tokio::test]
    async fn replayed_token_rejected_distinct_nonce_accepted() {
        let (state, key, account) = registered(20);
        let ttl = now_ms() + 300_000;
        let h1 = signed(&key, &account, "nonce-1", ttl);
        // First use of a token: accepted.
        assert!(post_records(
            State(state.clone()),
            h1.clone(),
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![]
            }),
        )
        .await
        .is_ok());
        // Replaying the EXACT same token (same nonce) must be rejected.
        let replay = post_records(
            State(state.clone()),
            h1,
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![],
            }),
        )
        .await;
        assert_eq!(replay.unwrap_err(), StatusCode::UNAUTHORIZED);
        // A fresh token (distinct nonce) is accepted.
        let h2 = signed(&key, &account, "nonce-2", ttl);
        assert!(post_records(
            State(state),
            h2,
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![]
            }),
        )
        .await
        .is_ok());
    }

    #[tokio::test]
    async fn oversized_or_excessive_records_rejected() {
        let (state, key, account) = registered(21);
        let ttl = now_ms() + 300_000;
        // Oversized ciphertext → 413.
        let big = post_records(
            State(state.clone()),
            signed(&key, &account, "a1", ttl),
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![rec("u", 1, &"a".repeat(MAX_CT_LEN + 1))],
            }),
        )
        .await;
        assert_eq!(big.unwrap_err(), StatusCode::PAYLOAD_TOO_LARGE);
        // Too many records in one request → 413.
        let many: Vec<WireRecord> = (0..=MAX_RECORDS_PER_REQUEST)
            .map(|i| rec(&format!("u{i}"), 1, "c"))
            .collect();
        let flood = post_records(
            State(state.clone()),
            signed(&key, &account, "a2", ttl),
            Json(PostRecords {
                ns: "bm".into(),
                records: many,
            }),
        )
        .await;
        assert_eq!(flood.unwrap_err(), StatusCode::PAYLOAD_TOO_LARGE);
        // Oversized namespace → 413.
        let ns = post_records(
            State(state),
            signed(&key, &account, "a3", ttl),
            Json(PostRecords {
                ns: "x".repeat(MAX_FIELD_LEN + 1),
                records: vec![],
            }),
        )
        .await;
        assert_eq!(ns.unwrap_err(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[tokio::test]
    async fn per_account_record_cap_enforced_but_updates_allowed() {
        let (state, key, account) = registered(22);
        let ttl = now_ms() + 300_000;
        // Fill the account to capacity directly.
        {
            let mut g = state.db.lock().unwrap();
            for i in 0..MAX_RECORDS_PER_ACCOUNT {
                g.records.insert(
                    (account.clone(), "bm".into(), format!("u{i}")),
                    rec(&format!("u{i}"), 1, "c"),
                );
            }
        }
        // A NEW record is refused (account full) → 507.
        let grow = post_records(
            State(state.clone()),
            signed(&key, &account, "b1", ttl),
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![rec("brand-new", 1, "c")],
            }),
        )
        .await;
        assert_eq!(grow.unwrap_err(), StatusCode::INSUFFICIENT_STORAGE);
        // UPDATING an existing record (no growth) is still allowed.
        let update = post_records(
            State(state),
            signed(&key, &account, "b2", ttl),
            Json(PostRecords {
                ns: "bm".into(),
                records: vec![rec("u0", 99, "updated")],
            }),
        )
        .await;
        assert!(update.is_ok(), "an update at capacity must not be blocked");
    }

    #[tokio::test]
    async fn oversized_device_label_rejected() {
        let (state, key, account) = registered(23);
        let device_id = hex_bytes(&key.verifying_key().to_bytes());
        let r = post_device(
            State(state),
            signed(&key, &account, "c1", now_ms() + 300_000),
            Json(RegisterDevice {
                account_id: account.clone(),
                device_id,
                label: "x".repeat(MAX_LABEL_LEN + 1),
                account_sig: "00".into(), // never reached — the label is validated first
            }),
        )
        .await;
        assert_eq!(r.unwrap_err(), StatusCode::PAYLOAD_TOO_LARGE);
    }

    #[test]
    fn hlc_lww_keeps_the_dominant_record() {
        let older = json!({ "wall_ms": 1, "counter": 0, "node": "a" });
        let newer = json!({ "wall_ms": 5, "counter": 0, "node": "a" });
        assert!(hlc_key(&newer) > hlc_key(&older));
        // tie on wall+counter → node breaks it (consistent with the client's Hlc Ord).
        let a = json!({ "wall_ms": 1, "counter": 0, "node": "a" });
        let b = json!({ "wall_ms": 1, "counter": 0, "node": "b" });
        assert!(hlc_key(&b) > hlc_key(&a));
    }

    #[test]
    fn canonical_matches_the_documented_shape() {
        let t = AuthToken {
            account_id: "acct".into(),
            device_id: "dev".into(),
            issued_ms: 10,
            expires_ms: 20,
            nonce: "ab".into(),
        };
        assert_eq!(
            canonical(&t),
            b"aegis-auth-v1\nacct\ndev\n10\n20\nab".to_vec()
        );
    }

    #[test]
    fn unhex_round_trips() {
        assert_eq!(unhex("00ff10").unwrap(), vec![0x00, 0xff, 0x10]);
        assert!(unhex("xyz").is_none());
        assert!(unhex("abc").is_none()); // odd length
    }

    #[test]
    fn registration_requires_the_account_root_key() {
        use ed25519_dalek::{Signer, SigningKey};
        fn hx(b: &[u8]) -> String {
            b.iter().map(|x| format!("{x:02x}")).collect()
        }
        let account_key = SigningKey::from_bytes(&[7u8; 32]);
        let account_id = hx(&account_key.verifying_key().to_bytes()); // id IS the pubkey
        let device_id = "deadbeef";
        let msg = format!("aegis-register-v1\n{account_id}\n{device_id}");

        // A signature by the account key (i.e. a holder of the root) is accepted.
        let ok = hx(&account_key.sign(msg.as_bytes()).to_bytes());
        assert!(verify_account_root(&account_id, device_id, &ok));

        // An attacker who only knows the PUBLIC account id (but not the root) signs with
        // their own key → rejected: no rogue registration.
        let attacker = SigningKey::from_bytes(&[9u8; 32]);
        let forged = hx(&attacker.sign(msg.as_bytes()).to_bytes());
        assert!(!verify_account_root(&account_id, device_id, &forged));

        // A signature for a different device_id doesn't transfer.
        assert!(!verify_account_root(&account_id, "other", &ok));
    }

    #[test]
    fn save_then_load_yields_equal_store() {
        let dir = std::env::temp_dir().join(format!("aegis-sync-save-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");

        let mut store = Store::default();
        store.devices.entry("acct".into()).or_default().insert(
            "dev1".into(),
            Device {
                device_id: "dev1".into(),
                label: "L".into(),
                last_seen_ms: 7,
            },
        );
        // Also exercise a record through the disk path (devices alone wouldn't catch a
        // broken SnapRecord (de)serialization).
        store.records.insert(
            ("acct".into(), "bm".into(), "u1".into()),
            WireRecord {
                uuid: "u1".into(),
                hlc: json!({ "wall_ms": 1, "counter": 0, "node": "a" }),
                deleted: false,
                nonce: "n".into(),
                ct: "c".into(),
            },
        );

        save_snapshot(&path, &Snapshot::from_store(&store)).unwrap();
        let loaded = load_store(&path).unwrap();

        assert_eq!(
            loaded
                .devices
                .get("acct")
                .unwrap()
                .get("dev1")
                .unwrap()
                .last_seen_ms,
            7
        );
        assert_eq!(loaded.records.len(), 1);
        assert_eq!(
            loaded
                .records
                .get(&("acct".into(), "bm".into(), "u1".into()))
                .unwrap()
                .ct,
            "c"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn missing_file_loads_empty() {
        let path =
            std::env::temp_dir().join(format!("aegis-sync-absent-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&path);
        let store = load_store(&path).unwrap();
        assert!(store.records.is_empty() && store.devices.is_empty());
    }

    #[test]
    fn corrupt_file_is_an_error() {
        let dir = std::env::temp_dir().join(format!("aegis-sync-corrupt-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");
        std::fs::write(&path, b"not json {").unwrap();
        assert!(load_store(&path).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn persist_writes_and_reloads_through_appstate() {
        let dir = std::env::temp_dir().join(format!("aegis-sync-appstate-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("data.json");

        let state = AppState::new(Store::default(), Some(path.clone()));
        state
            .db
            .lock()
            .unwrap()
            .devices
            .entry("acct".into())
            .or_default()
            .insert(
                "dev1".into(),
                Device {
                    device_id: "dev1".into(),
                    label: "laptop".into(),
                    last_seen_ms: 99,
                },
            );
        state.persist();

        let reloaded = load_store(&path).unwrap();
        assert_eq!(
            reloaded
                .devices
                .get("acct")
                .unwrap()
                .get("dev1")
                .unwrap()
                .label,
            "laptop"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[tokio::test]
    async fn healthz_returns_ok() {
        let Json(v) = healthz().await;
        assert_eq!(v, json!({ "ok": true }));
    }

    #[test]
    fn snapshot_round_trips_records_and_devices() {
        let mut store = Store::default();
        store.records.insert(
            ("acct".into(), "bookmarks".into(), "u1".into()),
            WireRecord {
                uuid: "u1".into(),
                hlc: json!({ "wall_ms": 1, "counter": 0, "node": "a" }),
                deleted: false,
                nonce: "nn".into(),
                ct: "cc".into(),
            },
        );
        store.devices.entry("acct".into()).or_default().insert(
            "dev1".into(),
            Device {
                device_id: "dev1".into(),
                label: "phone".into(),
                last_seen_ms: 42,
            },
        );

        let back = Snapshot::from_store(&store).into_store();

        assert_eq!(back.records.len(), 1);
        let r = back
            .records
            .get(&("acct".into(), "bookmarks".into(), "u1".into()))
            .unwrap();
        assert_eq!(r.ct, "cc");
        assert_eq!(
            back.devices.get("acct").unwrap().get("dev1").unwrap().label,
            "phone"
        );
        assert_eq!(
            back.devices
                .get("acct")
                .unwrap()
                .get("dev1")
                .unwrap()
                .last_seen_ms,
            42
        );
    }
}
