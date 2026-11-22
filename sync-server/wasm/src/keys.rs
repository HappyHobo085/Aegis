//! The service's key layout in `meshnode:kv`. Pure (std + `aegis-sync-core` only), so the
//! Meshnode test harness compiles this same file (`#[path]`) to seed state exactly where the
//! service reads it.
//!
//! Replicated (`meshnode:kv/store`):
//! - `rec/<acct>/<ns>/<uuid>`: one record, written with `set-ordered(order_bytes(hlc))`; the
//!   value is the record's canonical `WireRecord` JSON (never an `ord`; see `records.rs`).
//! - `hlcidx/<acct>/<ns>/<hex(order_bytes(hlc))>/<uuid>`: the tie index, one plain key per
//!   stored record at the hlc it is stored at (value [`HLCIDX_VALUE`]). Written before the
//!   record; once the uuid's record is stored at a newer hlc, or pruned, the old key gets a plain
//!   `delete`, whose mesh tombstone the GC removes after 90 days. So the index is bounded by the
//!   live records plus 90 days of churn. A candidate list for tie detection only: a concurrent
//!   write elsewhere can leave a stale key behind, so every candidate's current record is
//!   re-checked (`store::tied_below`).
//! - `devices/<acct>`: grow-only set of `devices::DeviceFacts` JSON.
//! - `pending/<acct>`, `revoked/<acct>`: grow-only sets of device ids.
//! - `approved/<acct>`: grow-only set of `devices::ApprovedFact` JSON (device id and the
//!   approving node's `now_ms`); the earliest approval of a device is the one that counts.
//! - `labels/<acct>`: grow-only set of `devices::LabelFact` JSON.
//! - `seen/<acct>/<device>/<node-id-hex>`: one node's register of the device's `lastSeenMs`
//!   (decimal); only that node writes it, and the newest across nodes is served.
//! - `tomb/<acct>/<ns>/<hex(order_bytes(hlc))>/<uuid>`: the tombstone index, one key per
//!   stored tombstone, in hlc order, for retention (`retention.rs`). Its value is when a node
//!   first stored the tombstone (decimal node-clock ms; retention's age floor counts from it,
//!   never from the client's stamp). A candidate list: the record itself is re-read before
//!   anything is pruned.
//! - `count/<node-id-hex>/<metric>`: this node's share of a server-wide count (decimal `i64`,
//!   may go negative); the mesh-wide value is the sum over nodes (`caps.rs`).
//!
//! Node-local (`meshnode:kv/local`):
//! - `nonce/<device>/<nonce>`: a spent replay nonce.
//! - `noncecount/<device>/<bucket>`: how many of the device's spent nonces expire within
//!   expiry bucket `<bucket>` (decimal), itself expiring at the bucket's end (`auth.rs`).
//! - [`WARNED_OPEN_REGISTRATION`]: set when the open-registration warning was last logged.
//!
//! `<acct>` and `<device>` are canonical lower-case hex (`check_token` refuses anything else);
//! `<ns>` goes through [`enc_ns`] so it never contains `/`. `<uuid>` is stored raw: it is the
//! last component, and keeping it raw keeps `list-keys` order equal to the native uuid order.
use aegis_sync_core::order::order_bytes;
use serde_json::Value;

/// The replicated store's longest key or set name (`mesh_proto::op::MAX_KEY`).
pub const MAX_KEY: usize = 512;
/// The replicated store's longest `set-ordered` order (`mesh_proto::op::MAX_ORDER`).
pub const MAX_ORDER: usize = 64;

/// `ns` with `%`, `/` and NUL percent-escaped: injective, and never contains `/` (so one
/// namespace's prefix cannot match another's keys) or NUL (which the store refuses).
pub fn enc_ns(ns: &str) -> String {
    let mut out = String::with_capacity(ns.len());
    for c in ns.chars() {
        match c {
            '%' => out.push_str("%25"),
            '/' => out.push_str("%2F"),
            '\0' => out.push_str("%00"),
            c => out.push(c),
        }
    }
    out
}

/// Every record key of one `(acct, ns)` starts with this.
pub fn rec_prefix(acct: &str, ns: &str) -> String {
    format!("rec/{acct}/{}/", enc_ns(ns))
}

/// The key of record `uuid` in `(acct, ns)`.
pub fn rec_key(acct: &str, ns: &str, uuid: &str) -> String {
    format!("{}{uuid}", rec_prefix(acct, ns))
}

/// Every record key of one account, across its namespaces, starts with this.
pub fn account_prefix(acct: &str) -> String {
    format!("rec/{acct}/")
}

/// Every tie-index key of the records stored at `hlc` in `(acct, ns)` starts with this. The
/// trailing `/` keeps one hlc's prefix from matching a longer hlc's keys.
pub fn hlcidx_prefix(acct: &str, ns: &str, hlc: &Value) -> String {
    format!("hlcidx/{acct}/{}/{}/", enc_ns(ns), hex(&order_bytes(hlc)))
}

/// The tie-index key of record `uuid` stored at `hlc` in `(acct, ns)`. Under one prefix the
/// keys sort by uuid (raw, last component), as `store::tied_below` needs.
pub fn hlcidx_key(acct: &str, ns: &str, hlc: &Value, uuid: &str) -> String {
    format!("{}{uuid}", hlcidx_prefix(acct, ns, hlc))
}

/// A tie-index key's value: only the key matters.
pub const HLCIDX_VALUE: &[u8] = b"1";

pub fn devices_set(acct: &str) -> String {
    format!("devices/{acct}")
}

pub fn pending_set(acct: &str) -> String {
    format!("pending/{acct}")
}

pub fn approved_set(acct: &str) -> String {
    format!("approved/{acct}")
}

pub fn revoked_set(acct: &str) -> String {
    format!("revoked/{acct}")
}

pub fn labels_set(acct: &str) -> String {
    format!("labels/{acct}")
}

/// Every `last_seen` register of `device` (one per node) starts with this.
pub fn seen_prefix(acct: &str, device: &str) -> String {
    format!("seen/{acct}/{device}/")
}

/// `node_hex`'s `last_seen` register for `device`.
pub fn seen_key(acct: &str, device: &str, node_hex: &str) -> String {
    format!("{}{node_hex}", seen_prefix(acct, device))
}

/// Every tombstone-index key of one `(acct, ns)` starts with this.
pub fn tomb_prefix(acct: &str, ns: &str) -> String {
    format!("tomb/{acct}/{}/", enc_ns(ns))
}

/// The tombstone-index key of the tombstone `(uuid, hlc)` in `(acct, ns)`. Keys of one
/// namespace sort by hlc (`hex` keeps the byte order, and `/` sorts below every hex digit, so
/// a shorter `order_bytes` that is a prefix of a longer one still sorts first), then uuid.
pub fn tomb_key(acct: &str, ns: &str, hlc: &Value, uuid: &str) -> String {
    format!("{}{}/{uuid}", tomb_prefix(acct, ns), hex(&order_bytes(hlc)))
}

/// Every per-node counter starts with this.
pub const COUNT_PREFIX: &str = "count/";

/// `node_hex`'s share of the server-wide count `metric`.
pub fn count_key(node_hex: &str, metric: &str) -> String {
    format!("{COUNT_PREFIX}{node_hex}/{metric}")
}

/// The `kv/local` key recording a spent `(device, nonce)`.
pub fn nonce_key(device: &str, nonce: &str) -> String {
    format!("nonce/{device}/{nonce}")
}

/// The `kv/local` count of `device`'s spent nonces expiring in expiry bucket `bucket`.
pub fn nonce_count_key(device: &str, bucket: i64) -> String {
    format!("noncecount/{device}/{bucket}")
}

/// Width of a nonce expiry bucket. A spent nonce is counted against its device's cap until
/// the end of the bucket its expiry falls in, so at most this long past its own expiry.
pub const NONCE_BUCKET_MS: i64 = 30_000;

/// The expiry bucket of an entry expiring at `expires_at_ms`.
pub fn nonce_bucket(expires_at_ms: i64) -> i64 {
    expires_at_ms.div_euclid(NONCE_BUCKET_MS)
}

/// The `kv/local` key that throttles the open-registration warning.
pub const WARNED_OPEN_REGISTRATION: &str = "warned/open-registration";

/// Lower-case hex.
pub fn hex(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push(DIGITS[usize::from(b >> 4)] as char);
        out.push(DIGITS[usize::from(b & 0xf)] as char);
    }
    out
}
