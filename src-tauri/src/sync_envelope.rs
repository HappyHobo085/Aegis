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

/// Advance an HLC `(wall, counter)` by exactly one tick, carrying into the wall when the
/// counter is already at its ceiling.
///
/// This is the ONLY place a counter is incremented, deliberately. The tempting one-line fix is
/// `saturating_add(1)`, and it is wrong: it makes the clock stop advancing. Every local edit
/// while the clock is parked at `u32::MAX` then gets the *identical* stamp, and since `Ord`
/// falls through to `node` — which is the same device — two of the user's own records tie, and
/// LWW picks between them by map iteration order. An attacker can hold the wall at the
/// `MAX_REMOTE_SKEW_MS` ceiling for the whole 60 s window, so that tie window is not a
/// sub-millisecond theoretical edge; it is a minute of collapsed ordering.
///
/// Carrying costs one millisecond of wall clock, which the wall clamp makes harmless (real
/// time passes it immediately, and every subsequent stamp is still strictly greater). So the
/// result is always strictly greater than the input, which is the invariant `next_tick` and
/// `next_observe` are both documented to guarantee.
fn bump(wall: i64, counter: u32) -> (i64, u32) {
    match counter.checked_add(1) {
        Some(c) => (wall, c),
        // `saturating_add` on the wall: only reachable if the wall is already `i64::MAX`, which
        // the observe-path clamp rules out, but a panic here would be a worse failure than a
        // stuck counter.
        None => (wall.saturating_add(1), 0),
    }
}

/// Pure HLC send: given the prior `(wall, counter)`, return the next. The counter
/// increments within a wall-ms and resets when the wall clock advances past the last
/// stamp — so the result is strictly greater than the prior even if `now_ms` stalls or
/// regresses. (Pure so it's deterministically testable without the process-global clock.)
fn next_tick(prev: (i64, u32), now_ms: i64) -> (i64, u32) {
    if now_ms > prev.0 {
        (now_ms, 0)
    } else {
        bump(prev.0, prev.1)
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
pub(crate) const MAX_REMOTE_SKEW_MS: i64 = 60_000;

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
        Some(local.1.max(remote.1))
    } else if max_wall == local.0 {
        Some(local.1)
    } else if max_wall == remote.0 {
        Some(remote.1)
    } else {
        None
    };
    match counter {
        Some(c) => bump(max_wall, c),
        None => (max_wall, 0),
    }
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

/// Whether the server's `ord` stamp may be adopted as a record's HLC. Pure, so the trust rule is
/// unit-testable without a wire record.
///
/// `ord` is the one field on a wire record the server AUTHORS rather than relays, and `open_wire`
/// adopts it as the record's HLC — so unlike every other field it is not covered by the AEAD
/// check. A `wall_ms` of `i64::MAX` there is namespace-wide, permanent poison: every pulled record
/// lands beyond the reach of any real clock, so no later local edit can dominate it and the user
/// can never change a favorite, bookmark, or history row again, on any device. It needs only a
/// compromised server or an on-path attacker, and `syncAllowInsecure` permits a plain `http://`
/// endpoint.
///
/// The genuine tie-break `ord` exists for is a LOCAL ordering concern — the server bumps a
/// counter it owns, on a record whose wall it did not choose — so bounding the wall by the same
/// `MAX_REMOTE_SKEW_MS` the receive path already trusts keeps every real tie-break working.
///
/// Rejection falls back to the wire `hlc`, which IS authenticated (it is bound into the AEAD
/// associated data), so a refused `ord` costs a tie-break and nothing else.
pub fn ord_is_adoptable(ord: &serde_json::Value, now_ms: i64) -> bool {
    // Deserializing into `Hlc` is itself the second check: `counter` is a `u32`, and serde ERRORS
    // on an out-of-range integer rather than truncating, so a malformed or over-wide stamp simply
    // does not parse and is refused here.
    match serde_json::from_value::<Hlc>(ord.clone()) {
        Ok(h) => h.wall_ms <= now_ms.saturating_add(MAX_REMOTE_SKEW_MS),
        Err(_) => false,
    }
}

/// The largest `(wall_ms, counter)` HLC appearing in `records`, ignoring records whose `hlc`
/// is absent or unparseable. Pure, so the boot-time scan is unit-testable without a store.
///
/// Unparseable stamps are SKIPPED rather than treated as a maximum: `from_value` fails on an
/// out-of-range `counter` (serde errors rather than truncating), and a record we cannot read is
/// no reason to believe anything about. A later pass — the sync merge's `observe` — is what
/// clamps a genuinely hostile stamp, and the server now refuses to store one at all
/// (`reject_client_poisoning_stamps`).
pub fn max_hlc(records: &[serde_json::Value]) -> Option<(i64, u32)> {
    records
        .iter()
        .filter_map(from_value)
        .map(|h| (h.wall_ms, h.counter))
        .max()
}

/// Seed the process-global clock forward to `max` — the highest stamp this device has already
/// persisted — so a local edit can never be stamped BELOW a record that is already on disk.
///
/// ## Why this exists
/// `CLOCK` starts at `(0, 0)` on every launch and nothing persisted it, so the first local stamp
/// after a restart is `(now_ms, 0)`. That is correct only while `now_ms` exceeds every stamp the
/// device holds, and it usually does not:
///   * a peer within the accepted `MAX_REMOTE_SKEW_MS` window can push this device's clock 60 s
///     into the future, and the records that observe stamps it on disk inherit that wall;
///   * the user's own wall clock can be ahead of the machine's previous session (NTP correction,
///     a timezone-free clock change, a VM resuming from a suspended host).
///
/// In both cases the next local edit is stamped below the record it is trying to update,
/// LOSES last-writer-wins, and is silently reverted by the following merge — and because the
/// losing stamp is itself persisted, nothing the user does afterwards can win it back. This is
/// silent data loss of the user's most recent edit, with no error anywhere.
///
/// ## Why it takes a max and never assigns
/// The clock is process-global and this is called from boot, but taking the max makes it
/// correct even if it is ever called after a tick: it can only move the clock FORWARD. That
/// matters because moving an HLC backwards would break the monotonicity every other stamp in
/// this module relies on, and a regression here would be far worse than the bug being fixed.
/// Pure merge of a persisted lower bound into the current clock. Extracted so the
/// never-move-backwards property is testable deterministically: the real `CLOCK` is
/// process-global and already sitting at real time, so asserting a floor against it in a test
/// is vacuous — the clock passes the assertion whether or not the seed ran.
pub(crate) fn merge_clock(cur: (i64, u32), floor: (i64, u32)) -> (i64, u32) {
    if floor > cur {
        floor
    } else {
        cur
    }
}

pub fn seed_clock(max: (i64, u32)) {
    let mut g = clock().lock().unwrap_or_else(|e| e.into_inner());
    *g = merge_clock(*g, max);
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

    /// A peer (buggy, or hostile) that stamps `counter = u32::MAX` on a wall inside the
    /// accepted skew window must not be able to walk the counter off the end of `u32`.
    ///
    /// `local.1.max(remote.1) + 1` is the line that overflows. This matters because the app
    /// ships a RELEASE build, where integer overflow WRAPS rather than panicking: the clock
    /// goes from `(now, u32::MAX)` to `(now, 0)`, which is a REGRESSION. Every later local edit
    /// then carries a stamp that loses LWW to the attacker's record, so the edit is silently
    /// reverted by the next merge — and because the clock no longer dominates, nothing the user
    /// does can win it back. The whole record becomes un-overwritable, exactly like the
    /// far-future-wall poisoning this module's other clamp already prevents.
    #[test]
    fn a_remote_counter_at_the_u32_ceiling_cannot_regress_the_clock() {
        let now = 1_000i64;
        let (wall, counter) = next_observe((now, 7), now, (now, u32::MAX));
        let produced = Hlc {
            wall_ms: wall,
            counter,
            node: "local".into(),
        };
        let hostile = Hlc {
            wall_ms: now,
            counter: u32::MAX,
            node: "evil".into(),
        };
        let local = Hlc {
            wall_ms: now,
            counter: 7,
            node: "local".into(),
        };
        assert!(
            produced > hostile,
            "the observed stamp must still dominate the remote one, but it is {produced:?} \
             vs {hostile:?} — the counter overflowed and the clock went backwards"
        );
        assert!(
            produced > local,
            "the observed stamp must still dominate the prior local state, but it is \
             {produced:?} vs {local:?}"
        );
    }

    /// The same ceiling reached through the LOCAL send path, which has no remote to blame.
    /// `next_tick`'s `prev.1 + 1` overflows identically once the clock is already parked at
    /// the ceiling, so the fix has to live in the shared increment, not in one call site.
    #[test]
    fn a_local_tick_at_the_u32_ceiling_still_advances() {
        let parked = (1_000i64, u32::MAX);
        let (wall, counter) = next_tick(parked, 1_000);
        let produced = (wall, counter);
        assert!(
            produced > parked,
            "a local tick must be strictly greater than the prior state, but it produced \
             {produced:?} from {parked:?} — the counter overflowed"
        );
    }

    /// Carry-into-the-wall is the fix, and it must NOT cost the counter its strict growth
    /// afterwards: the very next tick after a carry has to land one past the new wall, or the
    /// ordering would collapse a second time one event later.
    #[test]
    fn the_counter_resumes_growing_after_a_carry() {
        let (w1, c1) = next_tick((1_000, u32::MAX), 1_000); // carries
        let (w2, c2) = next_tick((w1, c1), 1_000);
        assert_eq!(
            (w2, c2),
            (w1, 1),
            "the counter must resume from 0 on the carried wall"
        );
        assert!((w2, c2) > (w1, c1));
    }

    /// The pure never-move-backwards property of the boot seed. Deliberately a PURE test: the
    /// real `CLOCK` is process-global and already at real time, so asserting a floor against it
    /// would pass whether or not the seed ran.
    #[test]
    fn seeding_never_moves_the_clock_backwards() {
        assert_eq!(
            merge_clock((5_000, 9), (9_000, 1)),
            (9_000, 1),
            "a higher floor wins"
        );
        assert_eq!(
            merge_clock((9_000, 1), (5_000, 9)),
            (9_000, 1),
            "a lower floor must leave the clock exactly where it is — an HLC that moves backwards \
             breaks the monotonicity every stamp in this module relies on"
        );
        assert_eq!(
            merge_clock((5_000, 9), (5_000, 9)),
            (5_000, 9),
            "an equal floor is a no-op"
        );
    }

    /// `max_hlc` is the pure half of the boot scan. An unreadable stamp — one whose `counter`
    /// does not fit the client's `u32`, which `from_value` REJECTS (serde errors rather than
    /// truncating) — must be skipped, not treated as the maximum, and must not abort the scan:
    /// the server now refuses to store such a record, but a store written before that fix (or by
    /// an older self-hosted server) can still hold one, and a boot that aborts on it would leave
    /// the clock unseeded — exactly the bug this scan exists to fix.
    #[test]
    fn max_hlc_skips_unreadable_stamps_without_aborting() {
        let recs = vec![
            serde_json::json!({ "hlc": { "wall_ms": 9_000i64, "counter": 1u32, "node": "a" } }),
            serde_json::json!({ "hlc": { "wall_ms": 1_000i64, "counter": (u32::MAX as u64) + 1, "node": "b" } }),
            serde_json::json!({ "hlc": { "wall_ms": 7_000i64, "counter": 2u32, "node": "c" } }),
        ];
        assert_eq!(
            max_hlc(&recs),
            Some((9_000, 1)),
            "the widest counter here is the one we CANNOT read; the two readable stamps must \
             still produce a maximum, and the unreadable one must not win"
        );
        assert_eq!(max_hlc(&[]), None, "no records, no stamps");
        assert_eq!(
            max_hlc(&[serde_json::json!({ "url": "https://x.test/" })]),
            None,
            "a record with no `hlc` at all contributes nothing"
        );
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
