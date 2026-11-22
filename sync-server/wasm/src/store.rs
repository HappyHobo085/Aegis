//! Typed access to `meshnode:kv` in the layout of [`crate::keys`].
use std::collections::BTreeSet;

use aegis_sync_core::devices::{AccountFacts, ApprovedFact, DeviceFacts, LabelFact};
use aegis_sync_core::order::order_bytes;
use aegis_sync_core::wire::{WireRecord, hlc_key};
use serde_json::Value;

use crate::keys;
use crate::meshnode::kv::store;

/// The most entries one `list-keys` / `set-members` call returns (the host's cap).
pub const PAGE: u32 = 1000;

/// Every member of a set, in byte order.
fn members(set: &str) -> Vec<Vec<u8>> {
    let mut out: Vec<Vec<u8>> = Vec::new();
    loop {
        let batch = store::set_members(set, out.last().map(Vec::as_slice), PAGE);
        let done = batch.len() < PAGE as usize;
        out.extend(batch);
        if done {
            return out;
        }
    }
}

fn id_set(set: &str) -> BTreeSet<String> {
    members(set)
        .into_iter()
        .filter_map(|m| String::from_utf8(m).ok())
        .collect()
}

/// The account's device facts as this node sees them, without labels (only
/// `GET /v1/devices` shows them: [`labels`]).
///
/// READ ORDER IS LOAD-BEARING: `devices` first, then `pending`, `approved`, `revoked`. A joiner
/// is a member only once it is not pending, so if its `devices` entry were visible while its
/// `pending` entry was not, it would be admitted before the owner approved it. The writer
/// (`devices::register`) therefore writes a joiner's `pending` entry no later than
/// its `devices` entry; every device this read sees in `devices` then already has its
/// `pending` entry visible to the reads that follow. Reading the other sets later can only
/// show more approvals and more revocations, both of which are real.
pub fn account_facts(acct: &str) -> AccountFacts {
    let devices: Vec<DeviceFacts> = members(&keys::devices_set(acct))
        .into_iter()
        .filter_map(|m| serde_json::from_slice(&m).ok())
        .collect();
    let pending = id_set(&keys::pending_set(acct));
    let approvals: Vec<ApprovedFact> = members(&keys::approved_set(acct))
        .into_iter()
        .filter_map(|m| serde_json::from_slice(&m).ok())
        .collect();
    let revoked = id_set(&keys::revoked_set(acct));
    let mut facts = AccountFacts {
        devices,
        pending,
        revoked,
        ..AccountFacts::default()
    };
    // The earliest approval of each device (`AccountFacts::approve` folds in any order).
    for a in approvals {
        facts.approve(a);
    }
    facts
}

/// The account's label changes (`LabelFact`s), as this node sees them.
pub fn labels(acct: &str) -> Vec<LabelFact> {
    members(&keys::labels_set(acct))
        .into_iter()
        .filter_map(|m| serde_json::from_slice(&m).ok())
        .collect()
}

/// `device`'s `lastSeenMs`: the newest of every node's register, `None` if no node set one.
pub fn last_seen(acct: &str, device: &str) -> Option<i64> {
    let prefix = keys::seen_prefix(acct, device);
    let mut newest = None;
    let mut after: Option<String> = None;
    loop {
        let batch = store::list_keys(&prefix, after.as_deref(), PAGE);
        let done = batch.len() < PAGE as usize;
        for key in &batch {
            let ms = store::get(key).and_then(|v| std::str::from_utf8(&v).ok()?.parse().ok());
            newest = newest.max(ms);
        }
        if done {
            return newest;
        }
        after = batch.last().cloned();
    }
}

/// Sets this node's `last_seen` register for `device` to `now_ms`. Only this node writes it,
/// so it never conflicts.
pub fn touch_seen(acct: &str, device: &str, now_ms: i64) {
    let key = keys::seen_key(acct, device, &crate::caps::node_hex());
    store::set(&key, now_ms.to_string().as_bytes());
}

/// The stored record at `key`, if any. A value that does not parse (none is ever written)
/// reads as a record with every field defaulted.
pub fn record(key: &str) -> Option<WireRecord> {
    store::get(key).map(|v| serde_json::from_slice(&v).unwrap_or_default())
}

/// Just the stored `hlc` at `key`: `Some(Value::Null)` for an unparseable value.
pub fn stored_hlc(key: &str) -> Option<Value> {
    #[derive(serde::Deserialize)]
    struct HlcOnly {
        #[serde(default)]
        hlc: Value,
    }
    store::get(key).map(|v| {
        serde_json::from_slice::<HlcOnly>(&v)
            .map(|h| h.hlc)
            .unwrap_or(Value::Null)
    })
}

/// What the LWW check, the caps and retention need from a stored record.
pub struct Stored {
    pub hlc: Value,
    pub deleted: bool,
    pub ct_len: usize,
}

/// The stored record at `key` without its other fields: `hlc` reads as `Value::Null` and
/// the rest as empty when the value does not parse (none is ever written).
pub fn stored_meta(key: &str) -> Option<Stored> {
    #[derive(serde::Deserialize, Default)]
    #[serde(default)]
    struct Meta {
        hlc: Value,
        deleted: bool,
        ct: String,
    }
    store::get(key).map(|v| {
        let m: Meta = serde_json::from_slice(&v).unwrap_or_default();
        Stored {
            hlc: m.hlc,
            deleted: m.deleted,
            ct_len: m.ct.len(),
        }
    })
}

/// Writes `rec` (whose `uuid` is set and `ord` is none) as `(acct, ns, rec.uuid)`, ordered by
/// its client `hlc`, over `old` (what this node had stored there), at node time `now_ms`. The
/// tie-index key and, for a tombstone, its retention-index key go first, so a replica that has
/// the record also has them; the index keys of `old` are plain-deleted after, once the record
/// is stored and the uuid has moved off them. The mesh GC removes those delete tombstones after
/// 90 days, so neither index grows with edits, only with live records and recent churn.
///
/// The retention-index key's value is when a node first stored the tombstone: `now_ms`, or
/// the time already there if it is earlier. Retention's age floor counts from it, never from
/// the client's `hlc.wall_ms`, which the client chooses (`retention.rs`).
///
/// A tombstone whose retention-index or tie-index key would be over the store's key limit
/// (possible only for an `ns` + `uuid` far longer than a real client's) is stored without that
/// key. Without a retention-index key it is never counted or pruned by retention, which
/// reclaims space and never decides what a client sees. Without a tie-index key it is not
/// found as a tie partner of a record with a higher uuid at the same hlc, which then is served
/// without `tie_ord`. A LIVE record whose tie-index key would be too long is refused with 413
/// before anything is written (`records.rs`), as one whose record key is too long.
///
/// Returns whether the record is now stored. A record over a key this node had stored is
/// always stored (the LWW pre-check let only a strictly newer `hlc` through, and the stored
/// order is that `hlc`'s). A key that read as absent may still hold the ORDERED mesh tombstone
/// retention left when it pruned that uuid (`retention.rs`), which outranks an older `hlc`:
/// the store then keeps the tombstone and drops this write, so that case re-reads the key, and
/// the index keys just written for it are deleted again.
pub fn put_record(
    acct: &str,
    ns: &str,
    rec: &WireRecord,
    old: Option<&Stored>,
    now_ms: i64,
) -> bool {
    let bytes = serde_json::to_vec(rec).expect("a WireRecord serializes");
    let tomb = keys::tomb_key(acct, ns, &rec.hlc, &rec.uuid);
    if rec.deleted && tomb.len() <= keys::MAX_KEY {
        let first = stored_ms(&tomb).map_or(now_ms, |t| t.min(now_ms));
        store::set(&tomb, first.to_string().as_bytes());
    }
    let idx = keys::hlcidx_key(acct, ns, &rec.hlc, &rec.uuid);
    let idx_fits = idx.len() <= keys::MAX_KEY;
    if idx_fits {
        store::set(&idx, keys::HLCIDX_VALUE);
    }
    store::set_ordered(
        &keys::rec_key(acct, ns, &rec.uuid),
        &order_bytes(&rec.hlc),
        Some(&bytes),
    );
    if old.is_none() {
        let want = hlc_key(&rec.hlc);
        let stored =
            stored_hlc(&keys::rec_key(acct, ns, &rec.uuid)).is_some_and(|h| hlc_key(&h) == want);
        if !stored {
            if rec.deleted && tomb.len() <= keys::MAX_KEY {
                store::delete(&tomb);
            }
            if idx_fits {
                store::delete(&idx);
            }
        }
        return stored;
    }
    if let Some(old) = old {
        // `old.hlc` is strictly older than `rec.hlc` (the LWW pre-check), so these are never
        // the keys just written.
        let old_idx = keys::hlcidx_key(acct, ns, &old.hlc, &rec.uuid);
        if old_idx.len() <= keys::MAX_KEY {
            store::delete(&old_idx);
        }
        if old.deleted {
            let old_tomb = keys::tomb_key(acct, ns, &old.hlc, &rec.uuid);
            if old_tomb.len() <= keys::MAX_KEY {
                store::delete(&old_tomb);
            }
        }
    }
    true
}

/// A decimal node-clock time stored at `key` (a retention-index value), if it reads as one.
pub fn stored_ms(key: &str) -> Option<i64> {
    store::get(key).and_then(|v| std::str::from_utf8(&v).ok()?.parse().ok())
}

/// The mesh tie rule: does another live record (tombstones included) of `(acct, ns)` with a
/// LOWER uuid hold exactly `rec.hlc`? Then `rec` is served with `order::tie_ord`.
///
/// The tie index is a candidate list (a concurrent write on another node can leave a key
/// behind after its uuid moved on), so each candidate's CURRENT record is checked. Keys under
/// one hlc's prefix are in uuid order, so the scan stops at `rec.uuid`, which also leaves
/// `rec` itself out.
pub fn tied_below(acct: &str, ns: &str, rec: &WireRecord) -> bool {
    let prefix = keys::hlcidx_prefix(acct, ns, &rec.hlc);
    let want = hlc_key(&rec.hlc);
    let mut after: Option<String> = None;
    loop {
        let batch = store::list_keys(&prefix, after.as_deref(), PAGE);
        let done = batch.len() < PAGE as usize;
        for key in &batch {
            let uuid = &key[prefix.len()..];
            if uuid >= rec.uuid.as_str() {
                return false;
            }
            let current = stored_hlc(&keys::rec_key(acct, ns, uuid));
            if current.is_some_and(|h| hlc_key(&h) == want) {
                return true;
            }
        }
        if done {
            return false;
        }
        after = batch.last().cloned();
    }
}

/// The record keys under `prefix`, counted up to `cap` (counting stops there).
pub fn count_keys(prefix: &str, cap: usize) -> usize {
    let mut n = 0;
    let mut after: Option<String> = None;
    while n < cap {
        let batch = store::list_keys(prefix, after.as_deref(), PAGE);
        n += batch.len();
        if batch.len() < PAGE as usize {
            break;
        }
        after = batch.last().cloned();
    }
    n.min(cap)
}

/// Every uuid stored in `(acct, ns)`.
pub fn uuids(acct: &str, ns: &str) -> Vec<String> {
    let prefix = keys::rec_prefix(acct, ns);
    let mut out = Vec::new();
    let mut after: Option<String> = None;
    loop {
        let batch = store::list_keys(&prefix, after.as_deref(), PAGE);
        let done = batch.len() < PAGE as usize;
        after = batch.last().cloned();
        out.extend(batch.into_iter().map(|k| k[prefix.len()..].to_string()));
        if done {
            return out;
        }
    }
}
