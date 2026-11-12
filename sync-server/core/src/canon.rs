//! Canonicalisation of a pushed batch: id repair, duplicate collapse, the native cross-uuid
//! HLC tie-break, and the stamp bounds that keep a hostile peer from poisoning every client.
//!
//! Moved from `sync-server/src/main.rs` with bodies and comments unchanged, except where a
//! dependency on the native host had to become an argument: `unique_uuid` takes the
//! [`Entropy`] it draws from, and `canonicalize_body` takes the records already stored in the
//! `(account, ns)` instead of the native `Store`.
use std::collections::{BTreeSet, HashMap, HashSet};

use serde_json::{json, Value};

use crate::auth::MAX_FUTURE_SKEW_MS;
use crate::env::Entropy;
use crate::wire::{hlc_key, ord_key, WireRecord};

/// Deterministic 128-bit content digest (FNV-1a run at two independent offsets/seeds).
///
/// Used only to synthesize a missing record `uuid` — deliberately dependency-free so the server
/// keeps its tiny lockfile. This is NOT a security primitive and NOT unpredictable: it is
/// unkeyed, public and deterministic, so anyone who knows a record's `(ns, nonce, ct)` can
/// compute the id it will be given. That is exactly why [`unique_uuid`] must not let the caller
/// choose how many times it is run.
pub fn content_digest(parts: &[&str]) -> String {
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

/// ONE pass over a record's entire content — the only place the record's own bytes are read.
///
/// Split out from `content_digest` so the test instrument counts PASSES over the content rather
/// than calls of the function that happens to do it: the defect is *re-reading the ciphertext*,
/// which is a property of the hashing, not of the function wrapped around it. Counting at the
/// call site instead would have counted "how many times `unique_uuid` ran", which is 1 in the
/// fixed code and 1 in the broken code alike — a test that cannot tell them apart proves nothing
/// (proved here: the first version of this instrument passed against the pre-fix loop).
pub fn content_pass(ns: &str, rec: &WireRecord, salt: &str) -> String {
    #[cfg(any(test, feature = "test-instrument"))]
    CONTENT_PASSES.with(|c| c.set(c.get() + 1));
    content_digest(&[ns, &rec.nonce, &rec.ct, salt])
}

/// The uuid an incoming record should be stored under: its own if it has one, otherwise one
/// derived from its content so that two different records never share an id.
///
/// ## Reading the record's bytes exactly ONCE is a security property, not an optimisation
///
/// A client-supplied `uuid` is stored VERBATIM — `post_records` puts it straight into the map key
/// — so a peer can put ANY string into `taken`, including digests it computed offline: this
/// function's digest is public, unkeyed and deterministic (see [`content_digest`]). The previous
/// version walked an incrementing salt and re-hashed `ns`, `nonce` and the entire `ct` on every
/// probe, which made the loop count — and so the CPU — a function of how many digests the caller
/// had already pre-stored. The attacker paid one cheap record per probe; the victim paid
/// `taken.len() x |ct|` of hashing, with `|ct|` up to `MAX_CT_LEN` and the total bounded only by
/// `MAX_BODY_BYTES` (8 MiB) — tens of gigabytes per request, sustained, because the store keeps the
/// attacker's records. All of it inside the synchronous `db` lock in a region with no `.await`, so
/// the 30s `guard` timeout could not interrupt it (a timeout only fires at an await point).
///
/// Its doc comment called that collision "astronomically unlikely". That was the false premise, and
/// it was false in the only way that matters: nothing about the collision was unlikely, it was
/// merely *un-precomputed*, and precomputing it costs the attacker nothing.
///
/// So the content is hashed once and the walk never sees it again. The separator for the case where
/// that one digest is already taken is 128 bits of OS entropy rather than an integer, which the
/// caller cannot pre-store however many records it owns: the walk's first candidate is new by
/// construction. It is still a walk, so termination does not rest on that argument — each iteration
/// draws FRESH entropy and the counter only varies the input, so the candidate is a new random
/// 128-bit value every time (exit probability 1 - 2^-128 per attempt), and a miss costs ~70 bytes
/// rather than the whole ciphertext.
///
/// The entropy comes from the host (`OsEntropy` over `getrandom` in the native server), so this
/// function stays pure; a test injects a fixed source.
pub fn unique_uuid(
    rec: &WireRecord,
    ns: &str,
    taken: &HashSet<String>,
    entropy: &mut dyn Entropy,
) -> String {
    if !rec.uuid.is_empty() {
        return rec.uuid.clone();
    }
    // Salt 0, spelled the way the old walk spelled it, so a record that found a free id keeps the
    // exact id an earlier build would have given it. The fast path is byte-identical to before.
    let base = content_pass(ns, rec, "0");
    if !taken.contains(&base) {
        return base;
    }
    // The base id is taken. Every record that hashed to it hashed the SAME `(ns, nonce, ct)` —
    // identical content — so content alone cannot separate them, which is what the salt walk was
    // for. Note what is NOT hashed here: the record's own bytes are long gone.
    let mut draws = 0u32;
    loop {
        let candidate = content_digest(&[&base, &format!("{}:{draws}", entropy_hex(entropy))]);
        if !taken.contains(&candidate) {
            return candidate;
        }
        draws = draws.wrapping_add(1);
    }
}

/// 128 bits of the host's randomness, hex — the only part of a synthesized id the server does
/// not derive from the request.
///
/// [`Entropy::fill`] must overwrite the whole buffer and panic rather than return predictable
/// bytes (see `OsEntropy` in the native server for why a loud panic is the right failure): a
/// repeating value would hand the caller a collision the loop in [`unique_uuid`] cannot escape.
fn entropy_hex(entropy: &mut dyn Entropy) -> String {
    let mut bytes = [0u8; 16];
    entropy.fill(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

// How many times THIS THREAD read a record's whole content — i.e. how many times `content_pass`
// ran.
//
// A test-only instrument, compiled out of the release build. It lives in the core because
// `content_pass` does; the server's own tests read it through the `test-instrument` feature,
// which only its `[dev-dependencies]` entry enables, so a release build never carries it.
// The defect this exists to guard is *work*, and "how much of the victim's ciphertext did we re-read" measures it directly; a
// wall-clock bound would be the same claim with the machine's speed baked in. Thread-local because
// the test harness runs tests on separate threads and a process-global counter would be perturbed
// by every other test that canonicalizes a body. (`//`, not `///`: a doc comment cannot attach to
// a `thread_local!` invocation, and clippy says so.)
#[cfg(any(test, feature = "test-instrument"))]
thread_local! {
    pub static CONTENT_PASSES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
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
///
/// `existing` yields `(uuid, record)` for every record ALREADY STORED in this `(account, ns)`
/// (and nothing else); it is walked twice, hence `Clone`. `entropy` feeds [`unique_uuid`].
pub fn canonicalize_body<'a, I>(
    records: Vec<WireRecord>,
    ns: &str,
    existing: I,
    entropy: &mut dyn Entropy,
) -> Vec<(String, WireRecord)>
where
    I: Iterator<Item = (&'a str, &'a WireRecord)> + Clone,
{
    // Ids already present in this (account, ns) — a synthesized id must not land on one of these.
    let mut taken: HashSet<String> = existing.clone().map(|(uuid, _)| uuid.to_string()).collect();
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
            let u = unique_uuid(&rec, ns, &taken, entropy);
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
    //
    //    The result is a DETERMINISTIC total order, and both halves below are load-bearing for
    //    that. The batch is collected into a `HashMap`, whose iteration order is seeded per
    //    instance from `RandomState` and so differs between calls and between server processes;
    //    handing out reserved counters in that order made the SAME body produce DIFFERENT `ord`
    //    values on different runs, and two servers replaying one batch would hand clients
    //    different orderings for identical content. So the batch is sorted into a total order on
    //    `(wall, counter, node, uuid)` first, and only then are counters handed out. `uuid` is
    //    the final component and is unique after step 2 (empty ids were synthesized apart), which
    //    is what makes the sort total.
    let mut out: Vec<(String, WireRecord)> = Vec::new();
    // The counters already occupied in each `(wall, node)` bucket, SORTED, so the walk below can
    // jump straight to the next free slot instead of testing every integer. Built ONCE from the
    // store and extended as the batch is accepted. The old code re-scanned the entire store for
    // every candidate on every bump iteration, under the global db lock — O(incoming x stored x
    // bumps) with a String allocation per comparison.
    let mut occupied: HashMap<(i64, String), BTreeSet<u64>> = HashMap::new();
    // The uuids sitting on each exact `(wall, counter, node)` tuple, for this (account, ns) only.
    // This is what distinguishes a genuine cross-uuid tie from an ordinary update: a record whose
    // OWN previous version is the only claimant on a tuple keeps that tuple, rather than being
    // bumped on every single write.
    let mut holders: HashMap<(i64, u64, String), HashSet<String>> = HashMap::new();
    for (u, r) in existing {
        let (w, c, node) = ord_key(r);
        occupied.entry((w, node.to_string())).or_default().insert(c);
        holders
            .entry((w, c, node.to_string()))
            .or_default()
            .insert(u.to_string());
    }
    // Deterministic order first — see the comment above. `hlc_key` borrows, so this cannot move.
    result.sort_by(|a, b| {
        let (aw, ac, an) = hlc_key(&a.1.hlc);
        let (bw, bc, bn) = hlc_key(&b.1.hlc);
        (aw, ac, an, a.0.as_str()).cmp(&(bw, bc, bn, b.0.as_str()))
    });
    for (uuid, mut rec) in result {
        let (wall, counter, node) = hlc_key(&rec.hlc);
        let node_owned = node.to_string();
        let bucket = (wall, node_owned.clone());
        // Find the lowest counter at or above the client's own that no OTHER uuid holds. A clash
        // is any other uuid already holding this exact tuple; this record's own previous version
        // sitting on it is NOT a clash.
        //
        // The walk is TOTAL — it has no iteration cap, because a cap silently reintroduced the
        // very ambiguity it was meant to remove: a batch may carry up to `MAX_RECORDS_PER_REQUEST`
        // (1000) records, so a cluster larger than any fixed cap exhausted the old loop and left
        // the tail colliding on the client's original counter, which was already claimed.
        // Termination does not need a cap: each step advances `bumped` strictly past an occupied
        // counter, and `occupied` is finite. The `checked_add` guard makes that airtight rather
        // than merely argued — the input cannot reach `u64::MAX` (`hlc` counters are rejected
        // above `u32::MAX` by `reject_client_poisoning_stamps`, and `ord` counters are only ever
        // set here), but a saturating add at the ceiling would loop forever, so it is reported
        // instead of spun on.
        let mut bumped = counter;
        while let Some(&c) = occupied.get(&bucket).and_then(|s| s.range(bumped..).next()) {
            let held_by_other = holders
                .get(&(wall, c, node_owned.clone()))
                .is_some_and(|us| us.iter().any(|u| u != &uuid));
            if !held_by_other {
                break; // `c` is free, or held only by this record's own previous version
            }
            match c.checked_add(1) {
                Some(next) => bumped = next,
                None => {
                    eprintln!(
                        "[aegis-sync-server] WARN cannot total-order record {uuid} in ns {ns:?}: \
                         the HLC counter space is exhausted at u64::MAX"
                    );
                    break;
                }
            }
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
        occupied.entry(bucket).or_default().insert(bumped);
        holders
            .entry((wall, bumped, node_owned))
            .or_default()
            .insert(uuid.clone());
        out.push((uuid, rec));
    }
    out
}

/// Drop records whose stamp would damage a client rather than just lose the LWW comparison.
///
/// Two independent bounds, both on the cleartext `hlc` (which the server is allowed to read and
/// must never rewrite — see below):
///
/// **1. `wall_ms` too far in the future.** The danger is not the rejected record — it is what
/// the record does to every PEER. HLC receive is an unbounded `max` against the observed remote
/// stamp, so one record carrying `wall_ms: i64::MAX` pins each peer's process-global clock
/// forever: every later local edit inherits that wall, can never be overridden by a genuine
/// update, and the namespace is stuck until the store is deleted by hand. The client now clamps
/// what it *observes* (`MAX_REMOTE_SKEW_MS` in `src-tauri/src/sync_envelope.rs`), so the damage
/// self-heals there too — this is the server refusing to host the bad record in the first place.
///
/// **2. `counter` wider than `u32`.** `hlc_key` reads the counter as a `u64` so it can order
/// anything, but the client's `Hlc.counter` is a `u32` and `sync_envelope::from_value`
/// deserializes it with serde, which ERRORS on an out-of-range integer instead of truncating.
/// Such a record is therefore not merely "a high counter" — `open_wire` bails at `from_value`
/// before it reaches the AEAD check, so it is unopenable by every client, permanently. It is
/// also unrecoverable: `counter` lives inside `hlc`, which is AEAD-bound, so the server cannot
/// rewrite it into range, and the per-uuid LWW gate lets the poisoned record outrank every
/// legitimate rewrite of that id. One push would brick one uuid on every device, forever.
///
/// A stamp in the PAST is harmless (LWW just loses), so only these two bounds are policed.
///
/// Rejected, never rewritten: `wall_ms` and `counter` both live inside `hlc`, which is bound
/// into each record's AEAD associated data. Silently clamping either here would invalidate the
/// tag and turn every affected record into the undecryptable-forever state this file used to
/// create by bumping the same field.
pub fn reject_client_poisoning_stamps(records: Vec<WireRecord>, now_ms: i64) -> Vec<WireRecord> {
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
                return false;
            }
            // `as_u64` is the same widening read `hlc_key` uses, so this bound is exactly the
            // point past which the server would be storing a stamp no client can deserialize.
            // A missing/negative counter reads as 0 and passes, matching the wall_ms handling
            // above: an unparseable field is not treated as an attack.
            let counter = rec.hlc.get("counter").and_then(Value::as_u64).unwrap_or(0);
            if counter > u32::MAX as u64 {
                eprintln!(
                    "[aegis-sync-server] WARN rejected record {}: counter {counter} exceeds \
                     u32::MAX — no client could deserialize it, so storing it would make this \
                     uuid permanently unopenable",
                    rec.uuid
                );
                return false;
            }
            true
        })
        .collect()
}

/// Sentinel map key for a pushed record that arrived with no id. NUL can't appear in a
/// client-supplied uuid (it arrives as JSON text), so this can never shadow a real id.
const EMPTY_ID_SLOT_PREFIX: &str = "\u{0}empty:";

#[cfg(test)]
mod tests {
    use super::*;
    use crate::env::Entropy;
    use crate::wire::{hlc_key, ord_key, WireRecord};
    use serde_json::json;
    use std::collections::HashSet;

    struct Counting(u8);
    impl Entropy for Counting {
        fn fill(&mut self, buf: &mut [u8]) {
            for b in buf {
                *b = self.0;
                self.0 = self.0.wrapping_add(1);
            }
        }
    }

    fn rec(uuid: &str, wall: i64, counter: u64, ct: &str) -> WireRecord {
        WireRecord {
            uuid: uuid.into(),
            hlc: json!({ "wall_ms": wall, "counter": counter, "node": "n" }),
            nonce: format!("nonce-{ct}"),
            ct: ct.into(),
            ..WireRecord::default()
        }
    }

    #[test]
    fn unique_uuid_uses_the_injected_entropy_only_on_a_collision() {
        let r = rec("", 1, 0, "same");
        let base = unique_uuid(&r, "ns", &HashSet::new(), &mut Counting(0));
        assert_eq!(base, content_digest(&["ns", &r.nonce, &r.ct, "0"]));
        let taken: HashSet<String> = [base.clone()].into();
        let a = unique_uuid(&r, "ns", &taken, &mut Counting(0));
        let b = unique_uuid(&r, "ns", &taken, &mut Counting(0));
        assert_eq!(a, b, "same entropy, same id");
        assert_ne!(a, base);
        assert_ne!(a, unique_uuid(&r, "ns", &taken, &mut Counting(100)));
        assert_eq!(
            unique_uuid(&rec("given", 1, 0, "x"), "ns", &taken, &mut Counting(0)),
            "given"
        );
    }

    #[test]
    fn canonicalize_body_breaks_ties_against_existing_records_in_ord() {
        let stored = rec("old", 700, 4, "old");
        let out = canonicalize_body(
            vec![rec("new", 700, 4, "new"), rec("", 1, 0, "e")],
            "ns",
            [("old", &stored)].into_iter(),
            &mut Counting(0),
        );
        assert_eq!(out.len(), 2);
        let new = &out.iter().find(|(u, _)| u == "new").unwrap().1;
        assert_eq!(ord_key(new).1, 5);
        assert_eq!(hlc_key(&new.hlc), (700, 4, "n"));
        assert!(out.iter().all(|(u, _)| !u.is_empty()));
    }

    #[test]
    fn poisoning_stamps_are_rejected() {
        let now = 1_000_000;
        let skew = crate::auth::MAX_FUTURE_SKEW_MS;
        let future = rec("f", now + skew + 1, 0, "x");
        let edge = rec("e", now + skew, u32::MAX as u64, "x");
        let wide = rec("w", now, u32::MAX as u64 + 1, "x");
        let kept = reject_client_poisoning_stamps(vec![future, edge, wide], now);
        assert_eq!(
            kept.iter().map(|r| r.uuid.as_str()).collect::<Vec<_>>(),
            ["e"]
        );
    }
}
