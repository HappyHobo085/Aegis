//! Device facts to owner, pending and may-remove, for a host that does not STORE an owner.
//!
//! The native server keeps an explicit owner map (set by the first registration, handed on only
//! when the owner signs itself out: D5) and does not use this module. A replicated host cannot
//! keep a single mutable owner slot consistent, so it records grow-only facts (who registered
//! and when, who asked to join, who was approved, who was revoked) and derives the rest here.
//! The rules reproduce the native behaviour:
//!
//! - **Owner** = the earliest-registered device that is a member (not revoked, not still
//!   pending), with the device id as the tie-break. That is "the first device is the owner",
//!   and when the owner signs out (is revoked) the oldest remaining member inherits, exactly as
//!   D5 hands it on.
//! - **Pending** = asked to join, and neither approved nor revoked (rejection is revocation).
//! - **May remove**: removing yourself is always allowed (sign-out); removing anyone else needs
//!   the owner (`403`); the last member cannot be removed (`409`), since revocation is permanent.
use std::collections::BTreeSet;

/// One registration, as recorded when it happened. Grow-only: never edited, never deleted.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct DeviceFacts {
    pub device_id: String,
    pub label: String,
    /// When the device first registered (or first asked to join). Orders the owner choice.
    pub registered_ms: i64,
}

/// Everything known about one account's devices. Each set is grow-only.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct AccountFacts {
    /// Every device that registered or asked to join.
    pub devices: Vec<DeviceFacts>,
    /// Devices that asked to join an existing account (they need the owner's approval).
    pub pending: BTreeSet<String>,
    /// Pending devices the owner approved.
    pub approved: BTreeSet<String>,
    /// Removed or rejected devices; permanent.
    pub revoked: BTreeSet<String>,
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
    f.pending.contains(id) && !f.approved.contains(id) && !f.revoked.contains(id)
}

/// The account's members: registered, not revoked, not still pending.
fn members(f: &AccountFacts) -> impl Iterator<Item = &DeviceFacts> {
    f.devices
        .iter()
        .filter(|d| !f.revoked.contains(&d.device_id) && !is_pending(f, &d.device_id))
}

/// The owner: the earliest-registered member, device id as the tie-break. `None` when the
/// account has no member.
pub fn owner(f: &AccountFacts) -> Option<&str> {
    members(f)
        .min_by(|a, b| (a.registered_ms, &a.device_id).cmp(&(b.registered_ms, &b.device_id)))
        .map(|d| d.device_id.as_str())
}

/// May `actor` remove (or, for a pending device, reject) `target`? Mirrors the native
/// `remove_device`: the owner check first, then the last-member guard. Removing an unknown or
/// already-removed id is allowed (the native server answers `ok` and changes nothing).
pub fn may_remove(f: &AccountFacts, actor: &str, target: &str) -> Result<(), DeviceRefusal> {
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
        f.approved = set(&["member"]);
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
        f.approved = set(&["new"]);
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
        f.approved = set(&["other", "third"]);
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
}
