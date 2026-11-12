//! Byte encodings of the HLC order, and the mesh service's cross-uuid tie-break.
//!
//! The native server keeps records in a map and orders them with [`hlc_key`] at read time. A
//! store that orders by KEY BYTES (the mesh service's `set-ordered`) needs the same order as a
//! byte string, which is [`order_bytes`]. The native server's own tie-break (a reserved counter,
//! see [`canonicalize_body`]) needs to see every stored record in a namespace at once; the mesh
//! has no such moment, so it uses [`tie_ord`] instead, which depends on the record alone.
//!
//! [`canonicalize_body`]: crate::canon::canonicalize_body
use serde_json::{json, Value};

use crate::canon::content_digest;
use crate::wire::{hlc_key, WireRecord, MAX_HLC_NODE_LEN};

/// `hlc` as bytes whose lexicographic order is exactly the [`hlc_key`] order:
/// `wall_ms` as a big-endian `i64` with the sign bit flipped (`(wall as u64) ^ (1 << 63)`, so
/// negative walls sort below positive ones), then `counter` as a big-endian `u64`, then the
/// `node` UTF-8 bytes. The first two parts are fixed-width, so the variable-length `node` is
/// only ever compared against another `node`, and byte order on UTF-8 is `str` order.
///
/// Missing or mistyped fields read as `hlc_key` reads them (`0`, `0`, `""`).
///
/// **Compare encoded values WHOLE.** The encoding is not prefix-free: the `node` bytes run to the
/// end with no length or terminator, so one value is a byte prefix of another whenever the first
/// two parts match and one `node` is a prefix of the other (`"a"` and `"ab"`). That is still the
/// correct order (`"a" < "ab"`), but only for a comparison of the complete byte strings. Do not
/// append anything after it inside one key and expect the order to survive, and do not use a
/// prefix scan over it as an equality test on `hlc`.
pub fn order_bytes(hlc: &Value) -> Vec<u8> {
    let (wall, counter, node) = hlc_key(hlc);
    let mut out = Vec::with_capacity(16 + node.len());
    out.extend_from_slice(&((wall as u64) ^ (1 << 63)).to_be_bytes());
    out.extend_from_slice(&counter.to_be_bytes());
    out.extend_from_slice(node.as_bytes());
    out
}

/// The mesh service's ordering stamp for a record whose `hlc` (wall, counter AND node) is
/// identical to another live record's in the same `(account, ns)` under a different uuid. The
/// CALLER decides whether such a tie exists; this only computes the stamp.
///
/// `{ wall_ms, counter, node: node + "~" + first 8 hex of content_digest([uuid]) }`, with `node`
/// truncated (at a char boundary) so the result is at most [`MAX_HLC_NODE_LEN`] bytes.
///
/// - `(wall_ms, counter)` are the record's own, so it keeps its place against every record with
///   a different `(wall_ms, counter)`.
/// - It is a function of `(hlc, uuid)` only, so every replica computes the same value without
///   coordinating, and two tied records get different nodes (up to a 32-bit digest collision).
/// - It is a well-formed HLC with all three fields present, which is what the client's
///   `sync_envelope::ord_is_adoptable` requires (it deserializes into `Hlc { wall_ms: i64,
///   counter: u32, node: String }` and checks `wall_ms` against its skew window). `counter` and
///   `wall_ms` are copied from an `hlc` the push path already bounded (`u32`, future skew).
///
/// `hlc` itself is never touched: it is AEAD-bound (see [`WireRecord`]). The native server does
/// not use this; it keeps its counter-bump rule.
pub fn tie_ord(rec: &WireRecord) -> Value {
    let (wall, counter, node) = hlc_key(&rec.hlc);
    let digest = content_digest(&[&rec.uuid]);
    let suffix = &digest[..8];
    // "~" plus 8 hex digits: 9 bytes of suffix.
    let mut keep = node.len().min(MAX_HLC_NODE_LEN - 1 - suffix.len());
    while !node.is_char_boundary(keep) {
        keep -= 1;
    }
    json!({
        "wall_ms": wall,
        "counter": counter,
        "node": format!("{}~{suffix}", &node[..keep]),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::wire::{hlc_key, hlc_well_formed, WireRecord, MAX_HLC_NODE_LEN};
    use serde_json::{json, Value};

    /// xorshift64*: a tiny deterministic generator, so the property test needs no new crate and
    /// fails reproducibly.
    struct Gen(u64);
    impl Gen {
        fn next(&mut self) -> u64 {
            self.0 ^= self.0 >> 12;
            self.0 ^= self.0 << 25;
            self.0 ^= self.0 >> 27;
            self.0.wrapping_mul(0x2545_f491_4f6c_dd1d)
        }
        fn hlc(&mut self) -> Value {
            const WALLS: [i64; 9] = [
                i64::MIN,
                i64::MIN + 1,
                -1_000,
                -1,
                0,
                1,
                1_000,
                i64::MAX - 1,
                i64::MAX,
            ];
            const COUNTERS: [u64; 6] = [0, 1, 2, u32::MAX as u64, u64::MAX - 1, u64::MAX];
            let wall = if self.next().is_multiple_of(2) {
                WALLS[(self.next() % WALLS.len() as u64) as usize]
            } else {
                self.next() as i64
            };
            let counter = if self.next().is_multiple_of(2) {
                COUNTERS[(self.next() % COUNTERS.len() as u64) as usize]
            } else {
                self.next() % 4
            };
            // Short nodes over a tiny alphabet, so equal nodes, prefixes and multi-byte chars all
            // occur often.
            let len = (self.next() % 4) as usize;
            let node: String = (0..len)
                .map(|_| ['a', 'b', '~', '\u{e9}'][(self.next() % 4) as usize])
                .collect();
            json!({ "wall_ms": wall, "counter": counter, "node": node })
        }
    }

    #[test]
    fn order_bytes_matches_hlc_key() {
        let mut g = Gen(0x9e37_79b9_7f4a_7c15);
        let mut pool: Vec<Value> = (0..400).map(|_| g.hlc()).collect();
        // Missing fields read as 0 / "" in `hlc_key`; the bytes must agree on those too.
        pool.push(json!({}));
        pool.push(json!({ "wall_ms": -1 }));
        for a in &pool {
            for b in &pool {
                assert_eq!(
                    order_bytes(a).cmp(&order_bytes(b)),
                    hlc_key(a).cmp(&hlc_key(b)),
                    "{a} vs {b}"
                );
            }
        }
    }

    #[test]
    fn order_bytes_encoding_is_pinned() {
        let b = order_bytes(&json!({ "wall_ms": 1, "counter": 2, "node": "n" }));
        let mut want = vec![0x80, 0, 0, 0, 0, 0, 0, 1];
        want.extend_from_slice(&[0, 0, 0, 0, 0, 0, 0, 2]);
        want.push(b'n');
        assert_eq!(b, want);
        assert_eq!(
            &order_bytes(&json!({ "wall_ms": -1 }))[..8],
            &[0x7f, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]
        );
    }

    fn tied(uuid: &str, node: &str) -> WireRecord {
        WireRecord {
            uuid: uuid.into(),
            hlc: json!({ "wall_ms": 1_700_000_000_000_i64, "counter": 7, "node": node }),
            ..WireRecord::default()
        }
    }

    #[test]
    fn ord_tie_rule_keeps_wall_and_counter() {
        let ord = tie_ord(&tied("u1", "abcd"));
        let (w, c, node) = hlc_key(&ord);
        assert_eq!((w, c), (1_700_000_000_000, 7));
        assert!(node.starts_with("abcd~"), "{node}");
        assert_eq!(node.len(), "abcd~".len() + 8);
        assert!(node["abcd~".len()..]
            .bytes()
            .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()));
        // The suffix is the first 8 hex of `content_digest([uuid])`.
        assert_eq!(
            &node["abcd~".len()..],
            &crate::canon::content_digest(&["u1"])[..8]
        );
    }

    #[test]
    fn ord_tie_rule_is_deterministic() {
        let a = tie_ord(&tied("same-uuid", "n1"));
        for _ in 0..16 {
            assert_eq!(tie_ord(&tied("same-uuid", "n1")), a);
        }
        // Only (hlc, uuid) matter: the payload is not an input.
        let mut other = tied("same-uuid", "n1");
        other.ct = "ffff".into();
        other.nonce = "00".into();
        other.deleted = true;
        assert_eq!(tie_ord(&other), a);
    }

    #[test]
    fn ord_tie_rule_distinct_for_distinct_uuids() {
        let mut seen = std::collections::BTreeSet::new();
        for i in 0..500 {
            let ord = tie_ord(&tied(&format!("uuid-{i}"), "node"));
            assert!(seen.insert(order_bytes(&ord)), "uuid-{i} collided");
        }
    }

    #[test]
    fn ord_tie_rule_node_within_max_len() {
        let suffix = format!("~{}", &crate::canon::content_digest(&["u"])[..8]);
        for node in [
            "n".repeat(MAX_HLC_NODE_LEN),
            "n".repeat(55),
            "n".repeat(56),
            "\u{e9}".repeat(32),
        ] {
            let ord = tie_ord(&tied("u", &node));
            let out = ord["node"].as_str().unwrap();
            assert!(out.len() <= MAX_HLC_NODE_LEN, "{} bytes", out.len());
            assert!(out.ends_with(&suffix), "{out}");
            assert!(node.starts_with(&out[..out.len() - suffix.len()]));
        }
        // A node that fits is not truncated.
        let ord = tie_ord(&tied("u", &"n".repeat(55)));
        assert_eq!(ord["node"].as_str().unwrap().len(), MAX_HLC_NODE_LEN);
        let ord = tie_ord(&tied("u", "short"));
        assert_eq!(ord["node"].as_str().unwrap(), format!("short{suffix}"));
    }

    /// The client adopts `ord` only if `sync_envelope::ord_is_adoptable` accepts it: it must
    /// deserialize into `Hlc { wall_ms: i64, counter: u32, node: String }` (all three fields
    /// REQUIRED, `counter` within `u32`) and `wall_ms` must be within `MAX_REMOTE_SKEW_MS` (60 s)
    /// of the client's clock. The rule copies `wall_ms` and `counter` from the record's own
    /// `hlc`, which the push path already bounded to the same 60 s window and to `u32`, so the
    /// skew check passes exactly when it would for the record's `hlc`.
    #[test]
    fn ord_tie_rule_is_well_formed() {
        for hlc in [
            json!({ "wall_ms": 1_700_000_000_000_i64, "counter": 7, "node": "abcd" }),
            json!({ "wall_ms": -5, "counter": u32::MAX, "node": "" }),
            json!({}),
        ] {
            let rec = WireRecord {
                uuid: "u".into(),
                hlc: hlc.clone(),
                ..WireRecord::default()
            };
            let ord = tie_ord(&rec);
            assert!(hlc_well_formed(&ord), "{ord}");
            let obj = ord.as_object().unwrap();
            assert_eq!(obj.len(), 3, "every field present: {ord}");
            assert!(obj["wall_ms"].is_i64());
            assert!(obj["counter"]
                .as_u64()
                .is_some_and(|c| c <= u32::MAX as u64));
            assert!(obj["node"].is_string());
            let (w, c, _) = hlc_key(&ord);
            assert_eq!((w, c), (hlc_key(&hlc).0, hlc_key(&hlc).1));
        }
    }
}
