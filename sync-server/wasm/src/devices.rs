//! `POST /v1/devices`, `GET /v1/devices`, `POST /v1/devices/remove` and
//! `POST /v1/devices/approve`, as the native handlers answer them, over grow-only device facts.
//!
//! The native server stores an owner and edits its device maps in place. The mesh cannot keep
//! one mutable owner slot consistent across replicas, so it only ever ADDS facts (who
//! registered and when, who asked to join, who was approved, who was revoked, label changes:
//! the sets in [`crate::keys`]) and derives the rest with the vendored `devices` rules: the
//! owner ([`owner`]), membership ([`is_member`]), pending ([`is_pending`]), may-remove
//! ([`may_remove`]) and the label ([`label`]). Every decision is over this node's view.
use std::collections::BTreeMap;

use aegis_sync_core::auth::verify_account_root;
use aegis_sync_core::devices::{
    AccountFacts, ApprovedFact, DeviceFacts, LabelFact, is_member, is_pending, label, may_remove,
    owner,
};
use aegis_sync_core::wire::MAX_LABEL_LEN;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::caps::{self, MAX_ACCOUNTS, MAX_PENDING_PER_ACCOUNT};
use crate::http::{Resp, json, status};
use crate::meshnode::kv::store as kv;
use crate::{auth, keys, store};

// ----------------------------------------------------------------------------- register

#[derive(Deserialize)]
struct RegisterDevice {
    #[serde(rename = "accountId")]
    account_id: String,
    #[serde(rename = "deviceId")]
    device_id: String,
    label: String,
    /// Account-root signature over `aegis-register-v1\n{accountId}\n{deviceId}`.
    #[serde(rename = "accountSig")]
    account_sig: String,
}

pub fn post(body: &[u8], authz: Option<&str>) -> Resp {
    match register(body, authz) {
        Ok(pending) => json(&json!({ "ok": true, "pending": pending })),
        Err(code) => status(code),
    }
}

/// Native `post_device`. Everything that can refuse runs inside the admit rule, so a refused
/// registration never spends a replay nonce (anyone can mint device keys). Registration is
/// open: there is no registration secret on the mesh (see `http::warn_open_registration`).
fn register(body: &[u8], authz: Option<&str>) -> Result<bool, u16> {
    // The native `Json<RegisterDevice>` extractor runs before authentication.
    let b: RegisterDevice = serde_json::from_slice(body).map_err(|_| 400u16)?;
    let mut read = None;
    let caller = auth::authenticate(authz, |account, device| {
        if account != b.account_id || device != b.device_id {
            return Err(403);
        }
        if b.label.len() > MAX_LABEL_LEN {
            return Err(413);
        }
        // Proof of root: only a holder of the account key may add a device to it.
        if !verify_account_root(&b.account_id, &b.device_id, &b.account_sig) {
            return Err(403);
        }
        let facts = store::account_facts(account);
        registration_refusal(&facts, device)?;
        read = Some(facts);
        Ok(())
    })?;
    let facts = read.expect("admit ran and passed");
    let (acct, dev) = (caller.account.as_str(), caller.device.as_str());
    let now = auth::now_ms();
    let relabel = |at_ms| {
        let fact = LabelFact {
            device_id: dev.to_string(),
            label: b.label.clone(),
            at_ms,
        };
        let member = serde_json::to_vec(&fact).expect("a LabelFact serializes");
        kv::set_add(&keys::labels_set(acct), &member);
    };
    if is_member(&facts, dev) {
        // Already a member: a re-registration only refreshes the label and last-seen time.
        relabel(now);
        store::touch_seen(acct, dev, now);
        return Ok(false);
    }
    if has_members(&facts) {
        // JOINING AN EXISTING ACCOUNT needs the owner's approval (native D2). Asked before
        // (still pending): the label is refreshed and `registered_ms` kept, as natively.
        if is_pending(&facts, dev) {
            relabel(now);
        } else {
            // WRITE ORDER IS LOAD-BEARING: the `pending` entry BEFORE the `devices` entry. A
            // reader (`store::account_facts`) reads `devices` first, so any replica that sees
            // this device in `devices` already sees it pending, and never counts an
            // unapproved joiner as a member.
            kv::set_add(&keys::pending_set(acct), dev.as_bytes());
            add_device(acct, dev, &b.label, now);
        }
        store::touch_seen(acct, dev, now);
        return Ok(true);
    }
    // A NEW account: this device is its first, and so its owner (`devices::owner` ranks a
    // device that never had to ask first). Two first registrations on different nodes during
    // a split both act as owner until the heal; afterwards the earlier one is (spec §5.2).
    add_device(acct, dev, &b.label, now);
    caps::add(caps::ACCOUNTS, 1);
    store::touch_seen(acct, dev, now);
    Ok(false)
}

fn add_device(acct: &str, dev: &str, label: &str, now: i64) {
    let fact = DeviceFacts {
        device_id: dev.to_string(),
        label: label.to_string(),
        registered_ms: now,
    };
    let member = serde_json::to_vec(&fact).expect("a DeviceFacts serializes");
    kv::set_add(&keys::devices_set(acct), &member);
}

/// Native `registration_refusal`, over facts: why `device` may not register on the account,
/// as the status to answer with.
fn registration_refusal(facts: &AccountFacts, device: &str) -> Result<(), u16> {
    // REVOCATION is permanent: a removed or rejected device still holds the account key, so
    // the deny-list is the only thing that keeps it out.
    if facts.revoked.contains(device) {
        return Err(403);
    }
    if is_member(facts, device) {
        return Ok(()); // a re-registration only refreshes the label
    }
    if has_members(facts) {
        // Joining an existing account: bounded by the pending queue (a device already
        // queued is asking again, not adding to it).
        if !is_pending(facts, device) && pending_ids(facts).len() >= MAX_PENDING_PER_ACCOUNT {
            return Err(429);
        }
        return Ok(());
    }
    // A NEW account: bounded by the server-wide account cap (soft, `caps.rs`).
    if !caps::fits(caps::totals().accounts, 1, MAX_ACCOUNTS as u64) {
        return Err(507);
    }
    Ok(())
}

/// Does the account exist (has at least one member)? The native `account_exists`: a native
/// device map never holds a pending or revoked device.
fn has_members(facts: &AccountFacts) -> bool {
    facts.devices.iter().any(|d| is_member(facts, &d.device_id))
}

/// The distinct ids waiting for approval (the grow-only log may hold one device twice).
fn pending_ids(facts: &AccountFacts) -> Vec<&str> {
    distinct(facts)
        .into_keys()
        .filter(|id| is_pending(facts, id))
        .collect()
}

/// Each registered id once, with its earliest `registered_ms` (the one `owner` ranks by).
fn distinct(facts: &AccountFacts) -> BTreeMap<&str, i64> {
    let mut out: BTreeMap<&str, i64> = BTreeMap::new();
    for d in &facts.devices {
        let ms = out.entry(&d.device_id).or_insert(d.registered_ms);
        *ms = (*ms).min(d.registered_ms);
    }
    out
}

// ----------------------------------------------------------------------------- list

/// Native `get_devices`: the members, the join requests waiting for the owner, and the owner.
pub fn get(authz: Option<&str>) -> Resp {
    let (caller, mut facts) = match auth::authenticate_member(authz) {
        Ok(ok) => ok,
        Err(code) => return status(code),
    };
    facts.labels = store::labels(&caller.account);
    let shape = |id: &str, registered_ms: i64| {
        json!({
            "deviceId": id,
            "label": label(&facts, id).unwrap_or_default(),
            // Native sets `lastSeenMs` when a device registers (= `registeredMs`) and on later
            // registrations and approval; a device no node has touched shows its registration.
            "lastSeenMs": store::last_seen(&caller.account, id).unwrap_or(registered_ms),
            "registeredMs": registered_ms,
        })
    };
    let ids = distinct(&facts);
    let devices: Vec<Value> = ids
        .iter()
        .filter(|(id, _)| is_member(&facts, id))
        .map(|(id, ms)| shape(id, *ms))
        .collect();
    let pending: Vec<Value> = ids
        .iter()
        .filter(|(id, _)| is_pending(&facts, id))
        .map(|(id, ms)| shape(id, *ms))
        .collect();
    json(&json!({ "devices": devices, "pending": pending, "ownerDeviceId": owner(&facts) }))
}

// ----------------------------------------------------------------------------- remove, approve

#[derive(Deserialize)]
struct Target {
    #[serde(rename = "deviceId")]
    device_id: String,
}

/// Native `remove_device`: sign yourself out, or (owner only) remove another member or reject
/// a join request; the last member cannot be removed (`409`). Either way the target is
/// revoked for good. Removing the owner hands the role on by itself: `owner` is derived.
pub fn remove(body: &[u8], authz: Option<&str>) -> Resp {
    let result = (|| {
        let t: Target = serde_json::from_slice(body).map_err(|_| 400u16)?;
        let (caller, facts) = auth::authenticate_member(authz)?;
        may_remove(&facts, &caller.device, &t.device_id).map_err(|e| e.status())?;
        // An unknown or already-removed id is `ok` and changes nothing, as natively.
        if is_pending(&facts, &t.device_id) || is_member(&facts, &t.device_id) {
            kv::set_add(&keys::revoked_set(&caller.account), t.device_id.as_bytes());
        }
        Ok(())
    })();
    match result {
        Ok(()) => json(&json!({ "ok": true })),
        Err(code) => status(code),
    }
}

/// Native `approve_device`: only the owner may approve, and only a device that is waiting
/// (`404` otherwise, so a stale UI cannot believe it admitted one that never asked).
pub fn approve(body: &[u8], authz: Option<&str>) -> Resp {
    let result = (|| {
        let t: Target = serde_json::from_slice(body).map_err(|_| 400u16)?;
        let (caller, facts) = auth::authenticate_member(authz)?;
        if owner(&facts) != Some(caller.device.as_str()) {
            return Err(403);
        }
        if !is_pending(&facts, &t.device_id) {
            return Err(404);
        }
        // The approval carries its time: `owner` ranks approved joiners by WHEN they were
        // admitted, so approving a device that asked earlier never moves the role. The stamp
        // is also kept strictly after every approval this account already has: nodes' clocks
        // differ, and an owner approved on a node whose clock runs ahead would otherwise lose
        // the role to a device it approves on a node whose clock runs behind. The caller is
        // the owner, so its own approval (if it ever needed one) is among those.
        let now = auth::now_ms();
        let after_existing = facts
            .approved
            .values()
            .max()
            .map_or(i64::MIN, |ms| ms.saturating_add(1));
        let fact = ApprovedFact {
            device_id: t.device_id.clone(),
            approved_ms: now.max(after_existing),
        };
        let member = serde_json::to_vec(&fact).expect("an ApprovedFact serializes");
        kv::set_add(&keys::approved_set(&caller.account), &member);
        store::touch_seen(&caller.account, &t.device_id, now);
        Ok(())
    })();
    match result {
        Ok(()) => json(&json!({ "ok": true })),
        Err(code) => status(code),
    }
}
