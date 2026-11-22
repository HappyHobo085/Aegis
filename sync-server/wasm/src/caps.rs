//! The server-wide soft caps and the per-node counters they are checked against.
//!
//! The native server bounds the whole process with `MAX_ACCOUNTS`, `MAX_TOTAL_RECORDS` and
//! `MAX_TOTAL_CT_BYTES`, counted over its one in-memory store. A mesh has no single store to
//! count, and counting the local view by scanning it on every write would cost O(store). So
//! each node keeps its own share of every count in a replicated register
//! `count/<node-id-hex>/<metric>` that only it writes (no write ever conflicts), and the
//! mesh-wide value in a node's view is the sum of every node's share it has received.
//!
//! The caps are SOFT (spec §5.1): two nodes admitting concurrently can each pass the check
//! before seeing the other's share, so the mesh total may exceed a cap by what the other nodes
//! admit in that window. A share is updated read-modify-write, so two concurrent requests on
//! ONE node can lose one increment; and two nodes that prune the same tombstone (retention runs
//! on every node) both count it down. The drift is bounded by such races, which a personal mesh
//! of a few devices rarely has, and only moves a soft cap.
//!
//! The per-account caps are not counters: `MAX_PENDING_PER_ACCOUNT` is counted over the
//! account's device facts (read anyway), and `MAX_RECORDS_PER_ACCOUNT` over the account's keys
//! (`records.rs`), both exact over the local view.
use crate::keys;
use crate::meshnode::kv::store as kv;
use crate::store::PAGE;

pub use aegis_sync_core::wire::{MAX_PENDING_PER_ACCOUNT, MAX_RECORDS_PER_ACCOUNT};

#[cfg(not(feature = "test-caps"))]
pub use aegis_sync_core::{
    auth::MAX_SEEN_NONCES_PER_DEVICE,
    wire::{MAX_ACCOUNTS, MAX_TOTAL_CT_BYTES, MAX_TOTAL_RECORDS},
};

// TEST ONLY (`--features test-caps`, built only for a test harness, never for a deploy): caps a
// test can reach with a handful of requests.
#[cfg(feature = "test-caps")]
pub const MAX_ACCOUNTS: usize = 1;
#[cfg(feature = "test-caps")]
pub const MAX_TOTAL_RECORDS: usize = 4;
#[cfg(feature = "test-caps")]
pub const MAX_TOTAL_CT_BYTES: u64 = 40;
#[cfg(feature = "test-caps")]
pub const MAX_SEEN_NONCES_PER_DEVICE: usize = 10;

/// Accounts created (first registrations) on the node.
pub const ACCOUNTS: &str = "accounts";
/// Record keys written by the node, less those its retention pruned.
pub const RECORDS: &str = "records";
/// Ciphertext bytes written by the node (each write counts its growth or shrinkage), less
/// those its retention pruned.
pub const CT_BYTES: &str = "ct_bytes";

/// This node's id as lower-case hex: its counter keys and `last_seen` registers.
pub fn node_hex() -> String {
    keys::hex(&kv::node_id())
}

/// The mesh-wide counts in this node's view.
#[derive(Clone, Copy, Debug, Default)]
pub struct Totals {
    pub accounts: i64,
    pub records: i64,
    pub ct_bytes: i64,
}

/// Every node's share of every metric, summed. One `list-keys` per 1 000 counter keys (three
/// per node), then one `get` each.
pub fn totals() -> Totals {
    let mut t = Totals::default();
    let mut after: Option<String> = None;
    loop {
        let batch = kv::list_keys(keys::COUNT_PREFIX, after.as_deref(), PAGE);
        let done = batch.len() < PAGE as usize;
        for key in &batch {
            let slot = match key.rsplit_once('/').map(|(_, m)| m) {
                Some(ACCOUNTS) => &mut t.accounts,
                Some(RECORDS) => &mut t.records,
                Some(CT_BYTES) => &mut t.ct_bytes,
                _ => continue,
            };
            *slot = slot.saturating_add(read(key));
        }
        if done {
            return t;
        }
        after = batch.last().cloned();
    }
}

fn read(key: &str) -> i64 {
    kv::get(key)
        .and_then(|v| std::str::from_utf8(&v).ok()?.parse().ok())
        .unwrap_or(0)
}

/// Adds `delta` to this node's share of `metric`. A share may go negative (this node pruned
/// what another wrote); only the sum means anything.
pub fn add(metric: &str, delta: i64) {
    if delta == 0 {
        return;
    }
    let key = keys::count_key(&node_hex(), metric);
    let value = read(&key).saturating_add(delta);
    kv::set(&key, value.to_string().as_bytes());
}

/// Would adding `more` to `current` pass `cap`? (`current` may be negative, see [`add`].)
pub fn fits(current: i64, more: u64, cap: u64) -> bool {
    i128::from(current) + i128::from(more) <= i128::from(cap)
}
