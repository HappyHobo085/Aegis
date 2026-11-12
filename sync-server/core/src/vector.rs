//! Contract test vectors: one HTTP exchange (or a short sequence) against a stated starting
//! state, with the status and body every host of this protocol must answer with.
//!
//! **Test-only.** This module exists only with the non-default `vectors` feature, which only
//! test code enables (this crate's own `tests/vectors.rs`, and the native server's
//! `[dev-dependencies]`). Release and WASM builds never contain it.
//!
//! The vectors live in `tests/vectors/*.json` next to this crate's manifest, one file per group
//! (`auth`, `bounds`, `devices`, `healthz`, `records`), and every vector's name starts with its
//! file's group. Three runners use the same files: this crate's `tests/vectors.rs` (a pure model
//! built from the core's functions), the native server's harness (`src/vectors_native.rs`, the
//! real axum router), and Meshnode's harness against the WASM service.
//!
//! ## File format
//!
//! Each file is a JSON array of [`Vector`]s. Before a vector is deserialized, every string in it
//! is expanded (see [`expand`]), so ids, signatures and signed `Authorization` headers are
//! written symbolically and computed from the fixed test keys (`tests/vectors/README.md`):
//!
//! | template | expands to |
//! |---|---|
//! | `{{acct:A}}` | account `A`'s id: its public key, lower-case hex |
//! | `{{dev:D1}}` | device `D1`'s id: its public key, lower-case hex |
//! | `{{regsig:A:D1}}` | `A`'s account-root signature registering `D1` |
//! | `{{auth:A:D1:NONCE}}` | `AegisSig …` signed by `D1`, issued at [`NOW_MS`], valid [`MAX_TTL_MS`] |
//! | `{{auth:A:D1:NONCE:MOD}}` | the same, tampered: `expired`, `bad_sig` or `upper_device` |
//! | `{{repeat:S:N}}` | the string `S` repeated `N` times |
//!
//! Object keys are expanded too (`AccountFacts::approved` is keyed by device id), and an object
//! `{"$repeat": N, "item": X}` becomes an array of `N` copies of `X`. Signing is deterministic
//! (Ed25519), so the same template always expands to the same bytes: repeating an `auth`
//! template with the same nonce is a replay.
use std::collections::BTreeSet;
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::auth::{canonical, AuthToken, MAX_TTL_MS};
use crate::devices::AccountFacts;
use crate::wire::WireRecord;

/// The fixed clock every vector runs at (`Clock::now_ms`). 2027-01-15T08:00:00Z.
pub const NOW_MS: i64 = 1_800_000_000_000;

/// Account names usable in templates and the byte their 32-byte Ed25519 seed is filled with.
pub const ACCOUNT_SEEDS: &[(&str, u8)] = &[("A", 0xa1), ("B", 0xb2)];
/// Device names usable in templates and the byte their 32-byte Ed25519 seed is filled with.
pub const DEVICE_SEEDS: &[(&str, u8)] = &[("D1", 0x11), ("D2", 0x12), ("D3", 0x13), ("D4", 0x14)];

/// Which host a runner drives. A vector marked `native_only` / `mesh_only` runs on one only.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Host {
    /// The axum server in `sync-server/src/main.rs`.
    Native,
    /// The replicated service (Meshnode), and this crate's pure model of it.
    Mesh,
}

/// One contract case.
#[derive(Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Vector {
    pub name: String,
    /// Runs on the native server only; the string is the reason. Use sparingly.
    #[serde(default)]
    pub native_only: Option<String>,
    /// Runs on the mesh service only; the string is the reason. Use sparingly.
    #[serde(default)]
    pub mesh_only: Option<String>,
    #[serde(default)]
    pub given: Given,
    pub request: Req,
    pub expect: Expect,
    /// Further requests against the state the earlier ones left, checked in order.
    #[serde(default)]
    pub then: Vec<Step>,
}

/// The starting state, as facts. A native harness turns these into its stored maps (the owner
/// it stores is [`crate::devices::owner`] of the facts); a mesh harness writes them as its
/// grow-only sets.
#[derive(Clone, Default, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Given {
    /// `(account id, facts)`.
    #[serde(default)]
    pub accounts: Vec<(String, AccountFacts)>,
    /// `(account id, namespace, record)`, stored under `record.uuid`.
    #[serde(default)]
    pub records: Vec<(String, String, WireRecord)>,
}

/// One HTTP request. `path` includes the query string. A `body` is sent as JSON with
/// `content-type: application/json`.
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Req {
    pub method: String,
    pub path: String,
    #[serde(default)]
    pub headers: Vec<(String, String)>,
    #[serde(default)]
    pub body: Option<Value>,
}

/// What the response must be. `body` is an exact match; `body_subset` matches when every key it
/// names is present and matches recursively (see [`subset`]). With neither, only the status is
/// checked (the native server sends an empty body with every error status).
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expect {
    pub status: u16,
    #[serde(default)]
    pub body: Option<Value>,
    #[serde(default)]
    pub body_subset: Option<Value>,
}

/// A follow-up request in [`Vector::then`].
#[derive(Clone, Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Step {
    pub request: Req,
    pub expect: Expect,
}

impl Vector {
    /// Does this vector run on `host`?
    pub fn runs_on(&self, host: Host) -> bool {
        match host {
            Host::Native => self.mesh_only.is_none(),
            Host::Mesh => self.native_only.is_none(),
        }
    }

    /// The request and its expectation, then every `then` step, in order.
    pub fn steps(&self) -> impl Iterator<Item = (&Req, &Expect)> {
        std::iter::once((&self.request, &self.expect))
            .chain(self.then.iter().map(|s| (&s.request, &s.expect)))
    }
}

/// Check one response against `expect`. `body` is the parsed JSON body, `None` when the response
/// had no body (or one that is not JSON).
pub fn check(expect: &Expect, status: u16, body: Option<&Value>) -> Result<(), String> {
    if status != expect.status {
        return Err(format!(
            "status {status}, expected {} (body: {})",
            expect.status,
            body.map_or("<none>".into(), Value::to_string)
        ));
    }
    if let Some(want) = &expect.body {
        if body != Some(want) {
            return Err(format!(
                "body {}, expected exactly {want}",
                body.map_or("<none>".into(), Value::to_string)
            ));
        }
    }
    if let Some(want) = &expect.body_subset {
        if !body.is_some_and(|b| subset(want, b)) {
            return Err(format!(
                "body {}, expected a superset of {want}",
                body.map_or("<none>".into(), Value::to_string)
            ));
        }
    }
    Ok(())
}

/// Does `actual` contain `want`?
///
/// - objects: every key of `want` is in `actual`, with a value that matches recursively (extra
///   keys in `actual` are ignored);
/// - arrays: the same length, and each element of `want` matches a DIFFERENT element of
///   `actual`, in any order (assigned greedily, first match wins), because hosts list devices in
///   no defined order;
/// - anything else: equal.
pub fn subset(want: &Value, actual: &Value) -> bool {
    match (want, actual) {
        (Value::Object(w), Value::Object(a)) => w
            .iter()
            .all(|(k, wv)| a.get(k).is_some_and(|av| subset(wv, av))),
        (Value::Array(w), Value::Array(a)) => {
            if w.len() != a.len() {
                return false;
            }
            let mut used = vec![false; a.len()];
            w.iter().all(|wv| {
                let hit = a
                    .iter()
                    .enumerate()
                    .find(|(i, av)| !used[*i] && subset(wv, av))
                    .map(|(i, _)| i);
                match hit {
                    Some(i) => {
                        used[i] = true;
                        true
                    }
                    None => false,
                }
            })
        }
        _ => want == actual,
    }
}

/// Load, expand and validate every `*.json` vector file in `dir`, in file-name order.
///
/// Panics (this is test code) on an unreadable or malformed file, an unknown template, a vector
/// whose name does not start with its file's group, a duplicate name, a vector marked both
/// `native_only` and `mesh_only`, or a mark with an empty reason.
pub fn load_all(dir: impl AsRef<Path>) -> Vec<Vector> {
    let dir = dir.as_ref();
    let mut files: Vec<_> = std::fs::read_dir(dir)
        .unwrap_or_else(|e| panic!("read {}: {e}", dir.display()))
        .map(|e| e.expect("dir entry").path())
        .filter(|p| p.extension().is_some_and(|x| x == "json"))
        .collect();
    files.sort();
    let mut out = Vec::new();
    let mut names = BTreeSet::new();
    for file in files {
        let group = file
            .file_stem()
            .and_then(|s| s.to_str())
            .expect("utf-8 file name")
            .to_string();
        let text = std::fs::read_to_string(&file)
            .unwrap_or_else(|e| panic!("read {}: {e}", file.display()));
        let raw: Vec<Value> = serde_json::from_str(&text)
            .unwrap_or_else(|e| panic!("{}: not a JSON array of vectors: {e}", file.display()));
        for v in raw {
            let label = v
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("<unnamed>")
                .to_string();
            let vector: Vector = serde_json::from_value(expand(v))
                .unwrap_or_else(|e| panic!("{}: vector {label}: {e}", file.display()));
            assert!(
                vector.name.starts_with(&format!("{group}_")),
                "{}: vector {} must be named {group}_*",
                file.display(),
                vector.name
            );
            assert!(
                names.insert(vector.name.clone()),
                "duplicate vector name {}",
                vector.name
            );
            assert!(
                vector.native_only.is_none() || vector.mesh_only.is_none(),
                "{}: native_only and mesh_only together run nowhere",
                vector.name
            );
            for reason in [&vector.native_only, &vector.mesh_only]
                .into_iter()
                .flatten()
            {
                assert!(
                    !reason.trim().is_empty(),
                    "{}: a host mark needs a reason",
                    vector.name
                );
            }
            out.push(vector);
        }
    }
    out
}

/// Expand templates in every string of `v` (object keys included), and `{"$repeat": N, "item": X}` objects (see the
/// module docs).
pub fn expand(v: Value) -> Value {
    match v {
        Value::String(s) => Value::String(expand_str(&s)),
        Value::Array(a) => Value::Array(a.into_iter().map(expand).collect()),
        Value::Object(m) if m.contains_key("$repeat") => {
            let n = m["$repeat"].as_u64().expect("$repeat takes a count") as usize;
            assert!(
                m.len() == 2 && m.contains_key("item"),
                "$repeat takes exactly a count and an `item`"
            );
            let item = expand(m["item"].clone());
            Value::Array(vec![item; n])
        }
        // Keys too: `AccountFacts::approved` is an object keyed by device id.
        Value::Object(m) => Value::Object(
            m.into_iter()
                .map(|(k, v)| (expand_str(&k), expand(v)))
                .collect::<Map<_, _>>(),
        ),
        other => other,
    }
}

fn expand_str(s: &str) -> String {
    let mut out = String::new();
    let mut rest = s;
    while let Some(start) = rest.find("{{") {
        let end = rest[start..]
            .find("}}")
            .unwrap_or_else(|| panic!("unterminated template in {s:?}"))
            + start;
        out.push_str(&rest[..start]);
        out.push_str(&template(&rest[start + 2..end]));
        rest = &rest[end + 2..];
    }
    out.push_str(rest);
    out
}

fn template(inner: &str) -> String {
    let parts: Vec<&str> = inner.split(':').collect();
    match parts.as_slice() {
        ["acct", a] => account_id(a),
        ["dev", d] => device_id(d),
        ["regsig", a, d] => register_sig(a, d),
        ["auth", a, d, nonce] => auth_header(a, d, nonce, Tamper::None),
        ["auth", a, d, nonce, m] => {
            let tamper = match *m {
                "expired" => Tamper::Expired,
                "bad_sig" => Tamper::BadSig,
                "upper_device" => Tamper::UpperDevice,
                other => panic!("unknown auth modifier {other:?}"),
            };
            auth_header(a, d, nonce, tamper)
        }
        ["repeat", s, n] => s.repeat(n.parse().expect("repeat count")),
        _ => panic!("unknown template {{{{{inner}}}}}"),
    }
}

fn seed(table: &[(&str, u8)], name: &str) -> SigningKey {
    let (_, b) = table
        .iter()
        .find(|(n, _)| *n == name)
        .unwrap_or_else(|| panic!("no test key named {name:?}"));
    SigningKey::from_bytes(&[*b; 32])
}

fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

/// The signing key of test account `name` (see [`ACCOUNT_SEEDS`]).
pub fn account_key(name: &str) -> SigningKey {
    seed(ACCOUNT_SEEDS, name)
}

/// The signing key of test device `name` (see [`DEVICE_SEEDS`]).
pub fn device_key(name: &str) -> SigningKey {
    seed(DEVICE_SEEDS, name)
}

/// Test account `name`'s id: its public key as lower-case hex.
pub fn account_id(name: &str) -> String {
    hex(&account_key(name).verifying_key().to_bytes())
}

/// Test device `name`'s id: its public key as lower-case hex.
pub fn device_id(name: &str) -> String {
    hex(&device_key(name).verifying_key().to_bytes())
}

/// Account `account`'s root signature over `aegis-register-v1\n{account id}\n{device id}`.
pub fn register_sig(account: &str, device: &str) -> String {
    let msg = format!(
        "aegis-register-v1\n{}\n{}",
        account_id(account),
        device_id(device)
    );
    hex(&account_key(account).sign(msg.as_bytes()).to_bytes())
}

/// How [`auth_header`] spoils a token.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Tamper {
    /// A good token.
    None,
    /// Issued `MAX_TTL_MS` before [`NOW_MS`] and expired 1 ms before it.
    Expired,
    /// One bit of the signature flipped.
    BadSig,
    /// The device id spelled in upper-case hex (signed as such, so only the spelling is wrong).
    UpperDevice,
}

/// An `Authorization` header value, `AegisSig {account}.{token hex}.{sig hex}`, for test device
/// `device` on test account `account`, with the token nonce `nonce` verbatim.
pub fn auth_header(account: &str, device: &str, nonce: &str, tamper: Tamper) -> String {
    let key = device_key(device);
    let account_id = account_id(account);
    let (issued_ms, expires_ms) = match tamper {
        Tamper::Expired => (NOW_MS - MAX_TTL_MS, NOW_MS - 1),
        _ => (NOW_MS, NOW_MS + MAX_TTL_MS),
    };
    let mut device_id = hex(&key.verifying_key().to_bytes());
    if tamper == Tamper::UpperDevice {
        device_id = device_id.to_uppercase();
    }
    let token = AuthToken {
        account_id: account_id.clone(),
        device_id,
        issued_ms,
        expires_ms,
        nonce: nonce.to_string(),
    };
    let mut sig = key.sign(&canonical(&token)).to_bytes();
    if tamper == Tamper::BadSig {
        sig[0] ^= 1;
    }
    let token_hex = hex(&serde_json::to_vec(&token).expect("token serializes"));
    format!("AegisSig {account_id}.{token_hex}.{}", hex(&sig))
}
