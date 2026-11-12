//! Device facts to owner, pending and may-remove, for a host that does not STORE an owner.
//!
//! The native server keeps an explicit owner map (set by the first registration, handed on only
//! when the owner signs itself out: D5) and does not use this module. A replicated host cannot
//! keep a single mutable owner slot consistent, so it records grow-only facts (who registered
//! and when, who asked to join, who was approved, who was revoked) and derives the rest here.
//! The rules reproduce the native behaviour:
//!
//! - **Owner** = among the members (not revoked, not still pending), a device that never had to
//!   ask to join comes first, by earliest `registered_ms` then lowest id; then the approved
//!   joiners, by earliest APPROVAL (`approved_ms`) then lowest id. That is "the first device is
//!   the owner", and when the owner signs out (is revoked) the longest-standing member inherits,
//!   as D5 hands it on. Two properties make it a stable role rather than a re-ranking:
//!   - A joiner never outranks a device that never had to ask: `registered_ms` is a node's wall
//!     clock, and clock skew between nodes can give an approved joiner an earlier one than the
//!     device that created the account.
//!   - Joiners rank by when they were ADMITTED, not when they asked. Approving a device that
//!     asked earlier therefore never takes the role from the owner that approved it (natively
//!     the owner is a stored slot that only moves on sign-out). Ranking joiners by
//!     `registered_ms` let a later approval hand the account to the device just approved.
//!
//!   Natively the D5 heir is the remaining device with the earliest `registered_ms`; here it is
//!   the earliest-approved one. The two agree whenever joiners were approved in the order they
//!   asked; a host that needs native's exact heir otherwise has no stored owner to give it.
//! - **Member** = registered, not revoked, not still pending ([`is_member`]).
//! - **Pending** = asked to join, and neither approved nor revoked (rejection is revocation).
//! - **May remove**: only a member may act at all (`403`, as the native `require_registered`);
//!   removing yourself is then always allowed (sign-out); removing anyone else needs the owner
//!   (`403`); the last member cannot be removed (`409`), since revocation is permanent.
use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};

/// One registration, as recorded when it happened. Grow-only: never edited, never deleted.
///
/// Serde field names are the Rust ones (`device_id`, `label`, `registered_ms`); every field
/// defaults. The contract vectors (`tests/vectors/`) write their `given` state in this shape.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct DeviceFacts {
    pub device_id: String,
    pub label: String,
    /// When the device first registered (or first asked to join). Orders the owner choice.
    pub registered_ms: i64,
}

/// Everything known about one account's devices. Each set is grow-only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct AccountFacts {
    /// Every device that registered or asked to join.
    pub devices: Vec<DeviceFacts>,
    /// Devices that asked to join an existing account (they need the owner's approval).
    pub pending: BTreeSet<String>,
    /// Pending devices the owner approved, each with WHEN it was approved (`approved_ms`, the
    /// approving node's wall clock): the earliest approval of that device (see
    /// [`AccountFacts::approve`]). The approval time ranks joiners for [`owner`]. Serialized as a
    /// JSON object `{ device_id: approved_ms }`.
    pub approved: BTreeMap<String, i64>,
    /// Removed or rejected devices; permanent.
    pub revoked: BTreeSet<String>,
    /// Label changes after registration: a member re-registering refreshes its label (the native
    /// `post_device` overwrites it). Grow-only like the rest; [`label`] reads the newest.
    pub labels: Vec<LabelFact>,
}

/// One approval: the owner admitted `device_id` at `approved_ms`. A replicated host stores these
/// as grow-only facts (one device may be approved on two nodes) and folds them into
/// [`AccountFacts::approved`] with [`AccountFacts::approve`].
#[derive(Clone, Debug, Default, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(default)]
pub struct ApprovedFact {
    pub device_id: String,
    pub approved_ms: i64,
}

impl AccountFacts {
    /// Folds one approval into [`Self::approved`], keeping the EARLIEST `approved_ms` per
    /// device, so every replica derives the same value from the same set of facts in any order.
    pub fn approve(&mut self, fact: ApprovedFact) {
        let at = self
            .approved
            .entry(fact.device_id)
            .or_insert(fact.approved_ms);
        *at = (*at).min(fact.approved_ms);
    }
}

/// A device's label as set at `at_ms` (a re-registration). Grow-only.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default)]
pub struct LabelFact {
    pub device_id: String,
    pub label: String,
    pub at_ms: i64,
}

/// The label `id` shows now: the newest [`LabelFact`] for it (latest `at_ms`, then the greatest
/// label, so every replica picks the same one from the same set), else the label it registered
/// with. `None` for an id that never registered.
pub fn label<'a>(f: &'a AccountFacts, id: &str) -> Option<&'a str> {
    f.labels
        .iter()
        .filter(|l| l.device_id == id)
        .max_by_key(|l| (l.at_ms, l.label.as_str()))
        .map(|l| l.label.as_str())
        .or_else(|| {
            f.devices
                .iter()
                .find(|d| d.device_id == id)
                .map(|d| d.label.as_str())
        })
}

/// Why [`may_remove`] refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum DeviceRefusal {
    /// Removing another device requires being the owner. Native status `403`.
    NotOwner,
    /// The target is the account's last member. Native status `409`.
    LastDevice,
}

impl DeviceRefusal {
    /// The HTTP status the native server answers with for this refusal.
    pub fn status(self) -> u16 {
        match self {
            DeviceRefusal::NotOwner => 403,
            DeviceRefusal::LastDevice => 409,
        }
    }
}

/// Is `id` waiting for the owner's approval?
pub fn is_pending(f: &AccountFacts, id: &str) -> bool {
    f.pending.contains(id) && !f.approved.contains_key(id) && !f.revoked.contains(id)
}

/// The account's members: registered, not revoked, not still pending.
fn members(f: &AccountFacts) -> impl Iterator<Item = &DeviceFacts> {
    f.devices
        .iter()
        .filter(|d| !f.revoked.contains(&d.device_id) && !is_pending(f, &d.device_id))
}

/// Is `id` a member: registered, not revoked, not still pending? Only a member may use the data
/// endpoints or act on devices (the native `require_registered`, a `403`).
pub fn is_member(f: &AccountFacts, id: &str) -> bool {
    f.devices.iter().any(|d| d.device_id == id) && !f.revoked.contains(id) && !is_pending(f, id)
}

/// The owner, ranked over the members: devices that never had to ask to join (never in
/// `pending`) first, by earliest `registered_ms`; then approved joiners, by earliest
/// `approved_ms`; the lowest device id breaks a tie in either rank. `None` when the account has
/// no member.
///
/// The first rank keeps clock skew from handing the account to a joiner: an approved joiner
/// registered on a node whose clock runs behind can carry an earlier `registered_ms` than the
/// account's creator. Ranking joiners by approval keeps the role where it is when the owner
/// approves a device that asked earlier. Once every never-asked device is revoked, the hand-off
/// falls through to the earliest-approved joiner (native D5 picks the earliest-registered one;
/// see the module docs).
pub fn owner(f: &AccountFacts) -> Option<&str> {
    members(f)
        .min_by_key(|d| {
            let id = d.device_id.as_str();
            // A member in `pending` is approved (else it would not be a member); `MAX` only
            // guards the impossible case, ranking it last.
            let since = if f.pending.contains(id) {
                f.approved.get(id).copied().unwrap_or(i64::MAX)
            } else {
                d.registered_ms
            };
            (f.pending.contains(id), since, id)
        })
        .map(|d| d.device_id.as_str())
}

/// May `actor` remove (or, for a pending device, reject) `target`? Mirrors the native
/// `remove_device`: an actor that is not a member is refused (`NotOwner`, the native `403` from
/// `require_registered`), then the owner check, then the last-member guard. Removing an unknown or
/// already-removed id is allowed (the native server answers `ok` and changes nothing).
pub fn may_remove(f: &AccountFacts, actor: &str, target: &str) -> Result<(), DeviceRefusal> {
    if !is_member(f, actor) {
        return Err(DeviceRefusal::NotOwner);
    }
    if target != actor && owner(f) != Some(actor) {
        return Err(DeviceRefusal::NotOwner);
    }
    if is_pending(f, target) {
        return Ok(()); // a rejection; the members are untouched
    }
    // Distinct ids: a grow-only log may record one device twice.
    let ids: BTreeSet<&str> = members(f).map(|d| d.device_id.as_str()).collect();
    if ids.len() <= 1 && ids.contains(target) {
        return Err(DeviceRefusal::LastDevice);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeSet;

    fn dev(id: &str, registered_ms: i64) -> DeviceFacts {
        DeviceFacts {
            device_id: id.into(),
            label: format!("label {id}"),
            registered_ms,
        }
    }
    fn set(ids: &[&str]) -> BTreeSet<String> {
        ids.iter().map(|s| s.to_string()).collect()
    }
    /// `approved` with each id approved at its `ms`.
    fn approved(ids: &[(&str, i64)]) -> BTreeMap<String, i64> {
        ids.iter().map(|(id, ms)| (id.to_string(), *ms)).collect()
    }
    fn facts(devices: Vec<DeviceFacts>) -> AccountFacts {
        AccountFacts {
            devices,
            ..AccountFacts::default()
        }
    }

    #[test]
    fn owner_is_earliest_registered() {
        let f = facts(vec![dev("b", 300), dev("a", 200), dev("c", 100)]);
        assert_eq!(owner(&f), Some("c"));
        assert_eq!(owner(&AccountFacts::default()), None);
    }

    #[test]
    fn owner_skips_revoked() {
        let mut f = facts(vec![dev("first", 1), dev("second", 2)]);
        f.revoked = set(&["first"]);
        assert_eq!(owner(&f), Some("second"));
        f.revoked = set(&["first", "second"]);
        assert_eq!(owner(&f), None);
    }

    #[test]
    fn owner_tie_breaks_by_id() {
        let f = facts(vec![dev("zz", 5), dev("aa", 5), dev("mm", 5)]);
        assert_eq!(owner(&f), Some("aa"));
    }

    /// D5: the owner signing itself out hands the role to the oldest remaining device, and a
    /// device still waiting for approval is not a remaining device.
    #[test]
    fn owner_handoff_after_self_removal() {
        let mut f = facts(vec![dev("owner", 1), dev("waiting", 2), dev("member", 3)]);
        f.pending = set(&["waiting", "member"]);
        f.approved = approved(&[("member", 4)]);
        assert_eq!(owner(&f), Some("owner"));
        assert_eq!(may_remove(&f, "owner", "owner"), Ok(()));
        f.revoked.insert("owner".into());
        assert_eq!(
            owner(&f),
            Some("member"),
            "the pending device must not inherit"
        );
    }

    #[test]
    fn pending_until_approved() {
        let mut f = facts(vec![dev("owner", 1), dev("new", 2)]);
        f.pending = set(&["new"]);
        assert!(is_pending(&f, "new"));
        assert!(!is_pending(&f, "owner"));
        assert!(!is_pending(&f, "stranger"));
        f.approved = approved(&[("new", 3)]);
        assert!(!is_pending(&f, "new"), "approval ends pending");
        f.approved.clear();
        f.revoked = set(&["new"]);
        assert!(
            !is_pending(&f, "new"),
            "a rejection (revocation) ends pending"
        );
    }

    #[test]
    fn may_remove_last_device_is_409() {
        let f = facts(vec![dev("only", 1)]);
        let err = may_remove(&f, "only", "only").unwrap_err();
        assert_eq!(err, DeviceRefusal::LastDevice);
        assert_eq!(err.status(), 409);
        // A pending device and a revoked one do not count as "another device".
        let mut f = facts(vec![dev("only", 1), dev("asking", 2), dev("gone", 0)]);
        f.pending = set(&["asking"]);
        f.revoked = set(&["gone"]);
        assert_eq!(
            may_remove(&f, "only", "only"),
            Err(DeviceRefusal::LastDevice)
        );
        // ...but the owner may still reject the pending one.
        assert_eq!(may_remove(&f, "only", "asking"), Ok(()));
    }

    #[test]
    fn may_remove_other_requires_owner() {
        let mut f = facts(vec![dev("owner", 1), dev("other", 2), dev("third", 3)]);
        f.approved = approved(&[("other", 4), ("third", 5)]);
        let err = may_remove(&f, "other", "third").unwrap_err();
        assert_eq!(err, DeviceRefusal::NotOwner);
        assert_eq!(err.status(), 403);
        assert_eq!(
            may_remove(&f, "other", "owner"),
            Err(DeviceRefusal::NotOwner)
        );
        assert_eq!(may_remove(&f, "owner", "third"), Ok(()));
        assert_eq!(
            may_remove(&f, "other", "other"),
            Ok(()),
            "signing yourself out is allowed"
        );
    }

    /// Clock skew between mesh nodes can give an approved joiner an EARLIER `registered_ms` than
    /// the device that created the account. A joiner must still never outrank the creator.
    #[test]
    fn owner_ranks_a_never_pending_device_before_an_earlier_joiner() {
        let mut f = facts(vec![dev("creator", 2_000), dev("joiner", 1_000)]);
        f.pending = set(&["joiner"]);
        f.approved = approved(&[("joiner", 1_500)]);
        assert_eq!(owner(&f), Some("creator"));
        // Among joiners (the creator signed out) the earliest APPROVAL wins, then id; when they
        // asked does not matter.
        f.devices.push(dev("later", 3_000));
        f.devices.push(dev("same", 1_000));
        f.pending = set(&["joiner", "later", "same"]);
        f.approved = approved(&[("joiner", 5_000), ("later", 4_000), ("same", 4_000)]);
        f.revoked = set(&["creator"]);
        assert_eq!(owner(&f), Some("later"), "4_000 ties; `later` < `same`");
    }

    /// The review reproduction: D1 creates the account, D2 asks at 10, D3 at 20; D1 approves
    /// only D3 and signs out, so D3 owns the account. D3 then approves D2, which asked EARLIER.
    /// The role must stay with D3 (natively the owner is a stored slot that only moves on
    /// sign-out); ranking joiners by `registered_ms` handed it to D2.
    #[test]
    fn owner_stays_put_after_a_later_approval() {
        let mut f = facts(vec![dev("d1", 1), dev("d2", 10), dev("d3", 20)]);
        f.pending = set(&["d2", "d3"]);
        f.approve(ApprovedFact {
            device_id: "d3".into(),
            approved_ms: 30,
        });
        f.revoked = set(&["d1"]);
        assert_eq!(owner(&f), Some("d3"));
        f.approve(ApprovedFact {
            device_id: "d2".into(),
            approved_ms: 40,
        });
        assert!(is_member(&f, "d2"));
        assert_eq!(
            owner(&f),
            Some("d3"),
            "a later approval does not move the role"
        );
        assert_eq!(may_remove(&f, "d2", "d3"), Err(DeviceRefusal::NotOwner));
        assert_eq!(may_remove(&f, "d3", "d2"), Ok(()));
    }

    /// A device approved on two nodes keeps its earliest approval, whatever order the facts
    /// arrive in.
    #[test]
    fn approve_keeps_the_earliest_approval() {
        let fact = |ms| ApprovedFact {
            device_id: "j".into(),
            approved_ms: ms,
        };
        let mut a = AccountFacts::default();
        a.approve(fact(50));
        a.approve(fact(20));
        a.approve(fact(70));
        let mut b = AccountFacts::default();
        b.approve(fact(70));
        b.approve(fact(20));
        b.approve(fact(50));
        assert_eq!(a.approved, approved(&[("j", 20)]));
        assert_eq!(a, b);
    }

    #[test]
    fn is_member_needs_registered_not_revoked_not_pending() {
        let mut f = facts(vec![dev("m", 1), dev("p", 2), dev("a", 3), dev("r", 4)]);
        f.pending = set(&["p", "a"]);
        f.approved = approved(&[("a", 5)]);
        f.revoked = set(&["r"]);
        assert!(is_member(&f, "m"));
        assert!(is_member(&f, "a"), "approved joiner");
        assert!(!is_member(&f, "p"), "still pending");
        assert!(!is_member(&f, "r"), "revoked");
        assert!(!is_member(&f, "stranger"), "never registered");
    }

    /// Natively a non-member never reaches the removal rules: `require_registered` answers `403`
    /// first. That includes a pending device trying to "sign itself out".
    #[test]
    fn may_remove_refuses_an_actor_that_is_not_a_member() {
        let mut f = facts(vec![
            dev("owner", 1),
            dev("other", 2),
            dev("asking", 3),
            dev("gone", 4),
        ]);
        f.pending = set(&["asking"]);
        f.revoked = set(&["gone"]);
        for actor in ["asking", "gone", "stranger"] {
            assert_eq!(
                may_remove(&f, actor, actor),
                Err(DeviceRefusal::NotOwner),
                "{actor} removing itself"
            );
            assert_eq!(
                may_remove(&f, actor, "other"),
                Err(DeviceRefusal::NotOwner),
                "{actor} removing another"
            );
        }
        assert_eq!(may_remove(&f, "other", "other"), Ok(()));
    }

    #[test]
    fn label_is_the_newest_label_fact_else_the_registration_label() {
        let mut f = facts(vec![dev("a", 1)]);
        assert_eq!(label(&f, "a"), Some("label a"));
        assert_eq!(label(&f, "stranger"), None);
        let lf = |l: &str, at| LabelFact {
            device_id: "a".into(),
            label: l.into(),
            at_ms: at,
        };
        f.labels = vec![lf("new", 20), lf("old", 10)];
        assert_eq!(
            label(&f, "a"),
            Some("new"),
            "latest at_ms, whatever the order"
        );
        f.labels.push(lf("zz", 20));
        assert_eq!(
            label(&f, "a"),
            Some("zz"),
            "an at_ms tie picks the greatest label"
        );
    }
}
