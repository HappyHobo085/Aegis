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
use tauri::{AppHandle, Runtime};

/// Array stores that participate in sync. History is intentionally absent — it is NOT
/// syncable (product decision): it stays device-local with plain hard-delete storage, so a
/// "clear history" actually removes the URLs rather than leaving tombstones on disk.
/// Downloads are absent too (device-specific savePath; envelope only for delete-hygiene).
pub const SYNCABLE: &[&str] = &["favorites", "saved", "allowlist"];

/// The full local array (incl. tombstones), lazily migrated to carry sync metadata.
pub fn read_all<R: Runtime>(app: &AppHandle<R>, name: &str) -> Vec<Value> {
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
pub fn merge_into<R: Runtime>(app: &AppHandle<R>, name: &str, remote: &[Value]) -> Vec<String> {
    let node = crate::sync_identity::node_id(app);
    let local = read_all(app, name);
    let (mut merged, mut changed) = merge_records(local, remote, &node, crate::jsonstore::now_ms());
    // Collapse cross-device duplicates (same normalized url/host): tombstone the losers so the
    // deletion converges across devices. Idempotent — tombstoned losers are skipped next pass.
    let losers = duplicate_losers(&merged, key_field_for(name));
    if !losers.is_empty() {
        crate::jsonstore::tombstone(
            &mut merged,
            |it| {
                crate::jsonstore::uuid_of(it)
                    .map(|u| losers.iter().any(|l| l == u))
                    .unwrap_or(false)
            },
            app,
        );
        for u in losers {
            if !changed.contains(&u) {
                changed.push(u);
            }
        }
    }
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

/// Normalize a favorites/saved URL for dup detection: drop the #fragment and trailing
/// slashes, trim whitespace. Path + query preserved, no case-folding (so `?id=1` ≠ `?id=2`).
fn normalize_url(u: &str) -> String {
    let no_frag = u.split('#').next().unwrap_or("");
    no_frag.trim().trim_end_matches('/').to_string()
}

/// The dedup key for a record, by namespace field: `"host"` (allowlist) is lowercased; any
/// other field (`"url"`) is URL-normalized.
fn dedup_key(rec: &Value, key_field: &str) -> Option<String> {
    let raw = rec.get(key_field).and_then(Value::as_str)?;
    let key = if key_field == "host" {
        raw.trim().to_lowercase()
    } else {
        normalize_url(raw)
    };
    // A record whose key normalizes to nothing (empty / "#" / "/" / whitespace) is
    // unidentifiable — treat it like a missing key so distinct junk records never group
    // together and get tombstoned.
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Which record field identifies a duplicate, per namespace.
fn key_field_for(name: &str) -> &'static str {
    if name == "allowlist" {
        "host"
    } else {
        "url"
    }
}

/// Among LIVE records, group by normalized key; for each group of >1, keep the deterministic
/// survivor: the highest HLC (`wall_ms`, `counter`, `node` — and `node` is a per-device id, so
/// it almost always decides a cross-device tie); only on a FULL HLC tie does the smaller uuid
/// win. Returns the loser uuids. Pure + convergent: every device computes the same survivor
/// from replicated fields, independent of record order.
fn duplicate_losers(records: &[Value], key_field: &str) -> Vec<String> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<(String, Option<crate::sync_envelope::Hlc>)>> =
        HashMap::new();
    for r in records {
        if crate::jsonstore::is_deleted(r) {
            continue;
        }
        let (Some(key), Some(uuid)) = (dedup_key(r, key_field), crate::jsonstore::uuid_of(r))
        else {
            continue;
        };
        groups
            .entry(key)
            .or_default()
            .push((uuid.to_string(), crate::sync_envelope::from_value(r)));
    }
    let mut losers = Vec::new();
    for (_key, members) in groups {
        if members.len() < 2 {
            continue;
        }
        // Survivor = max by HLC; on an HLC tie the smaller uuid wins (so it ranks as "max").
        let survivor = members
            .iter()
            .enumerate()
            .max_by(|(_, (ua, ha)), (_, (ub, hb))| match ha.cmp(hb) {
                std::cmp::Ordering::Equal => ub.cmp(ua),
                other => other,
            })
            .map(|(i, _)| i)
            .unwrap();
        for (i, (uuid, _)) in members.into_iter().enumerate() {
            if i != survivor {
                losers.push(uuid);
            }
        }
    }
    losers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drec(uuid: &str, key: &str, key_field: &str, wall: i64, deleted: bool) -> Value {
        json!({
            "uuid": uuid,
            key_field: key,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "n" },
            "deleted": deleted,
        })
    }

    #[test]
    fn dedup_keeps_latest_hlc_survivor() {
        let recs = vec![
            drec("a", "http://x/p", "url", 10, false),
            drec("b", "http://x/p", "url", 20, false),
        ];
        assert_eq!(duplicate_losers(&recs, "url"), vec!["a".to_string()]);
    }

    #[test]
    fn dedup_hlc_tie_smaller_uuid_survives() {
        let recs = vec![
            drec("b", "http://x/p", "url", 10, false),
            drec("a", "http://x/p", "url", 10, false),
        ];
        assert_eq!(duplicate_losers(&recs, "url"), vec!["b".to_string()]);
    }

    #[test]
    fn dedup_normalizes_slash_and_fragment() {
        let recs = vec![
            drec("a", "http://x/p/", "url", 10, false),
            drec("b", "http://x/p", "url", 20, false),
            drec("c", "http://x/p#frag", "url", 30, false),
        ];
        let mut losers = duplicate_losers(&recs, "url");
        losers.sort();
        assert_eq!(losers, vec!["a".to_string(), "b".to_string()]); // survivor = c
    }

    #[test]
    fn dedup_distinct_query_not_merged() {
        let recs = vec![
            drec("a", "http://x/p?id=1", "url", 10, false),
            drec("b", "http://x/p?id=2", "url", 20, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_allowlist_host_case_insensitive() {
        let recs = vec![
            drec("a", "Example.com", "host", 10, false),
            drec("b", "example.com", "host", 20, false),
        ];
        assert_eq!(duplicate_losers(&recs, "host"), vec!["a".to_string()]);
    }

    #[test]
    fn dedup_ignores_tombstones_and_singletons() {
        let recs = vec![
            drec("a", "http://x/p", "url", 10, true),
            drec("b", "http://x/p", "url", 20, false),
            drec("c", "http://y", "url", 5, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_skips_empty_normalized_keys() {
        // empty / "#frag" / "/" all normalize to "" → unidentifiable → never grouped or deleted.
        let recs = vec![
            drec("a", "", "url", 10, false),
            drec("b", "#frag", "url", 20, false),
            drec("c", "/", "url", 30, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_node_decides_tie_before_uuid() {
        // Equal wall_ms + counter but different node: the higher node wins (node is compared
        // before the uuid fallback), regardless of which uuid is smaller.
        let recs = vec![
            json!({ "uuid": "aaa", "url": "http://x/p", "deleted": false,
                    "hlc": { "wall_ms": 10, "counter": 0, "node": "zzz" } }),
            json!({ "uuid": "zzz", "url": "http://x/p", "deleted": false,
                    "hlc": { "wall_ms": 10, "counter": 0, "node": "aaa" } }),
        ];
        // node "zzz" > "aaa" → record "aaa" survives; "zzz" (smaller node) is the loser.
        assert_eq!(duplicate_losers(&recs, "url"), vec!["zzz".to_string()]);
    }

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
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("new")
        );

        // Remote older → ignored (no change).
        let local = vec![rec("a", 9, false, "keep")];
        let remote = vec![rec("a", 2, false, "stale")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert!(changed.is_empty());
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("keep")
        );
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
        let ids: Vec<i64> = merged
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(
            ids[0], ids[1],
            "the inserted remote id must be re-keyed: {ids:?}"
        );
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
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("new")
        );
        assert_eq!(
            merged[0].get("id").and_then(Value::as_i64),
            Some(7),
            "local id preserved"
        );
    }

    #[test]
    fn merge_skips_records_missing_uuid_or_hlc() {
        let local: Vec<Value> = vec![];
        let remote = vec![json!({ "payload": "no-meta" }), rec("ok", 1, false, "x")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["ok".to_string()]); // only the well-formed one
        assert_eq!(merged.len(), 1);
    }

    #[test]
    fn key_field_for_picks_host_only_for_allowlist() {
        assert_eq!(key_field_for("allowlist"), "host");
        assert_eq!(key_field_for("favorites"), "url");
        assert_eq!(key_field_for("saved"), "url");
    }
}
