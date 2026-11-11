//! The record shape on the wire, its HLC ordering keys, and the request/response bounds.
use serde::{Deserialize, Serialize};
use serde_json::Value;

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
pub struct WireRecord {
    #[serde(default)]
    pub uuid: String,
    #[serde(default)]
    pub hlc: Value,
    #[serde(default)]
    pub deleted: bool,
    #[serde(default)]
    pub nonce: String,
    #[serde(default)]
    pub ct: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ord: Option<Value>,
}

/// Total order on the cleartext HLC (wall_ms, counter, node) — matches the client's Hlc Ord.
///
/// Borrows `node` instead of cloning it. This runs inside the per-record comparison loops in
/// [`canonicalize_body`], where the old `String` return allocated once per comparison — tens of
/// millions of allocations on an ordinary full-namespace push.
pub fn hlc_key(hlc: &Value) -> (i64, u64, &str) {
    (
        hlc.get("wall_ms").and_then(Value::as_i64).unwrap_or(0),
        hlc.get("counter").and_then(Value::as_u64).unwrap_or(0),
        hlc.get("node").and_then(Value::as_str).unwrap_or(""),
    )
}

/// The stamp a record is ORDERED by: the server's `ord` when it has one, else the
/// client-supplied `hlc`. For ORDERING COMPARISONS ONLY — this value is never part of an AAD,
/// which is exactly what makes it safe for the server to adjust.
pub fn ord_key(rec: &WireRecord) -> (i64, u64, &str) {
    hlc_key(rec.ord.as_ref().unwrap_or(&rec.hlc))
}

// ----------------------------------------------------------------------------- quotas
// Bound authenticated resource use: a registered-but-malicious paired device (any holder of
// the recovery phrase, or a compromised device) must not be able to OOM the process or fill
// disk. Generous for a personal deployment; tighten via these constants if needed.
pub const MAX_RECORDS_PER_REQUEST: usize = 1000; // records in one POST /v1/records body
pub const MAX_RECORDS_PER_ACCOUNT: usize = 50_000; // total live records an account may hold
pub const MAX_FIELD_LEN: usize = 1024; // ns / uuid / nonce (short ids / hex)
pub const MAX_CT_LEN: usize = 64 * 1024; // ciphertext bytes per record (very generous for one item)
pub const MAX_LABEL_LEN: usize = 256; // device label
pub const MAX_BODY_BYTES: usize = 8 * 1024 * 1024; // coarse request-body backstop (axum layer)
pub const MAX_ACCOUNTS: usize = 10_000; // accounts on the whole server
pub const MAX_TOTAL_RECORDS: usize = 2_000_000; // records across every account
pub const MAX_TOTAL_CT_BYTES: usize = 4 * 1024 * 1024 * 1024; // ciphertext bytes across every account
pub const MAX_PENDING_PER_ACCOUNT: usize = 16; // devices waiting for the owner's approval
/// Response-side quotas for `GET /v1/records`. The write path is capped by
/// `MAX_RECORDS_PER_REQUEST` and `MAX_RECORDS_PER_ACCOUNT`; without a matching READ cap a single
/// authenticated GET could ask the server to clone + re-serialize the whole account
/// (50_000 × 64 KiB ≈ 3.2 GiB) into one buffer. The byte budget is the real bound — a record
/// count alone doesn't account for ciphertext size.
pub const MAX_RESPONSE_RECORDS: usize = 5_000;
pub const MAX_RESPONSE_BYTES: usize = 32 * 1024 * 1024;

/// Bytes one record contributes to a `GET /v1/records` response: its strings plus the
/// SERIALIZED `hlc` and `ord` (not a flat allowance — a record stored before `hlc` was bounded
/// can carry a large one), plus a fixed slack for field names and punctuation.
pub fn wire_bytes(r: &WireRecord) -> usize {
    let json_len = |v: &Value| serde_json::to_vec(v).map_or(0, |b| b.len());
    r.ct.len()
        + r.uuid.len()
        + r.nonce.len()
        + json_len(&r.hlc)
        + r.ord.as_ref().map_or(0, json_len)
        + 64
}

/// Longest `hlc.node` accepted. A client's node id is a short hex string.
pub const MAX_HLC_NODE_LEN: usize = 64;

/// Is `hlc` the shape a client sends — `{wall_ms: i64, counter: u64, node: string<=64}` — with
/// no other keys? A MISSING field is accepted (LWW reads it as 0, i.e. the past, which is
/// harmless — see `reject_client_poisoning_stamps`); a WRONG one is not. `hlc` is cleartext the
/// server stores and serves to every peer, so before this it was an unbounded caller-chosen
/// `Value`, outside every field quota.
pub fn hlc_well_formed(hlc: &Value) -> bool {
    let Some(obj) = hlc.as_object() else {
        return false;
    };
    obj.iter().all(|(k, v)| match k.as_str() {
        "wall_ms" => v.is_i64(),
        "counter" => v.is_u64(),
        "node" => v.as_str().is_some_and(|n| n.len() <= MAX_HLC_NODE_LEN),
        _ => false,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(uuid: &str, ct: &str) -> WireRecord {
        WireRecord {
            ord: None,
            uuid: uuid.into(),
            hlc: json!({ "wall_ms": 1, "counter": 0, "node": "n" }),
            deleted: false,
            nonce: "n".into(),
            ct: ct.into(),
        }
    }

    #[test]
    fn hlc_well_formed_cases() {
        for bad in [
            json!("a string"),
            json!({ "wall_ms": 1, "counter": 0, "node": "n", "extra": "x" }),
            json!({ "wall_ms": 1, "counter": 0, "node": "n".repeat(MAX_HLC_NODE_LEN + 1) }),
            json!({ "wall_ms": "1", "counter": 0, "node": "n" }),
            json!({ "wall_ms": 1, "counter": -1, "node": "n" }),
            json!({ "wall_ms": 1, "counter": 0, "node": 5 }),
        ] {
            assert!(!hlc_well_formed(&bad), "{bad} must be refused");
        }
        for good in [
            json!({ "wall_ms": 1, "counter": 0, "node": "n" }),
            json!({ "counter": 0, "node": "n".repeat(MAX_HLC_NODE_LEN) }),
            json!({}),
        ] {
            assert!(hlc_well_formed(&good), "{good} must be accepted");
        }
    }

    #[test]
    fn wire_bytes_counts_hlc_and_ord() {
        // ct 2 + uuid 1 + nonce 1 + `{"counter":0,"node":"n","wall_ms":1}` (36) + 64 slack.
        let mut r = rec("u", "aa");
        assert_eq!(wire_bytes(&r), 104);
        r.ord = Some(r.hlc.clone());
        assert_eq!(wire_bytes(&r), 140);
        r.hlc = json!({ "wall_ms": 1, "counter": 0, "node": "n".repeat(10_000) });
        r.ord = Some(json!({ "wall_ms": 1, "counter": 0, "node": "o".repeat(10_000) }));
        assert!(wire_bytes(&r) >= 20_000, "got {}", wire_bytes(&r));
    }

    #[test]
    fn hlc_and_ord_keys() {
        let mut r = rec("u", "aa");
        r.hlc = json!({ "wall_ms": 5, "counter": 2, "node": "a" });
        assert_eq!(hlc_key(&r.hlc), (5, 2, "a"));
        assert_eq!(ord_key(&r), (5, 2, "a"));
        r.ord = Some(json!({ "wall_ms": 5, "counter": 3, "node": "a" }));
        assert_eq!(ord_key(&r), (5, 3, "a"));
        assert_eq!(hlc_key(&json!({})), (0, 0, ""));
    }

    #[test]
    fn wire_record_defaults_every_field_and_skips_absent_ord() {
        let r: WireRecord = serde_json::from_str("{}").unwrap();
        assert_eq!(r.uuid, "");
        assert!(r.ord.is_none());
        let out = serde_json::to_value(&r).unwrap();
        assert!(out.get("ord").is_none());
    }
}
