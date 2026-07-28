//! Sync envelope: the Hybrid Logical Clock (HLC) that timestamps every syncable record
//! so independent devices converge under last-writer-wins, plus the process-global clock.
//!
//! An HLC combines wall-clock ms with a monotonic counter and the device node id, giving
//! a total order that (a) tracks real time closely, (b) never goes backwards even if the
//! wall clock does, and (c) breaks ties deterministically by node so two devices that
//! stamp in the same ms still order consistently. F2b's merge uses `Ord` for LWW, and the
//! deterministic `bytes()` encoding as AEAD associated data — so it must be byte-stable
//! (NOT serde_json, whose object-key order isn't guaranteed).
use std::sync::{Mutex, OnceLock};

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Hlc {
    pub wall_ms: i64,
    pub counter: u32,
    pub node: String,
}

impl Hlc {
    #[allow(dead_code)] // used by F2b / tests; kept as part of the frozen contract
    pub fn zero(node: &str) -> Self {
        Hlc {
            wall_ms: 0,
            counter: 0,
            node: node.to_string(),
        }
    }
    fn key(&self) -> (i64, u32, &str) {
        (self.wall_ms, self.counter, self.node.as_str())
    }
    /// Deterministic big-endian encoding for AEAD AAD (F2b) + stable comparisons. Stable
    /// across platforms and independent of serde — do NOT swap for serde_json.
    #[allow(dead_code)] // consumed by F2b's crypto AAD; part of the frozen contract
    pub fn bytes(&self) -> Vec<u8> {
        let mut out = Vec::with_capacity(12 + self.node.len());
        out.extend_from_slice(&self.wall_ms.to_be_bytes());
        out.extend_from_slice(&self.counter.to_be_bytes());
        out.extend_from_slice(self.node.as_bytes());
        out
    }
}

impl Ord for Hlc {
    fn cmp(&self, o: &Self) -> std::cmp::Ordering {
        self.key().cmp(&o.key())
    }
}
impl PartialOrd for Hlc {
    fn partial_cmp(&self, o: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(o))
    }
}

/// Read an `Hlc` from a record's `hlc` field, if present and well-formed.
#[allow(dead_code)] // used by the merge (sync_stores) — dead on the Android cdylib until F2b
pub fn from_value(v: &serde_json::Value) -> Option<Hlc> {
    serde_json::from_value(v.get("hlc")?.clone()).ok()
}

// Process-global clock: only (wall_ms, counter) matter for ordering; `node` is per-event.
static CLOCK: OnceLock<Mutex<(i64, u32)>> = OnceLock::new();
fn clock() -> &'static Mutex<(i64, u32)> {
    CLOCK.get_or_init(|| Mutex::new((0, 0)))
}

/// Pure HLC send: given the prior `(wall, counter)`, return the next. The counter
/// increments within a wall-ms and resets when the wall clock advances past the last
/// stamp — so the result is strictly greater than the prior even if `now_ms` stalls or
/// regresses. (Pure so it's deterministically testable without the process-global clock.)
fn next_tick(prev: (i64, u32), now_ms: i64) -> (i64, u32) {
    if now_ms > prev.0 {
        (now_ms, 0)
    } else {
        (prev.0, prev.1 + 1)
    }
}

/// Pure HLC receive: the next local `(wall, counter)` dominating both the prior local
/// state and the observed remote `(wall, counter)` (standard HLC update).
#[allow(dead_code)] // via observe() — dead on the Android cdylib until F2b's merge runs
fn next_observe(local: (i64, u32), now_ms: i64, remote: (i64, u32)) -> (i64, u32) {
    let max_wall = now_ms.max(local.0).max(remote.0);
    let counter = if max_wall == local.0 && max_wall == remote.0 {
        local.1.max(remote.1) + 1
    } else if max_wall == local.0 {
        local.1 + 1
    } else if max_wall == remote.0 {
        remote.1 + 1
    } else {
        0
    };
    (max_wall, counter)
}

/// Advance the global clock for a LOCAL event and return a strictly-monotonic timestamp.
pub fn tick(node: &str, now_ms: i64) -> Hlc {
    let mut g = clock().lock().unwrap_or_else(|e| e.into_inner());
    *g = next_tick(*g, now_ms);
    Hlc {
        wall_ms: g.0,
        counter: g.1,
        node: node.to_string(),
    }
}

/// HLC receive: on observing `remote`, return a local stamp that dominates BOTH the prior
/// global clock and `remote`, advancing the clock accordingly.
#[allow(dead_code)] // called by the merge (sync_stores) — dead on the Android cdylib until F2b
pub fn observe(node: &str, now_ms: i64, remote: &Hlc) -> Hlc {
    let mut g = clock().lock().unwrap_or_else(|e| e.into_inner());
    *g = next_observe(*g, now_ms, (remote.wall_ms, remote.counter));
    Hlc {
        wall_ms: g.0,
        counter: g.1,
        node: node.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ordering_is_wall_then_counter_then_node() {
        let a = Hlc {
            wall_ms: 10,
            counter: 0,
            node: "a".into(),
        };
        let b = Hlc {
            wall_ms: 10,
            counter: 1,
            node: "a".into(),
        };
        let c = Hlc {
            wall_ms: 11,
            counter: 0,
            node: "a".into(),
        };
        let d = Hlc {
            wall_ms: 10,
            counter: 0,
            node: "b".into(),
        };
        assert!(a < b && b < c);
        assert!(a < d); // same wall+counter → node breaks the tie
        assert!(d < b); // higher counter beats node tiebreak
    }

    // The clock math is tested via the PURE fns (deterministic; the global `tick`/`observe`
    // share a process-wide clock that other parallel tests mutate, so testing them directly
    // would be racy).
    #[test]
    fn next_tick_is_strictly_monotonic_even_if_wall_stalls_or_regresses() {
        let s0 = (1000, 0);
        let s1 = next_tick(s0, 1000); // same ms → counter bumps
        let s2 = next_tick(s1, 999); // wall went backwards → still strictly greater
        let s3 = next_tick(s2, 2000); // wall jumps → counter resets
        assert_eq!(s1, (1000, 1));
        assert_eq!(s2, (1000, 2));
        assert_eq!(s3, (2000, 0));
        assert!(s0 < s1 && s1 < s2 && s2 < s3);
    }

    #[test]
    fn next_observe_dominates_both_local_and_remote() {
        // local behind remote on wall → adopt remote wall, counter+1.
        assert_eq!(next_observe((5_000, 3), 5_000, (9_999, 7)), (9_999, 8));
        // all three walls equal → max(local,remote) counter + 1.
        assert_eq!(next_observe((10, 4), 10, (10, 9)), (10, 10));
        // physical now ahead of both → reset counter.
        assert_eq!(next_observe((10, 4), 50, (20, 9)), (50, 0));
        // local ahead of remote+now → local counter + 1.
        assert_eq!(next_observe((100, 2), 50, (20, 9)), (100, 3));
    }

    #[test]
    fn bytes_is_deterministic_and_order_consistent() {
        let h = Hlc {
            wall_ms: 0x0102_0304_0506_0708,
            counter: 0x0900_000A,
            node: "xy".into(),
        };
        let b = h.bytes();
        assert_eq!(&b[0..8], &[1, 2, 3, 4, 5, 6, 7, 8]); // big-endian wall_ms
        assert_eq!(&b[8..12], &[0x09, 0x00, 0x00, 0x0A]); // big-endian counter
        assert_eq!(&b[12..], b"xy");
        // Stable: same input → same bytes.
        assert_eq!(h.bytes(), h.clone().bytes());
    }

    #[test]
    fn from_value_reads_the_hlc_field() {
        let rec = serde_json::json!({ "hlc": { "wall_ms": 3, "counter": 1, "node": "z" } });
        let h = from_value(&rec).unwrap();
        assert_eq!(
            h,
            Hlc {
                wall_ms: 3,
                counter: 1,
                node: "z".into()
            }
        );
        assert!(from_value(&serde_json::json!({})).is_none());
    }
}
