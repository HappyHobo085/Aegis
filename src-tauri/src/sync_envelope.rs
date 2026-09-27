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

/// How far ahead of local time a remote stamp is trusted when advancing the clock.
///
/// HLC receive is an unbounded `max`, so a single record carrying a far-future `wall_ms`
/// pins the PROCESS-GLOBAL clock and every later local edit inherits that stamp. With
/// `i64::MAX` that is unrecoverable: the poisoned stamp wins LWW forever on the server AND
/// beats every genuine peer update, so the namespace is stuck until the store is deleted.
///
/// Clamping is what makes it *self-healing*: the clock is only pushed to `now + 60s`, real
/// time then passes that mark on its own, and the next tick moves past it. The same bound
/// the auth path already applies to token timestamps (`MAX_FUTURE_SKEW_MS` in
/// `sync-server/src/main.rs`) — a device more than a minute ahead is already broken, and its
/// own records would be rejected by a strict peer regardless.
const MAX_REMOTE_SKEW_MS: i64 = 60_000;

/// Pure HLC receive: the next local `(wall, counter)` dominating both the prior local
/// state and the observed remote `(wall, counter)` (standard HLC update).
///
/// The remote wall is clamped to `now_ms + MAX_REMOTE_SKEW_MS` (see that const). `local.0`
/// is deliberately NOT clamped: doing so could move the clock backwards and break the
/// monotonicity every other stamp relies on. The consequence is that a clock already
/// poisoned by a pre-fix build cannot be repaired in-process — which is precisely why the
/// clamp has to happen at this boundary, on the way IN.
fn next_observe(local: (i64, u32), now_ms: i64, remote: (i64, u32)) -> (i64, u32) {
    let remote = (
        remote.0.min(now_ms.saturating_add(MAX_REMOTE_SKEW_MS)),
        remote.1,
    );
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

    /// A hostile/broken peer stamping `i64::MAX` must NOT pin the clock. This is the
    /// regression guard for permanent sync poisoning: before the clamp in `next_observe`,
    /// the unbounded `max` adopted `i64::MAX` and every later tick inherited it.
    #[test]
    fn a_far_future_remote_stamp_cannot_poison_the_clock() {
        let now = 1_000i64;
        let (wall, counter) = next_observe((now, 0), now, (i64::MAX, 7));
        assert!(
            wall <= now + MAX_REMOTE_SKEW_MS,
            "clock adopted an absurd remote wall: {wall}"
        );
        // Crucially it is strictly LESS than the attacker asked for — this is a clamp, not a
        // "reject the whole observation".
        assert!(wall < i64::MAX);
        // And the counter still advanced, so a same-millisecond local edit is orderable.
        assert!(counter > 0, "counter should still advance past the remote");
    }

    /// The self-healing property that makes a clamp strictly better than `i64::MAX`:
    /// once real time passes the clamped mark, the next tick moves past it on its own.
    #[test]
    fn a_clamped_clock_recovers_once_real_time_passes_it() {
        let start = 1_000i64;
        let clamped = now_future_bound(start);
        // Simulate the worst case: the clock sits exactly at the clamp ceiling.
        let (poisoned_wall, poisoned_counter) = (clamped, 3u32);
        // Real time has now advanced well past the ceiling (e.g. 10 minutes later).
        let later = start + 600_000;
        let (wall, _) = next_observe((poisoned_wall, poisoned_counter), later, (0, 0));
        assert!(
            wall > poisoned_wall,
            "clock must escape the clamp on its own once real time passes it"
        );
        assert!(wall <= later, "clock must not run ahead of real time");
    }

    /// Guard against the opposite failure: an in-window remote stamp (ordinary clock skew
    /// between two real devices) MUST still advance the clock — otherwise the clamp would
    /// silently break legitimate HLC receive.
    #[test]
    fn an_in_window_remote_stamp_still_advances_the_clock() {
        let now = 1_000i64;
        // 30s ahead: real, plausible skew between two devices.
        let (wall, counter) = next_observe((now, 0), now, (now + 30_000, 4));
        assert_eq!(wall, now + 30_000, "an in-window stamp must be adopted");
        assert_eq!(counter, 5, "counter must be remote.counter + 1");
    }

    /// A remote stamp in the PAST is left alone: LWW simply loses, which is harmless.
    #[test]
    fn a_past_remote_stamp_does_not_move_the_clock_backwards() {
        let now = 1_000i64;
        let (wall, counter) = next_observe((now, 5), now, (1, 9));
        assert_eq!(wall, now, "the clock must never regress");
        assert_eq!(counter, 6, "counter must still advance past the remote");
    }

    /// Test helper: the clamp ceiling `next_observe` would use for a given `now`.
    fn now_future_bound(now: i64) -> i64 {
        now.saturating_add(MAX_REMOTE_SKEW_MS)
    }

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
