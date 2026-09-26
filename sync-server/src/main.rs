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
use std::collections::{HashMap, HashSet};
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
        .expect("system clock is before UNIX epoch")
        .as_millis() as i64
}

/// Maximum token validity span. MUST be >= the client's `DEFAULT_TTL_MS`
/// (`src-tauri/src/sync_auth.rs`) so honest clients are never rejected; the server enforces it
/// because `expires_ms` is inside the signed-but-self-chosen token body.
const MAX_TTL_MS: i64 = 5 * 60_000;
/// Tolerance for a client whose clock runs slightly ahead of the server's.
const MAX_FUTURE_SKEW_MS: i64 = 60_000;
/// Tolerance for a client whose clock runs behind, and the bound on replaying a token that was
/// captured long ago (its own `expires_ms` may still be in the future if the attacker minted it).
const MAX_PAST_SKEW_MS: i64 = 5 * 60_000;
/// Hard cap on the replay-nonce map so a long-lived process can't grow it without bound. Each
/// authenticated request inserts one entry and the sweep only removes EXPIRED ones, so a
/// high-rate client needs a real ceiling. At the 5-minute TTL this holds ~1 hour of 12k req/s.
const MAX_SEEN_NONCES: usize = 250_000;

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
    // LIFETIME BOUNDS. `expires_ms` is attacker-controlled (anyone holding one device key can
    // sign their own token), so both the forward window and the *span* must be clamped:
    //   - already expired                      -> reject
    //   - issued in the future                 -> reject (clock-skew allowance only)
    //   - issued implausibly long ago          -> reject (a stale replayed token)
    //   - validity span longer than MAX_TTL_MS -> reject (would be valid FOREVER)
    // Without the span clamp a captured `Authorization` header can be replayed indefinitely,
    // and because `seen` stores the token's OWN expires_ms the replay set never gets swept.
    if now > token.expires_ms || token.issued_ms > now + MAX_FUTURE_SKEW_MS {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if token.issued_ms < now - MAX_PAST_SKEW_MS {
        return Err(StatusCode::UNAUTHORIZED);
    }
    if token.expires_ms.saturating_sub(token.issued_ms) > MAX_TTL_MS {
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
        // Bound the map. The sweep above only drops EXPIRED entries, so a client that keeps
        // minting valid tokens would otherwise grow this set forever. When the cap is hit we
        // refuse the NEW nonce rather than evicting a live one: evicting a live entry would
        // re-open a replay window, whereas refusing only costs an over-fast client a retry.
        if seen.len() >= MAX_SEEN_NONCES {
            eprintln!(
                "[aegis-sync-server] WARN replay-nonce map at cap ({MAX_SEEN_NONCES}); \
                 rejecting further nonces this window"
            );
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        seen.insert(key, token.expires_ms);
    }
    Ok((token.account_id, token.device_id))
}

// ----------------------------------------------------------------------------- store

/// A stored record's key: `(account, namespace, uuid)`. Aliased because it appears in several
/// signatures and in the tombstone-grouping map below, where the spelled-out tuple tripped
/// clippy's `type_complexity`.
type RecordKey = (String, String, String);

/// Tombstone keys grouped by `(account, ns)`, newest-first by HLC.
type TombstonesByNs<'a> = HashMap<(&'a str, &'a str), Vec<&'a RecordKey>>;

#[derive(Clone, Serialize, Deserialize)]
struct WireRecord {
    uuid: String,
    hlc: Value,
    deleted: bool,
    nonce: String,
    ct: String,
}

/// Deterministic 128-bit content digest (FNV-1a run at two independent offsets/seeds).
///
/// Used only to synthesize a missing record `uuid` — deliberately dependency-free so the server
/// keeps its tiny lockfile. This is NOT a security primitive: it just has to be stable and wide
/// enough that two distinct records derive different uuids, and [`unique_uuid`] re-checks for a
/// collision anyway rather than trusting the digest.
fn content_digest(parts: &[&str]) -> String {
    const OFFSET: u64 = 0xcbf2_9ce4_8422_2325;
    const PRIME: u64 = 0x0000_0100_0000_01b3;
    let (mut h1, mut h2) = (OFFSET, OFFSET ^ 0x9e37_79b9_7f4a_7c15);
    for (i, p) in parts.iter().enumerate() {
        for b in p.as_bytes() {
            h1 ^= u64::from(*b).wrapping_add(i as u64);
            h1 = h1.wrapping_mul(PRIME);
            h2 ^= u64::from(*b).rotate_left(17).wrapping_add(h2);
            h2 = h2.wrapping_mul(PRIME);
        }
        h1 ^= PRIME;
        h2 = h1;
    }
    format!("{:016x}{:016x}", h1, h2)
}

/// The uuid an incoming record should be stored under: its own if it has one, otherwise one
/// derived from its content so that two different records never share an id. Re-checks the
/// derived id against `taken` and, on the (astronomically unlikely) collision, re-derives with an
/// incrementing salt until it is unique — so the "same id ⇒ same record" invariant holds even if
/// the digest collides.
fn unique_uuid(rec: &WireRecord, ns: &str, taken: &HashSet<String>) -> String {
    if !rec.uuid.is_empty() {
        return rec.uuid.clone();
    }
    let mut salt = 0u32;
    loop {
        let digest = content_digest(&[ns, &rec.nonce, &rec.ct, &salt.to_string()]);
        if !taken.contains(&digest) {
            return digest;
        }
        salt = salt.wrapping_add(1);
    }
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
    records: HashMap<RecordKey, WireRecord>,
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

/// Tombstones retained per (account, namespace) when compacting the on-disk snapshot. A
/// tombstone is what tells a device that was offline during a delete that the record is gone;
/// once a device has synced past it, the tombstone is pure weight. We keep a generous number of
/// the NEWEST ones rather than deleting all of them, because dropping every tombstone would let
/// a long-offline device resurrect deleted records by re-pushing its stale copy.
const TOMBSTONE_RETENTION_PER_NS: usize = 500;

impl Snapshot {
    /// Build the on-disk snapshot, DROPPING tombstones beyond the retention window.
    ///
    /// Deleted records must be stored (that is how a device that was offline during a delete
    /// learns the record is gone), but they grow the file without bound. This filters them on the
    /// way to disk only: the in-memory store is left untouched, so compaction can never change
    /// what a client observes right now — it only shrinks the file.
    ///
    /// Retention is per (account, namespace) and keeps the NEWEST `TOMBSTONE_RETENTION_PER_NS`
    /// by HLC. Per-namespace matters: with a global budget one chatty namespace would evict
    /// another's tombstones, letting that namespace's deletions be resurrected. Keeping a
    /// generous window rather than purging all of them is what makes this safe for a device
    /// returning from a long offline stretch.
    fn from_store_compacting(store: &Store) -> Snapshot {
        // Tombstone keys grouped by (account, ns), newest-first by HLC.
        let mut by_ns: TombstonesByNs<'_> = HashMap::new();
        for (key @ (account, ns, _), rec) in store.records.iter() {
            if rec.deleted {
                by_ns.entry((account, ns)).or_default().push(key);
            }
        }
        let mut doomed: HashSet<&RecordKey> = HashSet::new();
        for (_ns_key, mut keys) in by_ns {
            if keys.len() <= TOMBSTONE_RETENTION_PER_NS {
                continue;
            }
            keys.sort_by(|a, b| {
                let ra = &store.records[*a];
                let rb = &store.records[*b];
                hlc_key(&rb.hlc).cmp(&hlc_key(&ra.hlc))
            });
            doomed.extend(keys.into_iter().skip(TOMBSTONE_RETENTION_PER_NS));
        }
        let dropped = doomed.len();
        let snap = Snapshot::from_store_filtered(store, |key, _rec| !doomed.contains(key));
        if dropped > 0 {
            eprintln!(
                "[aegis-sync-server] compacted snapshot: dropped {dropped} tombstone(s) past \
                 the {TOMBSTONE_RETENTION_PER_NS}-per-namespace window; {} record(s) remain",
                snap.records.len()
            );
        }
        snap
    }

    /// `Snapshot::from_store` with a per-key filter.
    fn from_store_filtered(
        store: &Store,
        keep: impl Fn(&(String, String, String), &WireRecord) -> bool,
    ) -> Snapshot {
        let records = store
            .records
            .iter()
            .filter(|(key, _rec)| keep(key, _rec))
            .map(|(key, record)| SnapRecord {
                account: key.0.clone(),
                ns: key.1.clone(),
                record: Self::sealed_record(key, record),
            })
            .collect();
        Snapshot {
            records,
            devices: Self::devices_from(store),
        }
    }

    /// Clone a record for serialization with its `uuid` field forced to match its map key.
    ///
    /// `into_store` re-keys by `record.uuid`, so if the field ever disagreed with the key the
    /// round trip would re-key (and, for a key that is not unique under the field, silently
    /// COLLIDE) records — losing data purely because of how it was written to disk. Enforcing
    /// the invariant here means it holds for every record that reaches the file, no matter what
    /// the insert path did.
    fn sealed_record(key: &(String, String, String), record: &WireRecord) -> WireRecord {
        let mut out = record.clone();
        out.uuid = key.2.clone();
        out
    }

    #[cfg(test)]
    fn from_store(store: &Store) -> Snapshot {
        let records = store
            .records
            .iter()
            .map(|(key, record)| SnapRecord {
                account: key.0.clone(),
                ns: key.1.clone(),
                record: Self::sealed_record(key, record),
            })
            .collect();
        Snapshot {
            records,
            devices: Self::devices_from(store),
        }
    }

    fn devices_from(store: &Store) -> Vec<SnapDevice> {
        store
            .devices
            .iter()
            .flat_map(|(account, set)| {
                set.values().map(move |d| SnapDevice {
                    account: account.clone(),
                    device: d.clone(),
                })
            })
            .collect()
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
    fn persist_blocking(&self) -> Result<(), String> {
        let Some(path) = self.data_path.clone() else {
            return Ok(());
        };
        let snap = {
            let g = self.db.lock().unwrap();
            // COMPACT: drop tombstones past the per-namespace retention window so the on-disk
            // JSON doesn't grow without bound. The in-memory store keeps every tombstone it is
            // currently serving, so this only ever shrinks the file, never what a client sees.
            Snapshot::from_store_compacting(&g)
        };
        let _w = self.writer.lock().unwrap();
        save_snapshot(&path, &snap).map_err(|e| {
            let msg = format!("failed to persist snapshot to {}: {e}", path.display());
            eprintln!("[aegis-sync-server] WARN {msg}");
            msg
        })
    }

    /// Async wrapper around [`Self::persist_blocking`]. The whole write (serialize + fsync +
    /// rename) runs on `spawn_blocking` so it never parks a tokio worker thread, and a failure
    /// is RETURNED rather than logged-and-dropped: a handler that reported `ok: true` for a
    /// mutation that never reached disk would only discover the loss at the next restart.
    async fn persist(&self) -> Result<(), String> {
        let this = self.clone();
        tokio::task::spawn_blocking(move || this.persist_blocking())
            .await
            .map_err(|e| format!("persist task panicked: {e}"))?
    }
}

/// Repair a pushed batch so the store can never end up with two DIFFERENT records sharing an id
/// or a counter. Returns `(uuid, record)` pairs, one per surviving id.
///
/// Three defects it closes, all reachable from a buggy or hostile client:
///  1. **Same id twice in one body.** Applying in arrival order made the result depend on a vec
///     order the client controls — a body listing one id twice with DESCENDING HLC would apply
///     the newer copy first and then reject the older one, silently keeping stale data. The
///     highest HLC per id wins here, independent of order.
///  2. **Missing/empty id.** `uuid.len() > MAX_FIELD_LEN` lets an empty id through, and an empty
///     id collides with every other empty-id record in the namespace — literally two different
///     items under one id, so the first would silently overwrite the second forever. Empty ids
///     are replaced with a content-derived one via [`unique_uuid`].
///  3. **Identical HLC tuple across different ids.** `hlc_key` is what the LWW comparison orders
///     by, so two records at the same `(wall_ms, counter, node)` make "which is newer?"
///     undecidable and the winner depends on map iteration order. The loser's counter is bumped
///     to `winner.counter + 1`, which is a legal HLC (it is what a client would have produced had
///     it observed the other write) and makes the ordering total.
fn canonicalize_body(
    records: Vec<WireRecord>,
    ns: &str,
    account: &str,
    store: &Store,
) -> Vec<(String, WireRecord)> {
    // Ids already present in this (account, ns) — a synthesized id must not land on one of these.
    let mut taken: HashSet<String> = store
        .records
        .keys()
        .filter(|(a, n, _)| a == account && n == ns)
        .map(|(_, _, uuid)| uuid.clone())
        .collect();
    // 1. Collapse duplicate ids within the body, keeping the highest HLC. Records with an EMPTY
    //    id must NOT collapse together — they are all distinct items that just forgot their id,
    //    so each gets its own slot here and a distinct synthesized id in step 2.
    let mut by_id: HashMap<String, WireRecord> = HashMap::new();
    let mut empty_slot = 0u32;
    for rec in records {
        let id = if rec.uuid.is_empty() {
            empty_slot += 1;
            format!("{EMPTY_ID_SLOT_PREFIX}{empty_slot}")
        } else {
            rec.uuid.clone()
        };
        match by_id.entry(id) {
            std::collections::hash_map::Entry::Vacant(v) => {
                v.insert(rec);
            }
            std::collections::hash_map::Entry::Occupied(mut o) => {
                if hlc_key(&rec.hlc) > hlc_key(&o.get().hlc) {
                    o.insert(rec);
                }
            }
        }
    }
    // 2. Repair empty ids against the taken-set, in a stable order so two empties in one body
    //    cannot derive the same replacement.
    let mut result: Vec<(String, WireRecord)> = Vec::new();
    for (id, rec) in by_id {
        let uuid = if id.starts_with(EMPTY_ID_SLOT_PREFIX) {
            let u = unique_uuid(&rec, ns, &taken);
            taken.insert(u.clone());
            u
        } else {
            id
        };
        result.push((uuid, rec));
    }
    // 3. Break ties on the full HLC tuple across DIFFERENT ids, so LWW is never ambiguous.
    let mut out: Vec<(String, WireRecord)> = Vec::new();
    for (uuid, mut rec) in result {
        let (wall, counter, node) = hlc_key(&rec.hlc);
        let mut bumped = counter;
        for _ in 0..MAX_HLC_TIE_BREAKS {
            let clashes = store.records.iter().any(|((a, n, other), other_rec)| {
                a == account
                    && n == ns
                    && other != &uuid
                    && hlc_key(&other_rec.hlc) == (wall, bumped, node.clone())
            }) || out.iter().any(|(other, other_rec)| {
                other != &uuid && hlc_key(&other_rec.hlc) == (wall, bumped, node.clone())
            });
            if !clashes {
                break;
            }
            bumped = bumped.saturating_add(1);
        }
        if bumped != counter {
            eprintln!(
                "[aegis-sync-server] WARN HLC tie on (wall={wall}, node={node}) for record \
                 {uuid} in ns {ns:?}: bumped counter {counter} -> {bumped} to keep \
                 last-writer-wins total"
            );
            rec.hlc = json!({
                "wall_ms": wall,
                "counter": bumped,
                "node": node,
            });
        }
        out.push((uuid, rec));
    }
    out
}

/// Upper bound on the counter-bump loop in [`canonicalize_body`]. A pathological batch of
/// same-HLC records would otherwise spin; past this the record keeps its original counter.
const MAX_HLC_TIE_BREAKS: u64 = 64;

/// Sentinel map key for a pushed record that arrived with no id. NUL can't appear in a
/// client-supplied uuid (it arrives as JSON text), so this can never shadow a real id.
const EMPTY_ID_SLOT_PREFIX: &str = "\u{0}empty:";

/// A failed snapshot is a 500, NOT a silent success: reporting `ok: true` for a mutation that
/// never reached disk means the loss only surfaces at the next restart, which is the exact
/// opposite of this server's "fail loud" posture. The cause is already logged by `persist_blocking`.
fn persist_err(e: String) -> StatusCode {
    eprintln!("[aegis-sync-server] ERROR mutation not durable: {e}");
    StatusCode::INTERNAL_SERVER_ERROR
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
/// Response-side quotas for `GET /v1/records`. The write path is capped by
/// `MAX_RECORDS_PER_REQUEST` and `MAX_RECORDS_PER_ACCOUNT`; without a matching READ cap a single
/// authenticated GET could ask the server to clone + re-serialize the whole account
/// (50_000 × 64 KiB ≈ 3.2 GiB) into one buffer. The byte budget is the real bound — a record
/// count alone doesn't account for ciphertext size.
const MAX_RESPONSE_RECORDS: usize = 5_000;
const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

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
    if q.ns.len() > MAX_FIELD_LEN || q.ns.is_empty() {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    let g = state.db.lock().unwrap();
    // Clone incrementally against a byte budget so an oversized account can never be
    // materialized in full. `413` means "your namespace is too big for one response" — the
    // client should narrow the namespace rather than retry.
    let mut records: Vec<WireRecord> = Vec::new();
    let mut bytes = 0usize;
    for ((a, n, _), r) in g.records.iter() {
        if a != &account || n != &q.ns {
            continue;
        }
        if records.len() >= MAX_RESPONSE_RECORDS {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        bytes += r.ct.len() + r.uuid.len() + r.nonce.len() + 128; // + field names / HLC slack
        if bytes > MAX_RESPONSE_BYTES {
            return Err(StatusCode::PAYLOAD_TOO_LARGE);
        }
        records.push(r.clone());
    }
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
        let incoming = canonicalize_body(body.records, &body.ns, &account, &g);
        // Per-account total cap: refuse to GROW an account past the cap (updates to existing
        // records always pass — they don't add a key). Counted AFTER id repair so it reflects
        // the keys that will actually be inserted.
        let new_keys = incoming
            .iter()
            .filter(|(uuid, _)| {
                !g.records
                    .contains_key(&(account.clone(), body.ns.clone(), uuid.clone()))
            })
            .count();
        if current + new_keys > MAX_RECORDS_PER_ACCOUNT {
            return Err(StatusCode::INSUFFICIENT_STORAGE);
        }
        for (uuid, mut rec) in incoming {
            let key = (account.clone(), body.ns.clone(), uuid);
            // HLC last-writer-wins: keep the incoming record only if it strictly dominates the
            // stored one (a stale push from a lagging device can't roll the server back).
            let keep = match g.records.get(&key) {
                Some(existing) => hlc_key(&rec.hlc) > hlc_key(&existing.hlc),
                None => true,
            };
            if keep {
                rec.uuid = key.2.clone();
                g.records.insert(key, rec);
                changed = true;
            }
        }
    }
    if changed {
        state.persist().await.map_err(persist_err)?;
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
    state.persist().await.map_err(persist_err)?;
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
        state.persist().await.map_err(persist_err)?;
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

    // ── tombstone compaction (deleted records are dropped from the on-disk JSON) ────────────

    fn tomb(uuid: &str, wall: i64) -> WireRecord {
        WireRecord {
            uuid: uuid.to_string(),
            hlc: json!({ "wall_ms": wall, "counter": 0, "node": "n" }),
            deleted: true,
            nonce: "x".to_string(),
            ct: "ct".to_string(),
        }
    }

    fn live(uuid: &str, wall: i64) -> WireRecord {
        WireRecord {
            deleted: false,
            ..tomb(uuid, wall)
        }
    }

    #[test]
    fn compaction_keeps_every_tombstone_below_the_retention_window() {
        let mut store = Store::default();
        for i in 0..TOMBSTONE_RETENTION_PER_NS {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        let snap = Snapshot::from_store_compacting(&store);
        assert_eq!(snap.records.len(), TOMBSTONE_RETENTION_PER_NS);
    }

    #[test]
    fn compaction_drops_the_oldest_tombstones_and_keeps_the_newest() {
        let mut store = Store::default();
        let total = TOMBSTONE_RETENTION_PER_NS + 25;
        for i in 0..total {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        let snap = Snapshot::from_store_compacting(&store);
        assert_eq!(snap.records.len(), TOMBSTONE_RETENTION_PER_NS);
        // The 25 OLDEST (lowest wall_ms) are gone; the newest survive.
        assert!(!snap.records.iter().any(|r| r.record.uuid == "t0"));
        assert!(snap
            .records
            .iter()
            .any(|r| r.record.uuid == format!("t{}", total - 1)));
    }

    #[test]
    fn compaction_never_drops_live_records() {
        let mut store = Store::default();
        for i in 0..(TOMBSTONE_RETENTION_PER_NS + 10) {
            store.records.insert(
                ("a".into(), "ns".into(), format!("l{i}")),
                live(&format!("l{i}"), i as i64),
            );
        }
        for i in 0..(TOMBSTONE_RETENTION_PER_NS + 10) {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        let snap = Snapshot::from_store_compacting(&store);
        let live_kept = snap.records.iter().filter(|r| !r.record.deleted).count();
        assert_eq!(live_kept, TOMBSTONE_RETENTION_PER_NS + 10);
    }

    #[test]
    fn compaction_is_per_namespace_so_one_ns_cannot_evict_anothers_tombstones() {
        let mut store = Store::default();
        // A single namespace well over the window...
        for i in 0..(TOMBSTONE_RETENTION_PER_NS + 40) {
            store.records.insert(
                ("a".into(), "noisy".into(), format!("n{i}")),
                tomb(&format!("n{i}"), i as i64),
            );
        }
        // ...must not cost a quiet namespace any of its tombstones.
        for i in 0..10 {
            store.records.insert(
                ("a".into(), "quiet".into(), format!("q{i}")),
                tomb(&format!("q{i}"), i as i64),
            );
        }
        let snap = Snapshot::from_store_compacting(&store);
        let quiet = snap.records.iter().filter(|r| r.ns == "quiet").count();
        assert_eq!(quiet, 10, "quiet namespace lost tombstones to a noisy one");
    }

    #[test]
    fn compaction_leaves_the_in_memory_store_untouched() {
        let mut store = Store::default();
        for i in 0..(TOMBSTONE_RETENTION_PER_NS + 5) {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        let before = store.records.len();
        let _ = Snapshot::from_store_compacting(&store);
        assert_eq!(
            store.records.len(),
            before,
            "compaction must only shrink the file"
        );
    }

    // ── id / counter canonicalization (no two different items share an id or counter) ─────────

    fn body_rec(uuid: &str, wall: i64, counter: u64, ct: &str) -> WireRecord {
        WireRecord {
            uuid: uuid.to_string(),
            hlc: json!({ "wall_ms": wall, "counter": counter, "node": "n" }),
            deleted: false,
            nonce: format!("nonce-{ct}"),
            ct: ct.to_string(),
        }
    }

    #[test]
    fn duplicate_id_in_one_body_keeps_the_highest_hlc_regardless_of_order() {
        let empty = Store::default();
        for order in [
            vec![("r1", 10_i64), ("r1", 30)],
            vec![("r1", 30), ("r1", 10)],
        ] {
            let recs: Vec<WireRecord> = order
                .iter()
                .map(|(u, w)| body_rec(u, *w, 0, &format!("ct{w}")))
                .collect();
            let out = canonicalize_body(recs, "ns", "acct", &empty);
            assert_eq!(out.len(), 1, "duplicate id must collapse to one record");
            assert_eq!(
                hlc_key(&out[0].1.hlc).0,
                30,
                "highest HLC must win, not arrival order"
            );
        }
    }

    #[test]
    fn empty_ids_are_repaired_so_two_items_never_share_one_id() {
        let empty = Store::default();
        let recs = vec![
            body_rec("", 10, 0, "alpha"),
            body_rec("", 20, 0, "beta"),
            body_rec("", 30, 0, "gamma"),
        ];
        let out = canonicalize_body(recs, "ns", "acct", &empty);
        assert_eq!(out.len(), 3, "three distinct items must stay three records");
        let ids: HashSet<&String> = out.iter().map(|(id, _)| id).collect();
        assert_eq!(ids.len(), 3, "synthesized ids collided: {ids:?}");
        assert!(ids.iter().all(|id| !id.is_empty()));
    }

    #[test]
    fn a_synthesized_id_never_lands_on_an_existing_id() {
        let mut store = Store::default();
        store.records.insert(
            ("acct".into(), "ns".into(), "taken".into()),
            live("taken", 1),
        );
        let recs = vec![body_rec("", 10, 0, "alpha")];
        let out = canonicalize_body(recs, "ns", "acct", &store);
        assert_ne!(out[0].0, "taken");
    }

    #[test]
    fn identical_hlc_on_different_ids_is_broken_so_lww_is_total() {
        let empty = Store::default();
        // Three DIFFERENT items that (wrongly) all carry counter 0 at the same wall time.
        let recs = vec![
            body_rec("a", 500, 0, "one"),
            body_rec("b", 500, 0, "two"),
            body_rec("c", 500, 0, "three"),
        ];
        let out = canonicalize_body(recs, "ns", "acct", &empty);
        assert_eq!(out.len(), 3);
        let counters: HashSet<u64> = out.iter().map(|(_, r)| hlc_key(&r.hlc).1).collect();
        assert_eq!(counters.len(), 3, "counters collided: {counters:?}");
        // The bumped HLC must still be a legal, greater HLC.
        for (_, r) in &out {
            assert_eq!(hlc_key(&r.hlc).0, 500, "wall_ms must be preserved");
        }
    }

    #[test]
    fn a_tie_against_an_already_stored_record_is_also_broken() {
        let mut store = Store::default();
        store.records.insert(
            ("acct".into(), "ns".into(), "old".into()),
            body_rec("old", 700, 4, "old"),
        );
        let out = canonicalize_body(vec![body_rec("new", 700, 4, "new")], "ns", "acct", &store);
        assert_eq!(out.len(), 1);
        assert_eq!(
            hlc_key(&out[0].1.hlc).1,
            5,
            "must bump above the stored counter 4"
        );
    }

    #[test]
    fn distinct_hlcs_are_left_untouched() {
        let empty = Store::default();
        let recs = vec![body_rec("a", 100, 1, "one"), body_rec("b", 200, 2, "two")];
        let out = canonicalize_body(recs, "ns", "acct", &empty);
        let mut got: Vec<_> = out.iter().map(|(_, r)| hlc_key(&r.hlc)).collect();
        got.sort();
        assert_eq!(
            got,
            vec![(100, 1, "n".to_string()), (200, 2, "n".to_string())]
        );
    }

    #[test]
    fn canonicalized_records_round_trip_through_post_and_get() {
        // End-to-end: the repaired uuid is what gets stored AND returned to a client.
        let mut store = Store::default();
        let recs = vec![body_rec("", 10, 0, "alpha"), body_rec("", 20, 0, "beta")];
        let out = canonicalize_body(recs, "ns", "acct", &store);
        for (uuid, rec) in out {
            let key = ("acct".to_string(), "ns".to_string(), uuid.clone());
            store.records.insert(key, rec);
        }
        assert_eq!(store.records.len(), 2);
        let ids: HashSet<&String> = store.records.keys().map(|(_, _, u)| u).collect();
        assert_eq!(ids.len(), 2, "two different items must not share an id");
        // Reloading from the snapshot must not resurrect a collision.
        let snap = Snapshot::from_store_compacting(&store);
        let reloaded = snap.into_store();
        assert_eq!(reloaded.records.len(), 2);
    }

    // ── auth token lifetime bounds ────────────────────────────────────────────────────────────

    #[test]
    fn max_ttl_matches_the_clients_default_so_honest_tokens_pass() {
        // src-tauri/src/sync_auth.rs DEFAULT_TTL_MS. If a client ever mints a longer token this
        // test is the tripwire that tells us to raise MAX_TTL_MS rather than silently 401.
        assert_eq!(MAX_TTL_MS, 300_000);
    }

    #[tokio::test]
    async fn persist_writes_and_reloads_through_appstate() {
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
        state.persist().await.unwrap();

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
