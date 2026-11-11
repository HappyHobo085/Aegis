//! The core's contract-vector runner: every vector that runs on the mesh, driven through a small
//! in-memory model of the protocol built ONLY from this crate's functions (`check_token`,
//! `verify_account_root`, the bounds, `reject_client_poisoning_stamps`, `canonicalize_body`,
//! `hlc_key`, `tie_ord`, `page_sorted`, and the `devices` rules over grow-only facts).
//!
//! It is the pure-function level of the contract: what a host built on this crate answers when it
//! keeps facts instead of a stored owner and breaks ties with `tie_ord`, as the mesh service does.
//! The native server is checked against the same files by `src/vectors_native.rs`; Meshnode runs
//! them against its WASM service.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use aegis_sync_core::auth::{check_token, unhex, verify_account_root, AuthToken};
use aegis_sync_core::canon::{canonicalize_body, reject_client_poisoning_stamps};
use aegis_sync_core::devices::{
    is_member, is_pending, may_remove, owner, AccountFacts, DeviceFacts,
};
use aegis_sync_core::env::Entropy;
use aegis_sync_core::order::tie_ord;
use aegis_sync_core::page::page_sorted;
use aegis_sync_core::vector::{self, Host, Req, Vector, NOW_MS};
use aegis_sync_core::wire::{
    hlc_key, hlc_well_formed, WireRecord, MAX_CT_LEN, MAX_FIELD_LEN, MAX_LABEL_LEN,
    MAX_PENDING_PER_ACCOUNT, MAX_RECORDS_PER_REQUEST, MAX_RESPONSE_RECORDS,
};
use serde_json::{json, Value};

fn vectors() -> Vec<Vector> {
    vector::load_all(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/vectors"))
}

/// The brief's minimum set, plus the extra cases added with it. A rename must be deliberate.
const REQUIRED: &[&str] = &[
    "healthz_ok",
    "auth_missing_401",
    "auth_expired_401",
    "auth_bad_sig_401",
    "auth_uppercase_hex_401",
    "devices_first_registration_owner",
    "devices_second_pending",
    "devices_approve_by_owner",
    "devices_approve_by_non_owner_403",
    "devices_remove_last_409",
    "devices_revoked_reregister_403",
    "devices_owner_self_remove_handoff",
    "records_push_then_get",
    "records_stale_push_loses",
    "records_tombstone_wins_by_hlc",
    "records_poisoned_stamp_dropped",
    "records_client_ord_ignored",
    "records_paging_cursor",
    "bounds_too_many_records_413",
    "bounds_ct_too_large_413",
    "bounds_bad_hlc_400",
];

/// Host marks must stay few: each one is a place where the two hosts are allowed to disagree.
const MAX_HOST_MARKS: usize = 2;

#[test]
fn the_vector_set_is_complete_and_host_marks_are_few() {
    let vs = vectors();
    let names: BTreeSet<&str> = vs.iter().map(|v| v.name.as_str()).collect();
    for want in REQUIRED {
        assert!(names.contains(want), "missing vector {want}");
    }
    let marked: Vec<&str> = vs
        .iter()
        .filter(|v| v.native_only.is_some() || v.mesh_only.is_some())
        .map(|v| v.name.as_str())
        .collect();
    assert!(
        marked.len() <= MAX_HOST_MARKS,
        "too many host-specific vectors: {marked:?}"
    );
}

/// The templates expand to what the auth checks accept, and each tamper fails the check it names.
#[test]
fn the_templates_sign_with_the_fixed_keys_at_the_fixed_clock() {
    use aegis_sync_core::auth::AuthError;
    use aegis_sync_core::vector::{auth_header, register_sig, Tamper};
    let parse = |h: &str| {
        let rest = h.strip_prefix("AegisSig ").unwrap();
        let mut p = rest.splitn(3, '.');
        let (acct, tok, sig) = (p.next().unwrap(), p.next().unwrap(), p.next().unwrap());
        let token: AuthToken = serde_json::from_slice(&unhex(tok).unwrap()).unwrap();
        assert_eq!(token.account_id, acct);
        check_token(&token, NOW_MS, sig)
    };
    let ok = parse(&auth_header("A", "D1", "01", Tamper::None)).unwrap();
    assert_eq!(ok.account_id, vector::account_id("A"));
    assert_eq!(ok.device_id, vector::device_id("D1"));
    assert_eq!(ok.expires_ms, NOW_MS + 300_000);
    let err = |t| parse(&auth_header("A", "D1", "01", t)).unwrap_err();
    assert_eq!(err(Tamper::Expired), AuthError::Expired);
    assert_eq!(err(Tamper::BadSig), AuthError::BadSignature);
    assert_eq!(err(Tamper::UpperDevice), AuthError::NonCanonicalId);
    assert!(verify_account_root(
        &vector::account_id("A"),
        &vector::device_id("D2"),
        &register_sig("A", "D2")
    ));
    assert_eq!(
        auth_header("A", "D1", "01", Tamper::None),
        auth_header("A", "D1", "01", Tamper::None),
        "signing is deterministic, so a repeated template is a replay"
    );
}

#[test]
fn body_subset_matches_arrays_in_any_order() {
    use aegis_sync_core::vector::subset;
    let actual = json!({ "d": [{ "id": "b", "x": 1 }, { "id": "a", "x": 2 }], "o": "a" });
    assert!(subset(
        &json!({ "d": [{ "id": "a" }, { "id": "b" }] }),
        &actual
    ));
    assert!(
        !subset(&json!({ "d": [{ "id": "a" }] }), &actual),
        "length differs"
    );
    assert!(!subset(
        &json!({ "d": [{ "id": "a" }, { "id": "a" }] }),
        &actual
    ));
    assert!(!subset(&json!({ "missing": null }), &actual));
}

#[test]
fn every_mesh_vector_passes_against_the_core_model() {
    let mut ran = 0;
    let mut failures = Vec::new();
    for v in vectors() {
        if !v.runs_on(Host::Mesh) {
            continue;
        }
        ran += 1;
        let mut model = Model::from(&v);
        for (i, (req, expect)) in v.steps().enumerate() {
            let (status, body) = model.handle(req);
            if let Err(e) = vector::check(expect, status, body.as_ref()) {
                failures.push(format!(
                    "{} step {i} ({} {}): {e}",
                    v.name, req.method, req.path
                ));
                break;
            }
        }
    }
    assert!(ran > 0);
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

// ---------------------------------------------------------------------------------- the model

struct NoEntropy;
impl Entropy for NoEntropy {
    fn fill(&mut self, buf: &mut [u8]) {
        buf.fill(0);
    }
}

type Resp = (u16, Option<Value>);

#[derive(Default)]
struct Model {
    accounts: BTreeMap<String, AccountFacts>,
    /// `(account, ns, uuid)`, so a range over `(account, ns)` is already in uuid order.
    records: BTreeMap<(String, String, String), WireRecord>,
    nonces: HashSet<(String, String)>,
}

impl From<&Vector> for Model {
    fn from(v: &Vector) -> Model {
        let mut m = Model::default();
        for (acct, facts) in &v.given.accounts {
            m.accounts.insert(acct.clone(), facts.clone());
        }
        for (acct, ns, rec) in &v.given.records {
            m.records
                .insert((acct.clone(), ns.clone(), rec.uuid.clone()), rec.clone());
        }
        m
    }
}

fn header<'a>(req: &'a Req, name: &str) -> Option<&'a str> {
    req.headers
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(name))
        .map(|(_, v)| v.as_str())
}

fn query(path: &str) -> (&str, BTreeMap<&str, &str>) {
    let (p, q) = path.split_once('?').unwrap_or((path, ""));
    let params = q.split('&').filter_map(|kv| kv.split_once('=')).collect();
    (p, params)
}

impl Model {
    fn facts(&self, acct: &str) -> AccountFacts {
        self.accounts.get(acct).cloned().unwrap_or_default()
    }

    /// Header parse, `check_token` at the fixed clock, the caller's admit rule, then the replay
    /// check and record: the native `verify_auth` order.
    fn auth(
        &mut self,
        req: &Req,
        admit: impl FnOnce(&Model, &str, &str) -> Result<(), u16>,
    ) -> Result<(String, String), u16> {
        let raw = header(req, "authorization").ok_or(401u16)?;
        let rest = raw.strip_prefix("AegisSig ").ok_or(401u16)?;
        let mut parts = rest.splitn(3, '.');
        let (Some(acct), Some(tok), Some(sig)) = (parts.next(), parts.next(), parts.next()) else {
            return Err(401);
        };
        let token: AuthToken = unhex(tok)
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or(401u16)?;
        if token.account_id != acct {
            return Err(401);
        }
        let ok = check_token(&token, NOW_MS, sig).map_err(|_| 401u16)?;
        admit(self, &ok.account_id, &ok.device_id)?;
        if !self.nonces.insert((ok.device_id.clone(), ok.nonce.clone())) {
            return Err(401);
        }
        Ok((ok.account_id, ok.device_id))
    }

    fn member(m: &Model, a: &str, d: &str) -> Result<(), u16> {
        if is_member(&m.facts(a), d) {
            Ok(())
        } else {
            Err(403)
        }
    }

    fn handle(&mut self, req: &Req) -> Resp {
        let (path, q) = query(&req.path);
        let body = req.body.clone().unwrap_or(Value::Null);
        let r = match (req.method.as_str(), path) {
            ("GET", "/healthz") => Ok(json!({ "ok": true })),
            ("GET", "/v1/records") => self.get_records(req, &q),
            ("POST", "/v1/records") => self.post_records(req, &body),
            ("GET", "/v1/devices") => self.get_devices(req),
            ("POST", "/v1/devices") => self.post_device(req, &body),
            ("POST", "/v1/devices/remove") => self.remove_device(req, &body),
            ("POST", "/v1/devices/approve") => self.approve_device(req, &body),
            _ => Err(404),
        };
        match r {
            Ok(v) => (200, Some(v)),
            Err(s) => (s, None),
        }
    }

    fn get_records(&mut self, req: &Req, q: &BTreeMap<&str, &str>) -> Result<Value, u16> {
        let ns = q.get("ns").copied().ok_or(400u16)?.to_string();
        let limit = match q.get("limit") {
            Some(l) => l.parse::<usize>().map_err(|_| 400u16)?,
            None => MAX_RESPONSE_RECORDS,
        };
        let cursor = q.get("cursor").map(|c| c.to_string());
        let (acct, _) = self.auth(req, Model::member)?;
        if ns.is_empty() {
            return Err(400);
        }
        if ns.len() > MAX_FIELD_LEN || cursor.as_ref().is_some_and(|c| c.len() > MAX_FIELD_LEN) {
            return Err(413);
        }
        let in_ns: Vec<&WireRecord> = self
            .records
            .range((acct.clone(), ns.clone(), String::new())..)
            .take_while(|((a, n, _), _)| *a == acct && *n == ns)
            .map(|(_, r)| r)
            .collect();
        // The mesh tie rule: a record whose full HLC another record in the namespace also holds,
        // under a LOWER uuid, is served with `tie_ord` (where the native server would have
        // reserved a counter).
        let served: Vec<WireRecord> = in_ns
            .iter()
            .map(|r| {
                let mut r = (*r).clone();
                let tied_below = in_ns
                    .iter()
                    .any(|o| o.uuid < r.uuid && hlc_key(&o.hlc) == hlc_key(&r.hlc));
                r.ord = tied_below.then(|| tie_ord(&r));
                r
            })
            .collect();
        let page = page_sorted(served.iter(), cursor.as_deref(), limit);
        Ok(json!({ "records": page.records, "next": page.next }))
    }

    fn post_records(&mut self, req: &Req, body: &Value) -> Result<Value, u16> {
        let ns = body
            .get("ns")
            .and_then(Value::as_str)
            .ok_or(400u16)?
            .to_string();
        let records: Vec<WireRecord> =
            serde_json::from_value(body.get("records").cloned().unwrap_or(Value::Null))
                .map_err(|_| 400u16)?;
        let (acct, _) = self.auth(req, Model::member)?;
        if ns.is_empty() {
            return Err(400);
        }
        if records.len() > MAX_RECORDS_PER_REQUEST || ns.len() > MAX_FIELD_LEN {
            return Err(413);
        }
        let mut records = records;
        for r in &mut records {
            if r.uuid.len() > MAX_FIELD_LEN
                || r.nonce.len() > MAX_FIELD_LEN
                || r.ct.len() > MAX_CT_LEN
            {
                return Err(413);
            }
            if !hlc_well_formed(&r.hlc) {
                return Err(400);
            }
            r.ord = None;
        }
        let existing: Vec<(String, WireRecord)> = self
            .records
            .iter()
            .filter(|((a, n, _), _)| *a == acct && *n == ns)
            .map(|((_, _, u), r)| (u.clone(), r.clone()))
            .collect();
        let incoming = canonicalize_body(
            reject_client_poisoning_stamps(records, NOW_MS),
            &ns,
            existing.iter().map(|(u, r)| (u.as_str(), r)),
            &mut NoEntropy,
        );
        for (uuid, mut rec) in incoming {
            // The mesh orders ties at read time with `tie_ord`; the native counter bump is not
            // stored.
            rec.ord = None;
            let key = (acct.clone(), ns.clone(), uuid.clone());
            let keep = self
                .records
                .get(&key)
                .is_none_or(|old| hlc_key(&rec.hlc) > hlc_key(&old.hlc));
            if keep {
                rec.uuid = uuid;
                self.records.insert(key, rec);
            }
        }
        Ok(json!({ "ok": true }))
    }

    fn get_devices(&mut self, req: &Req) -> Result<Value, u16> {
        let (acct, _) = self.auth(req, Model::member)?;
        let f = self.facts(&acct);
        let shape = |d: &DeviceFacts| {
            json!({
                "deviceId": d.device_id,
                "label": d.label,
                "lastSeenMs": d.registered_ms,
                "registeredMs": d.registered_ms,
            })
        };
        let devices: Vec<Value> = f
            .devices
            .iter()
            .filter(|d| is_member(&f, &d.device_id))
            .map(shape)
            .collect();
        let pending: Vec<Value> = f
            .devices
            .iter()
            .filter(|d| is_pending(&f, &d.device_id))
            .map(shape)
            .collect();
        Ok(json!({ "devices": devices, "pending": pending, "ownerDeviceId": owner(&f) }))
    }

    fn post_device(&mut self, req: &Req, body: &Value) -> Result<Value, u16> {
        let field = |k: &str| body.get(k).and_then(Value::as_str).map(str::to_string);
        let (Some(b_acct), Some(b_dev), Some(label), Some(sig)) = (
            field("accountId"),
            field("deviceId"),
            field("label"),
            field("accountSig"),
        ) else {
            return Err(400);
        };
        let (acct, dev) = self.auth(req, |m, a, d| {
            if a != b_acct || d != b_dev {
                return Err(403);
            }
            if label.len() > MAX_LABEL_LEN {
                return Err(413);
            }
            if !verify_account_root(&b_acct, &b_dev, &sig) {
                return Err(403);
            }
            let f = m.facts(a);
            if f.revoked.contains(d) {
                return Err(403);
            }
            let has_members = f.devices.iter().any(|x| is_member(&f, &x.device_id));
            if has_members && !is_member(&f, d) && !is_pending(&f, d) {
                let queued = f
                    .devices
                    .iter()
                    .filter(|x| is_pending(&f, &x.device_id))
                    .count();
                if queued >= MAX_PENDING_PER_ACCOUNT {
                    return Err(429);
                }
            }
            Ok(())
        })?;
        let f = self.accounts.entry(acct).or_default();
        if is_member(f, &dev) {
            return Ok(json!({ "ok": true, "pending": false }));
        }
        let has_members = f.devices.iter().any(|x| is_member(f, &x.device_id));
        if !f.devices.iter().any(|x| x.device_id == dev) {
            f.devices.push(DeviceFacts {
                device_id: dev.clone(),
                label,
                registered_ms: NOW_MS,
            });
        }
        if has_members {
            f.pending.insert(dev);
        }
        Ok(json!({ "ok": true, "pending": has_members }))
    }

    fn target(body: &Value) -> Result<String, u16> {
        body.get("deviceId")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or(400)
    }

    fn remove_device(&mut self, req: &Req, body: &Value) -> Result<Value, u16> {
        let target = Model::target(body)?;
        let (acct, actor) = self.auth(req, Model::member)?;
        let f = self.accounts.entry(acct).or_default();
        may_remove(f, &actor, &target).map_err(|e| e.status())?;
        if is_pending(f, &target) || is_member(f, &target) {
            f.revoked.insert(target);
        }
        Ok(json!({ "ok": true }))
    }

    fn approve_device(&mut self, req: &Req, body: &Value) -> Result<Value, u16> {
        let target = Model::target(body)?;
        let (acct, actor) = self.auth(req, Model::member)?;
        let f = self.accounts.entry(acct).or_default();
        if owner(f) != Some(actor.as_str()) {
            return Err(403);
        }
        if !is_pending(f, &target) {
            return Err(404);
        }
        f.approved.insert(target);
        Ok(json!({ "ok": true }))
    }
}
