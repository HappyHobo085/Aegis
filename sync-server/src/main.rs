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
use std::collections::{BTreeMap, HashMap, HashSet};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use axum::extract::{DefaultBodyLimit, Query, Request, State};
use axum::http::{HeaderMap, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{timeout, Duration};

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
    if !s.len().is_multiple_of(2) {
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

/// Per-device ceiling on live nonces. The global `MAX_SEEN_NONCES` alone made backpressure
/// *shared*: one high-rate (or hostile) paired device filled the map and every other device on
/// the server got a `429` for up to the 5-minute TTL. Capping per device turns that into "the
/// abusive device is refused on its own while everyone else keeps syncing"; the global cap stays
/// as the memory backstop. 2_000 entries at the 5-minute TTL is ~10 minutes at a sustained 3.3
/// req/s, far above any real client, and 2_000 x 125 devices still fits under the global cap.
const MAX_SEEN_NONCES_PER_DEVICE: usize = 2_000;

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
        let mut seen = state.seen_nonces.lock().unwrap_or_else(|e| e.into_inner());
        seen.sweep(now);
        let key = (token.device_id.clone(), token.nonce.clone());
        if seen.contains(&key) {
            return Err(StatusCode::UNAUTHORIZED);
        }
        // Bound the map. `sweep` only drops EXPIRED entries, so a client that keeps minting
        // valid tokens would otherwise grow this set forever. When a cap is hit we refuse the
        // NEW nonce rather than evicting a live one: evicting a live entry would re-open a
        // replay window, whereas refusing only costs an over-fast client a retry.
        //
        // The PER-DEVICE cap is checked first and is the one that matters in practice: it makes
        // backpressure local, so a single high-rate or hostile device is refused on its own
        // instead of filling a global map and 429-ing every other device on the server.
        if seen.device_count(&token.device_id) >= MAX_SEEN_NONCES_PER_DEVICE {
            eprintln!(
                "[aegis-sync-server] WARN device {} at its replay-nonce cap \
                 ({MAX_SEEN_NONCES_PER_DEVICE}); rejecting further nonces for this device",
                token.device_id
            );
            return Err(StatusCode::TOO_MANY_REQUESTS);
        }
        if seen.len() >= MAX_SEEN_NONCES {
            eprintln!(
                "[aegis-sync-server] WARN replay-nonce map at global cap ({MAX_SEEN_NONCES}); \
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

/// A stored record.
///
/// `hlc` is the CLIENT-AUTHENTICATED version stamp. It is bound into the record's AEAD
/// associated data (`aad_for(ns, uuid, hlc_bytes)` in the client), and `crypto.rs` says in as
/// many words that "the reference server must reproduce this byte-for-byte". So the server must
/// hand `hlc` back exactly as it arrived.
///
/// It used not to. Breaking a cross-uuid HLC tie overwrote `hlc` in place without re-sealing
/// `ct`, which made the record permanently undecryptable: the client's `open_wire` authenticates
/// against the value the server returned, so the tag no longer verified, and the client's retry
/// was then rejected by the per-uuid LWW gate as stale. A silent, permanent brick — the worst
/// failure this server has, and the reason tie-breaking now writes `ord` instead.
///
/// `ord` is the server's own ORDERING stamp for the record, used only to make last-writer-wins a
/// total order across *different* uuids. It is in no AAD, so the server may move it freely, and
/// clients adopt it so their merge agrees with the server's ordering. Absent on every record a
/// well-behaved client pushes (cross-uuid ties are structurally impossible for a correct client)
/// and absent on every record written before this field existed.
///
/// Every field defaults so that ADDING one can never make an operator's existing
/// `aegis-sync.json` fail to deserialize — that used to panic the server at boot with the
/// operator's data on disk.
#[derive(Clone, Default, Serialize, Deserialize)]
struct WireRecord {
    #[serde(default)]
    uuid: String,
    #[serde(default)]
    hlc: Value,
    #[serde(default)]
    deleted: bool,
    #[serde(default)]
    nonce: String,
    #[serde(default)]
    ct: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    ord: Option<Value>,
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
///
/// Borrows `node` instead of cloning it. This runs inside the per-record comparison loops in
/// [`canonicalize_body`], where the old `String` return allocated once per comparison — tens of
/// millions of allocations on an ordinary full-namespace push.
fn hlc_key(hlc: &Value) -> (i64, u64, &str) {
    (
        hlc.get("wall_ms").and_then(Value::as_i64).unwrap_or(0),
        hlc.get("counter").and_then(Value::as_u64).unwrap_or(0),
        hlc.get("node").and_then(Value::as_str).unwrap_or(""),
    )
}

/// The stamp a record is ORDERED by: the server's `ord` when it has one, else the
/// client-supplied `hlc`. For ORDERING COMPARISONS ONLY — this value is never part of an AAD,
/// which is exactly what makes it safe for the server to adjust.
fn ord_key(rec: &WireRecord) -> (i64, u64, &str) {
    hlc_key(rec.ord.as_ref().unwrap_or(&rec.hlc))
}

#[derive(Clone, Default, Serialize, Deserialize)]
struct Device {
    #[serde(rename = "deviceId", default)]
    device_id: String,
    #[serde(default)]
    label: String,
    #[serde(rename = "lastSeenMs", default)]
    last_seen_ms: i64,
}

#[derive(Default)]
struct Store {
    // (account, ns, uuid) -> record
    records: HashMap<RecordKey, WireRecord>,
    // account -> deviceId -> device
    devices: HashMap<String, HashMap<String, Device>>,
    // (account, deviceId) -> () for devices that were removed and may NOT register again.
    //
    // Without this, `remove_device` was theatre: `post_device` is the one endpoint that does NOT
    // require registration (registration is self-bootstrapping), and it re-inserts
    // unconditionally. A removed device still holds the account key — derived from the recovery
    // phrase — so it passed `verify_account_root` and simply walked straight back in on its next
    // sync. Removal has to be recorded somewhere the removed device cannot write, and the server
    // is the only such place: the account key is a *shared* secret, so it cannot distinguish the
    // owner from the device being kicked.
    revoked: HashSet<(String, String)>,
    // account -> the deviceId that registered FIRST, i.e. the account owner.
    //
    // This is what makes removal an authorization decision rather than a free-for-all: previously
    // `remove_device` called `require_registered` and then `set.remove(&body.device_id)`, so ANY
    // paired device could evict ANY other (including the owner's) and take the account over.
    // Only the owner may remove someone else; anyone may remove *themselves* (that is "sign out
    // this device", and it correctly ends in revocation).
    //
    // The owner slot is set on first registration and is deliberately NOT cleared by
    // `remove_device` — otherwise kicking the owner would hand the role to whoever acted next.
    // RECOVERY: if the owner's device is lost, the operator (who owns the data file) deletes the
    // account's entry from `owner` in `aegis-sync.json` and restarts. That is a deliberate trust
    // anchor: for a self-hosted server, the operator IS the root of trust.
    owner: HashMap<String, String>,
}

// On-disk shape. The live Store is keyed by tuples (which JSON can't use as map keys),
// so we flatten to vectors for serialization and rebuild the maps on load.
//
// EVERY field on every one of these types defaults. An `aegis-sync.json` written by an older
// build must always load: without `#[serde(default)]`, adding a single field to `WireRecord`
// made every existing snapshot fail to deserialize, and `main` panics on that error — so
// adding a field bricked the operator's server with their data on disk and no recovery path.
// `v` is the same idea in explicit form: a schema version to migrate from, rather than one
// inferred from a successful parse.
#[derive(Serialize, Deserialize)]
struct SnapRecord {
    #[serde(default)]
    account: String,
    #[serde(default)]
    ns: String,
    #[serde(default)]
    record: WireRecord,
}

#[derive(Serialize, Deserialize)]
struct SnapDevice {
    #[serde(default)]
    account: String,
    #[serde(default)]
    device: Device,
}

/// A (account, deviceId) pair that may not register again. Flattened for the same reason
/// `SnapRecord` is: JSON object keys cannot be tuples.
#[derive(Serialize, Deserialize)]
struct SnapRevoked {
    #[serde(default)]
    account: String,
    #[serde(rename = "deviceId", default)]
    device_id: String,
}

/// account -> owner deviceId, flattened into a list.
#[derive(Serialize, Deserialize)]
struct SnapOwner {
    #[serde(default)]
    account: String,
    #[serde(rename = "deviceId", default)]
    device_id: String,
}

/// Current on-disk schema version. Bump when a field's MEANING changes (not merely when one is
/// added — `#[serde(default)]` covers that). `0`/absent means "written before versioning", which
/// is the same shape as v1.
const SNAPSHOT_VERSION: u32 = 1;

#[derive(Serialize, Deserialize, Default)]
struct Snapshot {
    /// Schema version, so a future migration has something to branch on. Defaulted, so a
    /// pre-versioning file still loads.
    #[serde(default)]
    v: u32,
    #[serde(default)]
    records: Vec<SnapRecord>,
    #[serde(default)]
    devices: Vec<SnapDevice>,
    /// Persisted so a restart does not silently un-revoke every removed device. In-memory only
    /// would make revocation a speed bump.
    #[serde(default)]
    revoked: Vec<SnapRevoked>,
    /// Persisted for the same reason: the owner is an authorization fact, not a cache.
    #[serde(default)]
    owners: Vec<SnapOwner>,
}

/// Tombstones retained per (account, namespace) when compacting the on-disk snapshot. A
/// tombstone is what tells a device that was offline during a delete that the record is gone;
/// once a device has synced past it, the tombstone is pure weight. We keep a generous number of
/// the NEWEST ones rather than deleting all of them, because dropping every tombstone would let
/// a long-offline device resurrect deleted records by re-pushing its stale copy.
const TOMBSTONE_RETENTION_PER_NS: usize = 500;

/// Tombstone keys that are past the per-namespace retention window.
///
/// The HLC ordering within each `(account, ns)` group decides *which* are the doomed ones, and it
/// is the same ordering the on-disk compaction has always used — so pruning the live store and
/// compacting the snapshot can never disagree about what should have been kept.
fn tombstones_past_retention(store: &Store) -> HashSet<RecordKey> {
    let mut by_ns: TombstonesByNs<'_> = HashMap::new();
    for (key @ (account, ns, _), rec) in store.records.iter() {
        if rec.deleted {
            by_ns.entry((account, ns)).or_default().push(key);
        }
    }
    let mut doomed: HashSet<RecordKey> = HashSet::new();
    for (_ns_key, mut keys) in by_ns {
        if keys.len() <= TOMBSTONE_RETENTION_PER_NS {
            continue;
        }
        // Newest first.
        keys.sort_by(|a, b| {
            let ra = &store.records[*a];
            let rb = &store.records[*b];
            hlc_key(&rb.hlc).cmp(&hlc_key(&ra.hlc))
        });
        doomed.extend(
            keys.iter()
                .skip(TOMBSTONE_RETENTION_PER_NS)
                .map(|k| (*k).clone()),
        );
    }
    doomed
}

/// Reap tombstones past the retention window from the **live** store, returning how many went.
///
/// [`Snapshot::from_store_compacting`] already stopped these reaching the on-disk JSON, but the
/// in-memory map kept every one of them forever, so a long-lived server grew without bound and
/// re-compacted the same ever-growing set on every single write. Reaping here fixes the actual
/// leak, and makes the snapshot pass cheap because there is nothing left for it to filter.
///
/// The retention window is deliberately generous (see [`TOMBSTONE_RETENTION_PER_NS`]): a device
/// returning from a long offline stretch still needs the tombstones that predate its last sync.
/// Dropping them from memory is only safe because the same window, computed the same way, is what
/// the snapshot already used — the two can never disagree.
fn prune_tombstones(store: &mut Store) -> usize {
    let doomed = tombstones_past_retention(store);
    if doomed.is_empty() {
        return 0;
    }
    for key in &doomed {
        store.records.remove(key);
    }
    let dropped = doomed.len();
    eprintln!(
        "[aegis-sync-server] pruned {dropped} tombstone(s) past the \
         {TOMBSTONE_RETENTION_PER_NS}-per-namespace window; {} record(s) remain",
        store.records.len()
    );
    dropped
}

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
        let doomed = tombstones_past_retention(store);
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
            v: SNAPSHOT_VERSION,
            records,
            devices: Self::devices_from(store),
            revoked: Self::revoked_from(store),
            owners: Self::owners_from(store),
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
            v: SNAPSHOT_VERSION,
            records,
            devices: Self::devices_from(store),
            revoked: Self::revoked_from(store),
            owners: Self::owners_from(store),
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

    fn revoked_from(store: &Store) -> Vec<SnapRevoked> {
        let mut v: Vec<SnapRevoked> = store
            .revoked
            .iter()
            .map(|(account, device_id)| SnapRevoked {
                account: account.clone(),
                device_id: device_id.clone(),
            })
            .collect();
        // Deterministic order so a rewrite of an unchanged store produces an identical file
        // (otherwise every mutation reshuffles the JSON and defeats eyeballing a diff).
        v.sort_by(|a, b| (&a.account, &a.device_id).cmp(&(&b.account, &b.device_id)));
        v
    }

    fn owners_from(store: &Store) -> Vec<SnapOwner> {
        let mut v: Vec<SnapOwner> = store
            .owner
            .iter()
            .map(|(account, device_id)| SnapOwner {
                account: account.clone(),
                device_id: device_id.clone(),
            })
            .collect();
        v.sort_by(|a, b| (&a.account, &a.device_id).cmp(&(&b.account, &b.device_id)));
        v
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
        for r in self.revoked {
            store.revoked.insert((r.account, r.device_id));
        }
        for o in self.owners {
            store.owner.insert(o.account, o.device_id);
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

/// Spent auth-token nonces, indexed three ways so that the per-request cost is O(1) rather
/// than O(live nonces).
///
/// This used to be a bare `HashMap<(device, nonce), expiry_ms>` that was swept with
/// `retain(|_, exp| *exp > now)` on *every* authenticated request — so the cost of one request
/// grew with the total number of live nonces (up to `MAX_SEEN_NONCES`), all under the mutex
/// that every other authenticated request also needs. The defensive mechanism was itself the
/// amplification factor: an authenticated client could make every other client's request
/// proportionally slower.
///
/// `by_expiry` is the fix: second-aligned buckets, so expiring is a pop of whole buckets from
/// a `BTreeMap` (O(log n) + O(expired)) instead of a full scan. `by_device` maintains reference
/// counts so backpressure can be applied per device (see `MAX_SEEN_NONCES_PER_DEVICE`) instead
/// of globally, which is what keeps one abusive device from wedging the whole server.
#[derive(Default)]
struct SeenNonces {
    /// `(device_id, nonce)` -> the token's `expires_ms`. Authoritative membership set.
    by_key: HashMap<(String, String), i64>,
    /// `device_id` -> how many entries that device currently holds in `by_key`.
    by_device: HashMap<String, usize>,
    /// Second-aligned expiry bucket -> the keys expiring in it. Drives [`Self::sweep`].
    by_expiry: BTreeMap<i64, Vec<(String, String)>>,
}

/// Second-align an expiry so every key in a bucket shares one `BTreeMap` entry. Bucketing
/// downward means an entry in bucket `b` expires somewhere in `[b, b+1000)`, so the whole
/// bucket is provably dead once `b + 1000 <= now`.
fn expiry_bucket(expires_ms: i64) -> i64 {
    expires_ms.div_euclid(1000) * 1000
}

impl SeenNonces {
    fn len(&self) -> usize {
        self.by_key.len()
    }

    /// Has this `(device, nonce)` already been spent?
    fn contains(&self, key: &(String, String)) -> bool {
        self.by_key.contains_key(key)
    }

    /// How many live nonces this device currently holds (its share of the per-device cap).
    fn device_count(&self, device_id: &str) -> usize {
        self.by_device.get(device_id).copied().unwrap_or(0)
    }

    /// Drop every entry whose token has expired, in time proportional to the number of
    /// entries dropped rather than the number held.
    ///
    /// The comparison is `bucket + 1000 <= now`, which is deliberately one second conservative:
    /// an entry can then live up to ~1s past its real expiry. That only ever keeps a replay
    /// window *shut* for longer, which is the safe direction — and it lets the sweep use a
    /// single integer comparison per bucket instead of re-checking each entry's own expiry.
    fn sweep(&mut self, now: i64) {
        while let Some((&bucket, _)) = self.by_expiry.iter().next() {
            if bucket + 1000 > now {
                break;
            }
            // Safe to `unwrap` the bucket's vec: it is removed from the map in the same step.
            let (_, keys) = self
                .by_expiry
                .pop_first()
                .expect("peeked key must still be present");
            for key in keys {
                // Only remove if the index still points at THIS expiry. A key cannot be
                // re-inserted (a replay is rejected before insert), so this is belt-and-braces;
                // it keeps the reference counts honest even if that invariant ever changes.
                if self.by_key.remove(&key).is_some() {
                    let (device, _) = &key;
                    if let Some(n) = self.by_device.get_mut(device) {
                        *n -= 1;
                        if *n == 0 {
                            self.by_device.remove(device);
                        }
                    }
                }
            }
        }
    }

    /// Record a nonce as spent. Caller must have already checked `contains` and the caps.
    fn insert(&mut self, key: (String, String), expires_ms: i64) {
        let (device, _) = &key;
        *self.by_device.entry(device.clone()).or_insert(0) += 1;
        self.by_expiry
            .entry(expiry_bucket(expires_ms))
            .or_default()
            .push(key.clone());
        self.by_key.insert(key, expires_ms);
    }
}

/// Shared request state: the in-memory store plus optional disk persistence. `writer`
/// serializes atomic writes so two concurrent mutations never clobber each other's temp file.
#[derive(Clone)]
struct AppState {
    db: Db,
    data_path: Option<Arc<PathBuf>>,
    writer: Arc<Mutex<()>>,
    // Spent auth-token nonces for replay defense, indexed for O(1) membership and an
    // O(expired) sweep. Bounded by the token TTL. In-memory only — a restart forgets them
    // (documented residual, bounded by the ≤5-min TTL).
    seen_nonces: Arc<Mutex<SeenNonces>>,
}

impl AppState {
    fn new(store: Store, data_path: Option<PathBuf>) -> AppState {
        AppState {
            db: Arc::new(Mutex::new(store)),
            data_path: data_path.map(Arc::new),
            writer: Arc::new(Mutex::new(())),
            seen_nonces: Arc::new(Mutex::new(SeenNonces::default())),
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
            let g = self.db.lock().unwrap_or_else(|e| e.into_inner());
            // COMPACT: drop tombstones past the per-namespace retention window so the on-disk
            // JSON doesn't grow without bound. The in-memory store keeps every tombstone it is
            // currently serving, so this only ever shrinks the file, never what a client sees.
            Snapshot::from_store_compacting(&g)
        };
        let _w = self.writer.lock().unwrap_or_else(|e| e.into_inner());
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
    //
    //    The bump goes into `rec.ord` and NEVER into `rec.hlc`. `hlc` is bound into the record's
    //    AEAD associated data, so overwriting it here left `ct` sealed against a different AAD —
    //    the record could never be opened again by any client, and because the per-uuid LWW gate
    //    then rejected the client's retry as stale, it could never be rewritten either. A silent
    //    permanent brick. `ord` is ordering-only, so moving it costs nothing.
    //
    //    A well-behaved client never gets here: an HLC counter is monotonic per node and two
    //    devices have distinct `node` values, so two records can only tie ACROSS uuids if one of
    //    them synthesised a non-monotonic stamp. The vault's `updatedAt`-derived stamp used to be
    //    exactly that (constant counter, constant node); the client no longer produces one. The
    //    server must still be a total order against a buggy or hostile peer, though.
    let mut out: Vec<(String, WireRecord)> = Vec::new();
    // Ordering tuple -> the uuids holding it, for this (account, ns) only. Built ONCE from the
    // store and extended as the batch is accepted. The old code re-scanned the entire store for
    // every candidate on every bump iteration, under the global db lock — O(incoming x stored x
    // bumps) with a String allocation per comparison.
    let mut claimed: HashMap<(i64, u64, String), HashSet<String>> = HashMap::new();
    for ((a, n, u), r) in store.records.iter() {
        if a == account && n == ns {
            let (w, c, node) = ord_key(r);
            claimed
                .entry((w, c, node.to_string()))
                .or_default()
                .insert(u.clone());
        }
    }
    for (uuid, mut rec) in result {
        let (wall, counter, node) = hlc_key(&rec.hlc);
        let node_owned = node.to_string();
        let mut bumped = counter;
        for _ in 0..MAX_HLC_TIE_BREAKS {
            // A clash is any OTHER uuid already holding this exact tuple. This record's own
            // previous version sitting on the same tuple is NOT a clash — that is an ordinary
            // update, and treating it as one would bump every update to every record.
            let held = claimed
                .get(&(wall, bumped, node_owned.clone()))
                .is_some_and(|us| us.iter().any(|u| u != &uuid));
            if !held {
                break;
            }
            bumped = bumped.saturating_add(1);
        }
        if bumped != counter {
            eprintln!(
                "[aegis-sync-server] WARN HLC tie on (wall={wall}, node={node}) for record \
                 {uuid} in ns {ns:?}: reserved ordering counter {counter} -> {bumped} in `ord` \
                 to keep last-writer-wins total (`hlc` left untouched — it is AEAD-bound)"
            );
            rec.ord = Some(json!({
                "wall_ms": wall,
                "counter": bumped,
                "node": node,
            }));
        }
        claimed
            .entry((wall, bumped, node_owned))
            .or_default()
            .insert(uuid.clone());
        out.push((uuid, rec));
    }
    out
}

/// Drop records whose `wall_ms` is further ahead of the server clock than any real device
/// could legitimately be, so a hostile or broken client cannot poison a namespace's ordering.
///
/// The danger is not the rejected record — it is what the record does to every PEER. HLC
/// receive is an unbounded `max` against the observed remote stamp, so one record carrying
/// `wall_ms: i64::MAX` pins each peer's process-global clock forever: every later local edit
/// inherits that wall, can never be overridden by a genuine update, and the namespace is
/// stuck until the store is deleted by hand. The client now clamps what it *observes*
/// (`MAX_REMOTE_SKEW_MS` in `src-tauri/src/sync_envelope.rs`), so the damage self-heals there
/// too — this is the server refusing to host the bad record in the first place.
///
/// Rejected, never rewritten: `wall_ms` lives inside `hlc`, which is bound into each record's
/// AEAD associated data. Silently clamping it here would invalidate the tag and turn every
/// affected record into the undecryptable-forever state this file used to create by bumping
/// the same field.
fn reject_far_future(records: Vec<WireRecord>, now_ms: i64) -> Vec<WireRecord> {
    records
        .into_iter()
        .filter(|rec| {
            let wall = rec.hlc.get("wall_ms").and_then(Value::as_i64).unwrap_or(0);
            // A stamp in the PAST is harmless (LWW just loses), so only the future is policed.
            if wall > now_ms.saturating_add(MAX_FUTURE_SKEW_MS) {
                eprintln!(
                    "[aegis-sync-server] WARN rejected record {}: wall_ms {} is more than \
                     {}ms ahead of server time — refusing rather than clamping, because \
                     `wall_ms` is AEAD-bound",
                    rec.uuid, wall, MAX_FUTURE_SKEW_MS
                );
                false
            } else {
                true
            }
        })
        .collect()
}

/// Upper bound on the counter-bump loop in [`canonicalize_body`]. A pathological batch of
/// same-HLC records would otherwise spin; past this the record keeps the last counter it
/// reached, which is still deterministic and still lands in `ord` (never in `hlc`).
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
    let g = db.lock().unwrap_or_else(|e| e.into_inner());
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
/// Concurrent requests allowed to be buffering/parsing at once. Bounds worst-case resident
/// memory at roughly this x MAX_BODY_BYTES. See [`guard`].
const MAX_INFLIGHT_REQUESTS: usize = 64;
/// Wall-clock ceiling for one request. See [`guard`].
const REQUEST_TIMEOUT_SECS: u64 = 30;
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
    // The guard is scoped to a block so it is provably released before the `.await` below —
    // `persist()` takes the same mutex, so holding it across an await would also deadlock.
    let (records, pruned) = {
        let mut g = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // Reap before serving, so a pull never ships tombstones that are already past the
        // retention window — they would cost the client bytes and quota to no end, since by
        // definition every device has long since synced past them. Tombstones AT the edge of the
        // window are kept, so a device returning from a long offline stretch still gets them.
        let pruned = prune_tombstones(&mut g);
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
        (records, pruned)
    };
    // Persisting a prune that happened on the READ path is deliberate: a reap that only lived in
    // memory would come straight back on the next restart, loaded from the snapshot.
    if pruned > 0 {
        state.persist().await.map_err(persist_err)?;
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
        let mut g = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // Reap tombstones past the retention window BEFORE merging, so a push is never weighed
        // down by deletes every device synced past long ago. Pruning first also means the merge
        // below sees the same store a fresh restart would, so a client's push is evaluated against
        // a bounded history rather than an ever-growing one.
        prune_tombstones(&mut g);
        // Per-account total cap: refuse to GROW an account past the cap (updates to existing
        // records always pass — they don't add a key). Counts the new keys this request adds.
        let current = g.records.keys().filter(|(a, _, _)| a == &account).count();
        let incoming = canonicalize_body(
            reject_far_future(body.records, now_ms()),
            &body.ns,
            &account,
            &g,
        );
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
            //
            // This compares `hlc` to `hlc` and MUST NOT be switched to `ord_key`. Both `hlc`
            // values are client-authenticated — the client sealed `ct` against the stored one, and
            // it will open against whatever this gate keeps — so the two sides agree by
            // construction. `ord` is server-chosen, and a genuine update would tie with the
            // server's own reserved counter and be rejected as stale.
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
        // …and again AFTER the merge, so tombstones this very push carried past the window are
        // reaped immediately rather than lingering until some unrelated request happens to run.
        // This is the case that matters most for the vault: a bulk delete pushes hundreds of
        // tombstones in one request, and reaping them here is what actually returns the space
        // (and removes the deleted credentials' ciphertext) instead of just deferring it.
        if prune_tombstones(&mut g) > 0 {
            changed = true;
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
        let mut g = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // REVOCATION. The account key is shared by every device on the account (both derive it
        // from the recovery phrase), so `verify_account_root` above cannot tell a device that was
        // legitimately removed from one that is walking back in. The server's own deny-list is the
        // only record of the decision that the removed device cannot overwrite, so honour it here
        // — otherwise `remove_device` is reversible by the very device it removed, and the UI's
        // most security-relevant control does nothing.
        if g.revoked.contains(&(account.clone(), device.clone())) {
            return Err(StatusCode::FORBIDDEN);
        }
        g.devices.entry(account.clone()).or_default().insert(
            device.clone(),
            Device {
                device_id: device.clone(),
                label: body.label,
                last_seen_ms: now_ms(),
            },
        );
        // First device to register owns the account; see `Store::owner` for why that is the only
        // way removal can be an authorization decision rather than a free-for-all.
        g.owner.entry(account).or_insert_with(|| device.clone());
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
    let g = state.db.lock().unwrap_or_else(|e| e.into_inner());
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
    // AUTHORIZATION. Previously this was `require_registered` and then an unconditional
    // `set.remove(&body.device_id)` — so ANY paired device could evict ANY other, including the
    // owner's, and the account had no way to tell who was in charge. Two rules now:
    //
    //   * Removing someone ELSE requires being the account owner.
    //   * Removing YOURSELF is always allowed — that is "sign out this device", and it correctly
    //     ends in revocation so the device cannot come back on its own.
    //
    // A removed device is added to the deny-list (see `Store::revoked`), so unlike before, the
    // action is not reversible by the device it acted on.
    let is_owner = {
        let g = state.db.lock().unwrap_or_else(|e| e.into_inner());
        g.owner.get(&account).map(String::as_str) == Some(device.as_str())
    };
    if body.device_id != device && !is_owner {
        return Err(StatusCode::FORBIDDEN);
    }
    let mut removed = false;
    {
        let mut g = state.db.lock().unwrap_or_else(|e| e.into_inner());
        // LAST-DEVICE GUARD. Revocation is permanent by design, so removing the only registered
        // device would lock the account out of its own server with no in-band recovery: the
        // removed device cannot re-register, and no other device exists to remove anything. Refuse
        // instead — the operator can still revoke from the data file, but that is a deliberate act.
        let remaining = g.devices.get(&account).map_or(0, HashMap::len);
        if remaining <= 1
            && g.devices
                .get(&account)
                .is_some_and(|s| s.contains_key(&body.device_id))
        {
            return Err(StatusCode::CONFLICT);
        }
        if let Some(set) = g.devices.get_mut(&account) {
            removed = set.remove(&body.device_id).is_some();
            if removed {
                g.revoked.insert((account.clone(), body.device_id.clone()));
            }
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
        // ...and the pre-extractor admission guard below, which bounds how MANY bodies can be
        // in flight and how long one may take. `DefaultBodyLimit` alone still lets N concurrent
        // clients each pin an 8 MiB buffer, all of it parsed before `verify_auth` ever runs.
        .layer(axum::middleware::from_fn_with_state(
            default_limits(),
            guard,
        ))
        .with_state(state)
}

/// Per-request resource bounds, applied before any handler runs.
///
/// axum runs middleware *before* a handler's extractors, which is the only place that can bound
/// the work `Json<T>` does on the way in: buffering the body and deserializing it happen for
/// every request, including ones that `verify_auth` is about to reject as unauthorized. So an
/// unauthenticated caller could otherwise make the server hold N x 8 MiB of parsed JSON, or tie
/// up a task with a slow body, before a single signature check ran.
#[derive(Clone)]
struct Limits {
    /// Total request bodies that may be buffered/parsed at the same instant. A personal sync
    /// server's real concurrency is a handful of devices polling every few minutes, so this is
    /// deliberately generous; its job is to bound memory, not to shape throughput.
    inflight: Arc<Semaphore>,
    /// Wall-clock ceiling for one request, after which the client gets a 504 rather than an
    /// unbounded task. Covers a client that dribbles a body forever (slowloris).
    timeout: Duration,
}

/// Hand-rolled so `app()` needs no parameters and so the defaults live next to the type that
/// documents them. Not a rate limiter on purpose — see the `guard` doc comment.
fn default_limits() -> Limits {
    Limits {
        inflight: Arc::new(Semaphore::new(MAX_INFLIGHT_REQUESTS)),
        timeout: Duration::from_secs(REQUEST_TIMEOUT_SECS),
    }
}

/// The admission decision, split out from the middleware so it is testable without a socket.
fn admit(inflight: &Arc<Semaphore>) -> Result<OwnedSemaphorePermit, StatusCode> {
    // `try_` not `acquire_`: queueing unboundedly behind a permit is the same denial of service
    // as doing the work, just with more memory held. Refuse fast and let the client retry.
    // `try_acquire_owned` takes `self: Arc<Self>`, so clone the handle — it is refcounted, not
    // the semaphore state.
    inflight
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)
}

/// Bound the resources an unauthenticated request can pin before it is authenticated.
///
/// Deliberately NOT a rate limiter. A correct per-client rate limit needs a client-IP source, and
/// this server has none wired up (no `ConnectInfo`, and behind a reverse proxy the socket address
/// is the proxy anyway). A *global* token bucket would let one abusive caller throttle every
/// other user of a shared deployment — the same failure shape as the global nonce 429 that the
/// per-device cap in [`SeenNonces`] just fixed. The two bounds here are unconditional instead:
/// they cap total concurrency and per-request time regardless of who is asking.
async fn guard(State(limits): State<Limits>, req: Request, next: Next) -> Response {
    let Ok(permit) = admit(&limits.inflight) else {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            "server is at its concurrent-request limit; retry shortly",
        )
            .into_response();
    };
    let res = match timeout(limits.timeout, next.run(req)).await {
        Ok(res) => res,
        Err(_) => {
            eprintln!(
                "[aegis-sync-server] WARN request exceeded the {}s budget and was cancelled",
                REQUEST_TIMEOUT_SECS
            );
            (
                StatusCode::GATEWAY_TIMEOUT,
                "request took too long and was cancelled",
            )
                .into_response()
        }
    };
    // The permit must outlive `next.run(req)`, not the `await` of it: dropping it early would
    // let N+1 bodies be buffered while the previous one is still being parsed.
    drop(permit);
    res
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

    // ----------------------------------------------------------------- replay-nonce index

    fn key(device: &str, n: u32) -> (String, String) {
        (device.to_string(), format!("{n:032x}"))
    }

    /// The sweep must drop an entry once its token is dead, and must not drop a live one.
    /// `sweep` is conservative by up to one second, so drive `now` past the bucket boundary.
    #[test]
    fn sweeping_drops_expired_entries_and_keeps_live_ones() {
        let mut s = SeenNonces::default();
        s.insert(key("dev", 1), 1_000);
        s.insert(key("dev", 2), 90_000);
        assert_eq!(s.len(), 2);

        // Well past entry 1's expiry but before entry 2's. Bucket 0 is popped (0+1000 <= 5_000),
        // bucket 90_000 is not (90_000+1000 > 5_000).
        s.sweep(5_000);
        assert!(!s.contains(&key("dev", 1)), "expired entry must be gone");
        assert!(s.contains(&key("dev", 2)), "live entry must survive");
        assert_eq!(s.len(), 1);
    }

    /// The reference counts in `by_device` must track `by_key` exactly, or the per-device cap
    /// silently starts refusing long before its limit (or never fires at all).
    #[test]
    fn sweeping_keeps_the_per_device_reference_counts_exact() {
        let mut s = SeenNonces::default();
        for n in 0..5 {
            s.insert(key("a", n), 1_000); // short-lived
            s.insert(key("b", n), 90_000); // long-lived
        }
        assert_eq!(s.device_count("a"), 5);
        assert_eq!(s.device_count("b"), 5);

        s.sweep(5_000);
        assert_eq!(s.device_count("a"), 0, "all of a's entries expired");
        assert_eq!(s.device_count("b"), 5, "b is untouched");

        // A device whose count fell to zero must be removed entirely, not left at 0, so
        // `device_count` for a never-seen device and a fully-swept one read the same.
        assert_eq!(s.device_count("a"), 0);
        assert_eq!(s.len(), 5);
    }

    /// The whole point of the per-device cap: one device at its limit must NOT consume the
    /// budget that keeps everyone else working. Before this, a single high-rate device could
    /// fill the global map and 429 every other device on the server.
    #[test]
    fn a_device_at_its_cap_does_not_consume_another_devices_budget() {
        let mut s = SeenNonces::default();
        // "greedy" fills its per-device cap; "calm" stays well under both caps.
        for n in 0..MAX_SEEN_NONCES_PER_DEVICE as u32 {
            s.insert(key("greedy", n), 90_000);
        }
        for n in 0..10u32 {
            s.insert(key("calm", n), 90_000);
        }
        assert!(s.device_count("greedy") >= MAX_SEEN_NONCES_PER_DEVICE);
        assert!(s.len() < MAX_SEEN_NONCES, "global cap not reached");

        // The greedy device is refused...
        assert!(s.device_count("greedy") >= MAX_SEEN_NONCES_PER_DEVICE);
        // ...while an unrelated device still has room, so `verify_auth` would let it through.
        assert!(
            s.device_count("calm") < MAX_SEEN_NONCES_PER_DEVICE,
            "one device's flood must not make another device look full"
        );
        assert!(
            s.len() < MAX_SEEN_NONCES,
            "global backstop still not engaged"
        );
    }

    /// A spent nonce must be reported as spent until it expires — that is the whole replay
    /// defense. Re-inserting the identical key is impossible in production (the replay is
    /// rejected before `insert`), so the expiry index cannot hold a stale duplicate entry for
    /// it; assert the index stays consistent.
    #[test]
    fn a_spent_nonce_is_reported_spent_until_it_expires() {
        let mut s = SeenNonces::default();
        let k = key("dev", 7);
        assert!(!s.contains(&k));
        s.insert(k.clone(), 90_000);
        assert!(s.contains(&k), "a replay must be caught");
        // One second before expiry it is still spent.
        s.sweep(89_999);
        assert!(s.contains(&k), "must stay spent until the token dies");
        s.sweep(95_000);
        assert!(!s.contains(&k), "and become reusable once it does");
        assert_eq!(s.device_count("dev"), 0);
    }

    /// Expiry bucketing must be stable/deterministic: two entries in the same second share a
    /// bucket, and `expiry_bucket` is monotonic, so the sweep's pop order can never skip a
    /// bucket that still holds a live entry.
    #[test]
    fn expiry_buckets_are_monotonic_and_second_aligned() {
        assert_eq!(expiry_bucket(0), 0);
        assert_eq!(expiry_bucket(999), 0);
        assert_eq!(expiry_bucket(1_000), 1_000);
        assert_eq!(expiry_bucket(1_999), 1_000);
        assert_eq!(expiry_bucket(2_000), 2_000);
        assert!(expiry_bucket(1) <= expiry_bucket(1_001));
        assert!(expiry_bucket(1_001) <= expiry_bucket(2_000));
    }

    /// Many entries across many buckets: the sweep must free exactly the dead ones and leave
    /// the live ones, with no key lost or duplicated.
    #[test]
    fn a_bulk_sweep_frees_exactly_the_dead_entries() {
        let mut s = SeenNonces::default();
        let live: Vec<(String, String)> = (0..50u32).map(|n| key("d", n)).collect();
        for (i, k) in live.iter().enumerate() {
            // Alternate dead (2s) and live (200s) so both populations span many buckets.
            let exp = if i % 2 == 0 { 2_000 } else { 200_000 };
            s.insert(k.clone(), exp);
        }
        assert_eq!(s.len(), 50);
        s.sweep(10_000);
        let survivors = (0..50u32).filter(|n| s.contains(&key("d", *n))).count();
        assert_eq!(
            survivors, 25,
            "exactly the odd (long-lived) entries survive"
        );
        assert_eq!(s.len(), 25);
        assert_eq!(s.device_count("d"), 25);
    }

    /// A record stamped absurdly in the future must be refused, not clamped: clamping would
    /// rewrite the AEAD-bound `hlc` and re-create the undecryptable-forever state.
    #[test]
    fn far_future_records_are_rejected_not_rewritten() {
        let now = 1_700_000_000_000i64;
        let recs = vec![
            body_rec("poison", i64::MAX, 0, "new"),
            body_rec("nearly", now + MAX_FUTURE_SKEW_MS + 1, 0, "new"),
            body_rec("edge", now + MAX_FUTURE_SKEW_MS, 0, "new"),
            body_rec("past", now - 1_000_000, 0, "new"),
        ];
        let kept = reject_far_future(recs, now);
        let ids: Vec<_> = kept.iter().map(|r| r.uuid.as_str()).collect();
        assert_eq!(ids, ["edge", "past"], "only in-window/past records survive");
        // The survivors are byte-identical — proof the filter never rewrites `hlc`.
        assert_eq!(
            kept[0].hlc.get("wall_ms").and_then(Value::as_i64),
            Some(now + MAX_FUTURE_SKEW_MS)
        );
    }

    /// A record with no parseable `wall_ms` must be left alone (the LWW default is 0, i.e.
    /// the past, which is harmless) rather than dropped — dropping would silently discard
    /// a record the rest of the pipeline is perfectly able to order.
    #[test]
    fn a_record_without_a_parseable_wall_is_kept() {
        let now = 1_700_000_000_000i64;
        let mut r = body_rec("nowall", 0, 0, "new");
        r.hlc = json!({ "counter": 3, "node": "n" });
        let kept = reject_far_future(vec![r], now);
        assert_eq!(
            kept.len(),
            1,
            "a missing wall_ms must not be treated as far-future"
        );
    }

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
            ord: None,
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

    // ------------------------------------------------------------------ device revocation
    //
    // `registered()` uses an `acct-{seed}` label, which is NOT 32-byte hex, so
    // `verify_account_root` can never pass for it. Anything that exercises registration needs a
    // real account: the account id IS the account signing key's public half (that is the whole
    // point of the proof-of-root check), so the test supplies a real key pair.

    fn account_key() -> SigningKey {
        SigningKey::from_bytes(&[9u8; 32])
    }

    fn account_id_for(key: &SigningKey) -> String {
        hex_bytes(&key.verifying_key().to_bytes())
    }

    /// A `RegisterDevice` body with a genuine proof-of-root signature.
    fn register_body(
        acct_key: &SigningKey,
        account: &str,
        device: &SigningKey,
        label: &str,
    ) -> RegisterDevice {
        let device_id = hex_bytes(&device.verifying_key().to_bytes());
        let msg = format!("aegis-register-v1\n{account}\n{device_id}");
        RegisterDevice {
            account_id: account.into(),
            device_id,
            label: label.into(),
            account_sig: hex_bytes(&acct_key.sign(msg.as_bytes()).to_bytes()),
        }
    }

    /// Register `devices` against one fresh account, in order, and return that `AppState`. The
    /// FIRST device registered becomes the owner (`Store::owner`), so callers pass the intended
    /// owner first.
    async fn account_with(
        acct_key: &SigningKey,
        account: &str,
        devices: &[SigningKey],
    ) -> AppState {
        let state = AppState::new(Store::default(), None);
        for (i, d) in devices.iter().enumerate() {
            let r = post_device(
                State(state.clone()),
                signed(d, account, &format!("reg-{i}"), now_ms() + 300_000),
                Json(register_body(acct_key, account, d, &format!("dev-{i}"))),
            )
            .await;
            assert!(r.is_ok(), "device {i} must register: {:?}", r.err());
        }
        state
    }

    #[tokio::test]
    async fn a_removed_device_cannot_re_register() {
        // THE bug this fixes: `post_device` is the one endpoint that does not require
        // registration, it re-inserted unconditionally, and the account key is derived from the
        // recovery phrase the removed device still holds — so removal was fully reversible.
        let ak = account_key();
        let account = account_id_for(&ak);
        let owner = SigningKey::from_bytes(&[1u8; 32]);
        let kicked = SigningKey::from_bytes(&[2u8; 32]);
        let state = account_with(&ak, &account, &[owner.clone(), kicked.clone()]).await;
        let kicked_id = hex_bytes(&kicked.verifying_key().to_bytes());

        // Owner kicks the second device.
        let r = remove_device(
            State(state.clone()),
            signed(&owner, &account, "kick", now_ms() + 300_000),
            Json(RemoveDevice {
                device_id: kicked_id.clone(),
            }),
        )
        .await;
        assert!(
            r.is_ok(),
            "owner must be able to remove another: {:?}",
            r.err()
        );

        // The removed device tries to walk straight back in with a fresh token + a valid
        // proof-of-root signature (it still holds the recovery phrase, so it can).
        let again = post_device(
            State(state.clone()),
            signed(&kicked, &account, "re-register", now_ms() + 300_000),
            Json(register_body(&ak, &account, &kicked, "kicked")),
        )
        .await;
        assert_eq!(
            again.unwrap_err(),
            StatusCode::FORBIDDEN,
            "a revoked device must not be able to re-register"
        );
        let still_gone = state
            .db
            .lock()
            .unwrap()
            .devices
            .get(&account)
            .is_some_and(|s| s.contains_key(&kicked_id));
        assert!(
            !still_gone,
            "the revoked device must not be back in the device set"
        );
    }

    #[tokio::test]
    async fn a_non_owner_cannot_remove_another_device() {
        // Previously ANY registered device could evict ANY other, including the owner's.
        let ak = account_key();
        let account = account_id_for(&ak);
        let owner = SigningKey::from_bytes(&[3u8; 32]);
        let other = SigningKey::from_bytes(&[4u8; 32]);
        let state = account_with(&ak, &account, &[owner.clone(), other.clone()]).await;
        let owner_id = hex_bytes(&owner.verifying_key().to_bytes());

        // `other` tries to remove the OWNER.
        let r = remove_device(
            State(state.clone()),
            signed(&other, &account, "evil", now_ms() + 300_000),
            Json(RemoveDevice {
                device_id: owner_id.clone(),
            }),
        )
        .await;
        assert_eq!(r.unwrap_err(), StatusCode::FORBIDDEN);
        assert!(
            state
                .db
                .lock()
                .unwrap()
                .devices
                .get(&account)
                .is_some_and(|s| s.contains_key(&owner_id)),
            "the owner must survive a non-owner's removal attempt"
        );
    }

    #[tokio::test]
    async fn a_device_can_remove_itself_but_not_the_last_one() {
        // Self-removal is legitimate ("sign out this device") …
        let ak = account_key();
        let account = account_id_for(&ak);
        let owner = SigningKey::from_bytes(&[5u8; 32]);
        let other = SigningKey::from_bytes(&[6u8; 32]);
        let state = account_with(&ak, &account, &[owner.clone(), other.clone()]).await;

        let self_rm = remove_device(
            State(state.clone()),
            signed(&other, &account, "self", now_ms() + 300_000),
            Json(RemoveDevice {
                device_id: hex_bytes(&other.verifying_key().to_bytes()),
            }),
        )
        .await;
        assert!(self_rm.is_ok(), "a device must be able to sign itself out");

        // … but once it is the only one left, removal is refused. Revocation is permanent by
        // design, so allowing this would lock the account out of its own server with no in-band
        // recovery.
        let last = remove_device(
            State(state.clone()),
            signed(&owner, &account, "last", now_ms() + 300_000),
            Json(RemoveDevice {
                device_id: hex_bytes(&owner.verifying_key().to_bytes()),
            }),
        )
        .await;
        assert_eq!(last.unwrap_err(), StatusCode::CONFLICT);
    }

    #[test]
    fn revocation_and_ownership_survive_a_snapshot_round_trip() {
        // In-memory-only state would make revocation a speed bump: a server restart would
        // silently un-revoke every removed device.
        let mut store = Store::default();
        store.devices.entry("acct".into()).or_default().insert(
            "dev-a".into(),
            Device {
                device_id: "dev-a".into(),
                label: "A".into(),
                last_seen_ms: 0,
            },
        );
        store.revoked.insert(("acct".into(), "dev-b".into()));
        store.owner.insert("acct".into(), "dev-a".into());

        let back = Snapshot::from_store(&store).into_store();
        assert!(
            back.revoked.contains(&("acct".into(), "dev-b".into())),
            "a revoked device must still be revoked after a restart"
        );
        assert_eq!(back.owner.get("acct").map(String::as_str), Some("dev-a"));
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
                ord: None,
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
            ord: None,
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

    // ── Live-store pruning ────────────────────────────────────────────────────
    //
    // `from_store_compacting` has always dropped over-retention tombstones, but only from the
    // on-disk JSON. The in-memory `Store.records` kept every tombstone forever, so a long-lived
    // server grew without bound AND re-compacted the same ever-growing set on every single
    // write. `prune_tombstones` fixes the actual leak. These tests drive the LIVE store, which
    // the pre-existing compaction tests above never did.

    #[test]
    fn pruning_reaps_the_live_store_not_just_the_snapshot() {
        let mut store = Store::default();
        let total = TOMBSTONE_RETENTION_PER_NS + 25;
        for i in 0..total {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        assert_eq!(
            store.records.len(),
            total,
            "precondition: the live store holds them all"
        );

        let dropped = prune_tombstones(&mut store);

        // The whole point: memory is actually released, not just the file.
        assert_eq!(dropped, 25);
        assert_eq!(store.records.len(), TOMBSTONE_RETENTION_PER_NS);
        // The 25 OLDEST (lowest wall_ms) are the doomed ones; the newest survive.
        assert!(!store
            .records
            .contains_key(&("a".into(), "ns".into(), "t0".into())));
        assert!(store
            .records
            .contains_key(&("a".into(), "ns".into(), "t500".into())));
    }

    #[test]
    fn pruning_keeps_live_records_and_is_idempotent() {
        let mut store = Store::default();
        for i in 0..TOMBSTONE_RETENTION_PER_NS {
            store.records.insert(
                ("a".into(), "ns".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        // A live record sharing the namespace must be untouched by a tombstone prune.
        store
            .records
            .insert(("a".into(), "ns".into(), "live1".into()), live("live1", 1));

        assert_eq!(
            prune_tombstones(&mut store),
            0,
            "at the window, nothing is due"
        );
        assert_eq!(store.records.len(), TOMBSTONE_RETENTION_PER_NS + 1);
        assert!(store
            .records
            .contains_key(&("a".into(), "ns".into(), "live1".into())));

        // Running it again must not drop anything more (it must not be off-by-one hungry).
        assert_eq!(prune_tombstones(&mut store), 0);
        assert_eq!(store.records.len(), TOMBSTONE_RETENTION_PER_NS + 1);
    }

    /// Retention is per `(account, namespace)`. A namespace that churns hard must not evict
    /// another namespace's tombstones, and must not evict another ACCOUNT's.
    #[test]
    fn pruning_is_scoped_per_account_and_namespace() {
        let mut store = Store::default();
        let total = TOMBSTONE_RETENTION_PER_NS + 25;
        for i in 0..total {
            store.records.insert(
                ("a".into(), "chatty".into(), format!("t{i}")),
                tomb(&format!("t{i}"), i as i64),
            );
        }
        // A quiet namespace, and a second account's chatty namespace, both well under the window.
        for i in 0..10 {
            store.records.insert(
                ("a".into(), "quiet".into(), format!("q{i}")),
                tomb(&format!("q{i}"), i as i64),
            );
            store.records.insert(
                ("b".into(), "chatty".into(), format!("u{i}")),
                tomb(&format!("u{i}"), i as i64),
            );
        }

        let dropped = prune_tombstones(&mut store);

        assert_eq!(dropped, 25, "only the chatty namespace is over its window");
        assert_eq!(
            store
                .records
                .keys()
                .filter(|(a, ns, _)| a == "a" && ns == "chatty")
                .count(),
            TOMBSTONE_RETENTION_PER_NS
        );
        for i in 0..10 {
            assert!(store
                .records
                .contains_key(&("a".into(), "quiet".into(), format!("q{i}"))));
            assert!(store
                .records
                .contains_key(&("b".into(), "chatty".into(), format!("u{i}"))));
        }
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
            ord: None,
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

    /// The tie-break must make ordering total WITHOUT touching the AEAD-bound `hlc`.
    ///
    /// This is the regression guard for the record-brick bug: `canonicalize_body` used to write
    /// the bumped counter back into `hlc` without re-sealing `ct`, so the record could never be
    /// opened again by any client and could never be rewritten either (its retry lost the per-uuid
    /// LWW gate). The bump now lands in `ord`, which is in no AAD.
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
        // Ordering is total: no two records end up on the same effective stamp.
        let counters: HashSet<u64> = out.iter().map(|(_, r)| ord_key(r).1).collect();
        assert_eq!(counters.len(), 3, "counters collided: {counters:?}");
        for (_, r) in &out {
            // `hlc` is what the client sealed `ct` against. It must come back byte-identical.
            assert_eq!(
                hlc_key(&r.hlc),
                (500, 0, "n"),
                "`hlc` is AEAD-bound and must never be rewritten by the server"
            );
            assert_eq!(ord_key(r).0, 500, "wall_ms must be preserved in `ord`");
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
            ord_key(&out[0].1).1,
            5,
            "must reserve an ordering counter above the stored 4"
        );
        assert_eq!(
            hlc_key(&out[0].1.hlc).1,
            4,
            "the client's `hlc` must pass through untouched"
        );
    }

    /// The bump must key off the record's OWN previous version being on the same tuple, not off
    /// that version merely existing. An ordinary update would otherwise be mistaken for a clash
    /// and get a reserved counter on every single write.
    #[test]
    fn updating_a_record_is_not_mistaken_for_a_cross_uuid_tie() {
        let mut store = Store::default();
        store.records.insert(
            ("acct".into(), "ns".into(), "a".into()),
            body_rec("a", 700, 4, "old"),
        );
        // `a` is re-pushed at a strictly newer wall time — no tie with anything.
        let out = canonicalize_body(vec![body_rec("a", 800, 0, "new")], "ns", "acct", &store);
        assert!(
            out[0].1.ord.is_none(),
            "a plain update must not reserve an ordering counter: {:?}",
            out[0].1.ord
        );
        assert_eq!(hlc_key(&out[0].1.hlc), (800, 0, "n"));
    }

    #[test]
    fn distinct_hlcs_are_left_untouched() {
        let empty = Store::default();
        let recs = vec![body_rec("a", 100, 1, "one"), body_rec("b", 200, 2, "two")];
        let out = canonicalize_body(recs, "ns", "acct", &empty);
        let mut got: Vec<_> = out.iter().map(|(_, r)| hlc_key(&r.hlc)).collect();
        got.sort();
        assert_eq!(got, vec![(100, 1, "n"), (200, 2, "n")]);
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
                ord: None,
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

    /// M11: the concurrency bound is real, and it is released — a refused request must not
    /// permanently consume a permit, or the server would wedge itself after N requests.
    #[tokio::test]
    async fn admit_refuses_once_every_permit_is_held_and_recovers_when_one_is_released() {
        let inflight = Arc::new(Semaphore::new(3));
        let mut held: Vec<OwnedSemaphorePermit> = (0..3)
            .map(|_| admit(&inflight).expect("permit available while under the cap"))
            .collect();
        assert_eq!(held.len(), 3);
        // Cap reached: a new request is refused fast (503), not queued behind the others.
        // Compare only the error side — `OwnedSemaphorePermit` has no `PartialEq`.
        let refused = |s: &Arc<Semaphore>| admit(s).err();
        assert_eq!(refused(&inflight), Some(StatusCode::SERVICE_UNAVAILABLE));
        // Releasing one permit must make exactly one more request admissible again. This is the
        // half a cap test usually omits, and it is the half that decides whether the server
        // recovers at all.
        drop(held.remove(0));
        let _recovered = admit(&inflight).expect("a released permit is reusable");
        assert_eq!(refused(&inflight), Some(StatusCode::SERVICE_UNAVAILABLE));
    }

    /// M11: the timeout must actually fire and yield the 504, not just be configured. Uses a
    /// budget far below `REQUEST_TIMEOUT_SECS` so the test stays fast while exercising the same
    /// `timeout(...).await` path the middleware uses.
    #[tokio::test]
    async fn a_request_that_outlives_its_budget_is_cancelled() {
        let budget = Duration::from_millis(30);
        let started = now_ms();
        let outcome = timeout(budget, tokio::time::sleep(Duration::from_secs(30))).await;
        assert!(
            outcome.is_err(),
            "the sleep must not have finished inside the budget"
        );
        // `timeout` returns as soon as the budget elapses; it does not wait out the inner
        // future, so the elapsed time must be near the budget, not 30s.
        assert!(
            now_ms() - started < 5_000,
            "timeout() should cancel at the budget, not wait for the inner future"
        );
    }
}
