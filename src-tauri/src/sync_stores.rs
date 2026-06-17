//! The merge seam the sync engine (F2b) consumes. F2a freezes this contract:
//!   - `SYNCABLE` — the array stores that sync (each a `load_synced` JSON array of records
//!     carrying `uuid`/`hlc`/`deleted`). `downloads` is intentionally NOT here — its
//!     `savePath` is device-specific (it gets the envelope for delete-hygiene only; §9.4).
//!     The two special projections sync through their own modules: per-key settings
//!     (`settings::sync_records` / `apply_synced`) and the single custom-filter record
//!     (`customfilters`).
//!   - `read_all(app, name)` — the FULL local array incl. tombstones.
//!   - `merge_into(app, name, remote)` — per-uuid HLC last-writer-wins: insert new uuids,
//!     replace when the remote HLC dominates (incl. flipping `deleted`), observe every
//!     remote clock. Returns the changed uuids so the caller can emit a TARGETED
//!     `sync.changed` (never a full reload). An allowlist merge also re-seeds the engine.
// This whole module is the frozen contract the F2b (Phase 3) sync engine consumes; until
// then nothing calls read_all/merge_into/SYNCABLE, which reads as dead code on the Android
// cdylib build (unused pub items warn there, unlike the host rlib).
#![allow(dead_code)]

use serde_json::Value;
use tauri::AppHandle;

/// Array stores that participate in sync. History is intentionally absent — it is NOT
/// syncable (product decision): it stays device-local with plain hard-delete storage, so a
/// "clear history" actually removes the URLs rather than leaving tombstones on disk.
/// Downloads are absent too (device-specific savePath; envelope only for delete-hygiene).
pub const SYNCABLE: &[&str] = &["favorites", "saved", "allowlist"];

/// The full local array (incl. tombstones), lazily migrated to carry sync metadata.
pub fn read_all(app: &AppHandle, name: &str) -> Vec<Value> {
    crate::jsonstore::load_synced(app, name)
}

/// Pure HLC-LWW merge: fold `remote` into `local`, returning the merged array + the
/// uuids that changed. AppHandle-free so the merge rules are deterministically testable.
/// Advances the global HLC clock by observing each remote stamp (so a later local edit
/// dominates a record we just received).
fn merge_records(
    mut local: Vec<Value>,
    remote: &[Value],
    node: &str,
    now_ms: i64,
) -> (Vec<Value>, Vec<String>) {
    let mut changed = Vec::new();
    for r in remote {
        let Some(ruuid) = crate::jsonstore::uuid_of(r) else {
            continue; // a record without a uuid can't be merged
        };
        let Some(rhlc) = crate::sync_envelope::from_value(r) else {
            continue; // nor one without a well-formed hlc
        };
        crate::sync_envelope::observe(node, now_ms, &rhlc);
        // The merge identity is `uuid` (globally unique). The integer `id` is DEVICE-LOCAL
        // (next_id = max+1), so two devices independently assign 1,2,3…; the renderer keys
        // its mutations by `id`, so the merged array must stay id-unique or a `remove {id}`
        // would hit the wrong record. We therefore preserve the LOCAL id on replace and
        // re-key an inserted remote record to a fresh local id. Records without an `id`
        // (e.g. allowlist, keyed by host) are untouched.
        match local
            .iter_mut()
            .find(|l| crate::jsonstore::uuid_of(l) == Some(ruuid))
        {
            Some(l) => {
                // Replace only if the remote strictly dominates (or local lacks an hlc).
                let remote_wins = crate::sync_envelope::from_value(l)
                    .map(|lh| rhlc > lh)
                    .unwrap_or(true);
                if remote_wins {
                    let local_id = l.get("id").cloned();
                    *l = r.clone();
                    if let (Some(id), Some(obj)) = (local_id, l.as_object_mut()) {
                        obj.insert("id".into(), id); // keep the device-local id
                    }
                    changed.push(ruuid.to_string());
                }
            }
            None => {
                let mut incoming = r.clone();
                if incoming.get("id").is_some() {
                    let fresh = crate::jsonstore::next_id(&local);
                    if let Some(obj) = incoming.as_object_mut() {
                        obj.insert("id".into(), Value::from(fresh)); // avoid id collision
                    }
                }
                local.push(incoming);
                changed.push(ruuid.to_string());
            }
        }
    }
    (local, changed)
}

/// Merge `remote` into the local `name` store (HLC-LWW), persist if anything changed, and
/// return the changed uuids. An allowlist merge re-seeds the in-memory allowlist + engine.
pub fn merge_into(app: &AppHandle, name: &str, remote: &[Value]) -> Vec<String> {
    let node = crate::sync_identity::node_id(app);
    let local = read_all(app, name);
    let (merged, changed) = merge_records(local, remote, &node, crate::jsonstore::now_ms());
    if !changed.is_empty() {
        let _ = crate::jsonstore::save(app, name, &merged);
        if name == "allowlist" {
            // The allowlist drives the engine policy → refresh the cache + engine.
            crate::adblock::seed_from_disk(app);
            crate::adblock_refresh::refresh(app);
        }
    }
    changed
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn rec(uuid: &str, wall: i64, deleted: bool, payload: &str) -> Value {
        json!({
            "uuid": uuid,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "remote" },
            "deleted": deleted,
            "payload": payload,
        })
    }

    #[test]
    fn merge_inserts_new_uuids() {
        let local = vec![rec("a", 1, false, "local-a")];
        let remote = vec![rec("b", 1, false, "remote-b")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["b".to_string()]);
        assert_eq!(merged.len(), 2);
    }

    #[test]
    fn merge_replaces_only_when_remote_hlc_dominates() {
        // Remote newer → replace (and the payload updates).
        let local = vec![rec("a", 1, false, "old")];
        let remote = vec![rec("a", 5, false, "new")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["a".to_string()]);
        assert_eq!(merged[0].get("payload").and_then(Value::as_str), Some("new"));

        // Remote older → ignored (no change).
        let local = vec![rec("a", 9, false, "keep")];
        let remote = vec![rec("a", 2, false, "stale")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert!(changed.is_empty());
        assert_eq!(merged[0].get("payload").and_then(Value::as_str), Some("keep"));
    }

    #[test]
    fn merge_propagates_a_remote_tombstone_when_newer() {
        // A newer remote tombstone deletes a live local record.
        let local = vec![rec("a", 1, false, "live")];
        let remote = vec![rec("a", 5, true, "live")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["a".to_string()]);
        assert!(crate::jsonstore::is_deleted(&merged[0]));
        // live() then hides it.
        assert!(crate::jsonstore::live(merged).is_empty());
    }

    #[test]
    fn merge_rekeys_an_inserted_remote_id_to_avoid_collision() {
        // Both devices independently assigned id:1 to DIFFERENT records (different uuids).
        let local = vec![json!({
            "id": 1, "uuid": "local-uuid",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "a" }, "deleted": false
        })];
        let remote = vec![json!({
            "id": 1, "uuid": "remote-uuid",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "b" }, "deleted": false
        })];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["remote-uuid".to_string()]);
        assert_eq!(merged.len(), 2);
        // The two records keep distinct ids so a renderer `remove {id}` can't hit both.
        let ids: Vec<i64> = merged.iter().filter_map(|r| r.get("id").and_then(Value::as_i64)).collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(ids[0], ids[1], "the inserted remote id must be re-keyed: {ids:?}");
    }

    #[test]
    fn merge_preserves_local_id_on_replace() {
        // Same uuid on both devices but different local ids; remote dominates by HLC.
        let local = vec![json!({
            "id": 7, "uuid": "u", "payload": "old",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "a" }, "deleted": false
        })];
        let remote = vec![json!({
            "id": 99, "uuid": "u", "payload": "new",
            "hlc": { "wall_ms": 5, "counter": 0, "node": "b" }, "deleted": false
        })];
        let (merged, _) = merge_records(local, &remote, "n", 100);
        assert_eq!(merged[0].get("payload").and_then(Value::as_str), Some("new"));
        assert_eq!(merged[0].get("id").and_then(Value::as_i64), Some(7), "local id preserved");
    }

    #[test]
    fn merge_skips_records_missing_uuid_or_hlc() {
        let local: Vec<Value> = vec![];
        let remote = vec![json!({ "payload": "no-meta" }), rec("ok", 1, false, "x")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["ok".to_string()]); // only the well-formed one
        assert_eq!(merged.len(), 1);
    }
}
