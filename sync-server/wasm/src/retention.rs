//! Tombstone retention: the native `tombstones_past_retention` / `prune_tombstones_in` rule,
//! run after every `POST /v1/records` as the native push path runs it.
//!
//! A tombstone is what tells a device that was offline during a delete that the record is
//! gone, so it is kept while it is EITHER among the newest [`TOMBSTONE_RETENTION_PER_NS`] of
//! its `(account, ns)` (by hlc) OR held for less than [`TOMBSTONE_MIN_AGE_MS`]. Past both, it is
//! pruned: the native server removes the record outright. Live records are never pruned.
//!
//! The age is how long the mesh has held the tombstone, `now - first_stored_ms`, where
//! `first_stored_ms` is the node clock when a node first stored it, kept as the value of its
//! index key (`store::put_record`). Native measures the client's own `hlc.wall_ms`, which the
//! client chooses: a client could push more than 500 tombstones of new uuids stamped in 1970
//! and have the same push prune them at once, each prune leaving a permanent row (below) that
//! no cap counts. Measured from storage, nothing is pruned for 90 days, so the records cap and
//! the counters bound it.
//!
//! The index key replicates with its value, so a replica reads the time the writing node
//! stored the tombstone: a node's clock, never the client's. An index value that does not read
//! as a time (none is written) starts its clock at the scan that finds it: the scan writes its
//! own `now` there. It never falls back to the hlc `wall_ms`, which would reopen the hole.
//!
//! Differences from native, all from the mesh having no single store to sweep:
//! - Scope: native prunes EVERY namespace of every account on every push (and the pulled
//!   namespace on every pull); here a push prunes its own `(account, ns)`. Tombstones only ever
//!   arrive by a push to their namespace, which prunes it, so what is left behind is only what
//!   ages past the floor afterwards, until the namespace's next push.
//! - The record is removed with an ORDERED delete, `set-ordered(key, order_bytes(hlc), none)`:
//!   the store's plain `delete` writes an empty-order tombstone, which loses to the record's
//!   own order and would change nothing. The store keeps that ordered mesh tombstone (its value
//!   is gone, so the ciphertext and the record are), and it outranks a later push of the same
//!   uuid with an OLDER hlc: such a stale copy is not resurrected, where natively it would be.
//!   A push with an equal or newer hlc is stored as natively.
//! - Ties at an identical hlc are pruned in uuid order (native: map order).
//!
//! Finding the tombstones without reading the namespace: every stored tombstone has a key in
//! the index `tomb/<acct>/<ns>/<hex(order_bytes(hlc))>/<uuid>` (`records.rs` writes it before
//! the tombstone and deletes it once the uuid moves off that tombstone), so `list-keys` returns
//! them oldest first by hlc, and the candidates are a prefix of that order: the oldest
//! `count - 500`. Each is pruned only if it was first stored at least 90 days ago; a younger
//! one is kept and the walk goes on. The walk stops early at the first hlc `wall_ms` more than
//! `MAX_FUTURE_SKEW_MS` past the floor: a node stores no stamp further ahead of its clock than
//! that, so that tombstone and every later one were stored inside the floor. Ordinary deletes
//! (stamped about when they are stored) therefore cost no walk past the first young one.
//! Each candidate's CURRENT record is re-read before anything is pruned; an index key whose
//! record is no longer that tombstone (a concurrent write on another node moved it) is stale,
//! and is deleted. Stale keys are counted, so after such a race a namespace can keep fewer
//! than 500 tombstones, by at most that many; nothing held for less than the floor is ever
//! pruned.
use aegis_sync_core::auth::{MAX_FUTURE_SKEW_MS, unhex};
use aegis_sync_core::order::order_bytes;

use crate::keys;
use crate::meshnode::kv::store as kv;
use crate::store::{self, PAGE};

/// Tombstones always kept per `(account, ns)`: the newest this many (native value).
pub const TOMBSTONE_RETENTION_PER_NS: usize = 500;
/// Tombstones held for less than this are never pruned (native value: 90 days; measured from
/// when a node first stored the tombstone, see the module docs).
pub const TOMBSTONE_MIN_AGE_MS: i64 = 90 * 24 * 60 * 60 * 1_000;

/// What a prune removed, for the node's counters.
#[derive(Clone, Copy, Debug, Default)]
pub struct Pruned {
    pub records: i64,
    pub ct_bytes: i64,
}

/// Prunes `(acct, ns)`'s tombstones past retention at `now_ms`.
pub fn prune(acct: &str, ns: &str, now_ms: i64) -> Pruned {
    let mut pruned = Pruned::default();
    let prefix = keys::tomb_prefix(acct, ns);
    // The oldest `count - 500` by hlc are the candidates; the newest 500 are always kept.
    let mut candidates = count(&prefix).saturating_sub(TOMBSTONE_RETENTION_PER_NS);
    if candidates == 0 {
        return pruned;
    }
    // A candidate first stored at or before `floor` has been held for the minimum age.
    let floor = now_ms.saturating_sub(TOMBSTONE_MIN_AGE_MS);
    let mut after: Option<String> = None;
    'walk: loop {
        let batch = kv::list_keys(&prefix, after.as_deref(), PAGE);
        let done = batch.len() < PAGE as usize;
        for key in &batch {
            if candidates == 0 {
                break 'walk;
            }
            candidates -= 1;
            let entry = key[prefix.len()..]
                .split_once('/')
                .and_then(|(order, uuid)| {
                    let order = unhex(order)?;
                    Some((wall_ms(&order)?, order, uuid))
                });
            let Some((wall, order, uuid)) = entry else {
                kv::delete(key); // not a key this service writes
                continue;
            };
            if wall.saturating_sub(MAX_FUTURE_SKEW_MS) > floor {
                // Stamped further past the floor than any node accepts ahead of its clock:
                // this one and every later one were stored inside the floor.
                break 'walk;
            }
            match first_stored(key) {
                Held::Gone => continue,
                Held::Unknown => {
                    // No time to measure from: its clock starts now.
                    kv::set(key, now_ms.to_string().as_bytes());
                    continue;
                }
                Held::Since(t) if t > floor => continue,
                Held::Since(_) => {}
            }
            let rec_key = keys::rec_key(acct, ns, uuid);
            match store::stored_meta(&rec_key) {
                Some(m) if m.deleted && order_bytes(&m.hlc) == order => {
                    kv::set_ordered(&rec_key, &order, None);
                    // The pruned uuid is no longer a tie partner at that hlc.
                    let idx = keys::hlcidx_key(acct, ns, &m.hlc, uuid);
                    if idx.len() <= keys::MAX_KEY {
                        kv::delete(&idx);
                    }
                    pruned.records += 1;
                    pruned.ct_bytes += m.ct_len as i64;
                }
                _ => {} // stale: the uuid has moved off this tombstone
            }
            kv::delete(key);
        }
        if done {
            break;
        }
        after = batch.last().cloned();
    }
    if pruned.records > 0 {
        eprintln!(
            "[aegis-sync] pruned {} tombstone(s) of one namespace past both the \
             {TOMBSTONE_RETENTION_PER_NS}-per-namespace window and the \
             {TOMBSTONE_MIN_AGE_MS}ms age floor",
            pruned.records
        );
    }
    pruned
}

/// What an index key's value says about when its tombstone was first stored.
enum Held {
    /// The key was deleted after it was listed.
    Gone,
    /// The value is not a time (none is written).
    Unknown,
    /// First stored at this node-clock time.
    Since(i64),
}

fn first_stored(key: &str) -> Held {
    match kv::get(key) {
        None => Held::Gone,
        Some(v) => match std::str::from_utf8(&v).ok().and_then(|t| t.parse().ok()) {
            Some(t) => Held::Since(t),
            None => Held::Unknown,
        },
    }
}

/// The index keys under `prefix`.
fn count(prefix: &str) -> usize {
    let mut n = 0;
    let mut after: Option<String> = None;
    loop {
        let batch = kv::list_keys(prefix, after.as_deref(), PAGE);
        n += batch.len();
        if batch.len() < PAGE as usize {
            return n;
        }
        after = batch.last().cloned();
    }
}

/// The `wall_ms` an `order_bytes` value starts with (`hlc_key(hlc).0`).
fn wall_ms(order: &[u8]) -> Option<i64> {
    let head: [u8; 8] = order.get(..8)?.try_into().ok()?;
    Some((u64::from_be_bytes(head) ^ (1 << 63)) as i64)
}
