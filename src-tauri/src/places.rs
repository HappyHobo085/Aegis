//! Favorites + saved-items repos (favorites.* / saved.* IPC), backed by the JSON
//! store. Each mutation returns the full updated collection (matching AegisApi).
//!
//! Syncable (F2a): records carry uuid/hlc/deleted. Mutations load the FULL array via
//! `load_synced` (incl. tombstones), persist the full array, and return only `live`
//! records to the renderer; deletes become tombstones; edits bump the hlc via `touch`.
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::jsonstore;

fn id_of(item: &Value) -> Option<i64> {
    item.get("id").and_then(Value::as_i64)
}

fn merge_into(item: &mut Value, partial: Option<&Value>) {
    if let (Some(obj), Some(p)) = (item.as_object_mut(), partial.and_then(Value::as_object)) {
        for (k, v) in p {
            obj.insert(k.clone(), v.clone());
        }
    }
}

/// Whether any LIVE (non-tombstoned) record matches `url`.
fn live_has_url(items: &[Value], url: &str) -> bool {
    items
        .iter()
        .any(|it| !jsonstore::is_deleted(it) && it.get("url").and_then(Value::as_str) == Some(url))
}

/// Dispatch a `favorites.*` / `saved.*` channel. Mutations persist the full array
/// (tombstones included) and nudge a background sync pass (no-op when sync is disabled).
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        // ---- favorites ----
        "favorites.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app,
            "favorites"
        ))))),

        "favorites.add" => {
            let mut items = jsonstore::load_synced(app, "favorites");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let id = jsonstore::next_id_optimized(&items, "favorites");
            // Position = end of the LIVE list (tombstones don't occupy a slot).
            let position = items.iter().filter(|it| !jsonstore::is_deleted(it)).count() as i64;
            let mut item = json!({
                "id": id,
                "name": input.get("name").and_then(Value::as_str).unwrap_or(""),
                "url": input.get("url").and_then(Value::as_str).unwrap_or(""),
                "position": position
            });
            jsonstore::stamp_new(&mut item, app);
            items.push(item);
            Some(persist(app, "favorites", items))
        }

        "favorites.update" => {
            let mut items = jsonstore::load_synced(app, "favorites");
            let id = payload.get("id").and_then(Value::as_i64);
            for it in items.iter_mut() {
                if id_of(it) == id {
                    merge_into(it, payload.get("partial"));
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "favorites", items))
        }

        "favorites.remove" => {
            let mut items = jsonstore::load_synced(app, "favorites");
            let id = payload.get("id").and_then(Value::as_i64);
            jsonstore::tombstone(&mut items, |it| id_of(it) == id, app);
            Some(persist(app, "favorites", items))
        }

        "favorites.reorder" => {
            let mut items = jsonstore::load_synced(app, "favorites");
            let order: Vec<i64> = payload
                .get("ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            // Live rows sort by the requested order; tombstones sink to the end (MAX).
            items.sort_by_key(|it| {
                let id = id_of(it).unwrap_or(0);
                order.iter().position(|x| *x == id).unwrap_or(usize::MAX)
            });
            // Reassign positions over the LIVE rows only, bumping each row's hlc.
            let mut pos: i64 = 0;
            for it in items.iter_mut() {
                if jsonstore::is_deleted(it) {
                    continue;
                }
                if let Some(o) = it.as_object_mut() {
                    o.insert("position".into(), json!(pos));
                }
                pos += 1;
                jsonstore::touch(it, app);
            }
            Some(persist(app, "favorites", items))
        }

        // ---- saved (with tags) ----
        "saved.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app, "saved"
        ))))),

        "saved.has" => {
            let items = jsonstore::load_synced(app, "saved");
            let url_str = payload.get("url").and_then(Value::as_str).unwrap_or("");
            Some(Ok(json!(live_has_url(&items, url_str))))
        }

        "saved.add" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            // Dedup against LIVE records only (a previously-removed url can be re-added).
            let url_str = input.get("url").and_then(Value::as_str).unwrap_or("");
            if !live_has_url(&items, url_str) {
                let id = jsonstore::next_id_optimized(&items, "saved");
                let mut item = json!({
                    "id": id,
                    "url": url_str,
                    "title": input.get("title").and_then(Value::as_str).unwrap_or(""),
                    "tags": input.get("tags").cloned().unwrap_or_else(|| json!([])),
                    "savedAt": jsonstore::now_ms()
                });
                jsonstore::stamp_new(&mut item, app);
                items.push(item);
            }
            Some(persist(app, "saved", items))
        }

        "saved.remove" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let id = payload.get("id").and_then(Value::as_i64);
            jsonstore::tombstone(&mut items, |it| id_of(it) == id, app);
            Some(persist(app, "saved", items))
        }

        "saved.update" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let id = payload.get("id").and_then(Value::as_i64);
            for it in items.iter_mut() {
                if id_of(it) == id {
                    merge_into(it, payload.get("partial"));
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.renameTag" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let old = payload.get("oldT").and_then(Value::as_str).unwrap_or("");
            let new = payload.get("newT").and_then(Value::as_str).unwrap_or("");
            for it in items.iter_mut() {
                let mut changed = false;
                if let Some(tags) = it.get_mut("tags").and_then(Value::as_array_mut) {
                    for t in tags.iter_mut() {
                        if t.as_str() == Some(old) {
                            *t = json!(new);
                            changed = true;
                        }
                    }
                }
                if changed {
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.deleteTag" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let tag = payload.get("tag").and_then(Value::as_str).unwrap_or("");
            for it in items.iter_mut() {
                let had = it
                    .get("tags")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().any(|t| t.as_str() == Some(tag)))
                    .unwrap_or(false);
                if let Some(tags) = it.get_mut("tags").and_then(Value::as_array_mut) {
                    tags.retain(|t| t.as_str() != Some(tag));
                }
                if had {
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.tagUnion" => {
            let items = jsonstore::live(jsonstore::load_synced(app, "saved"));
            let mut tags: Vec<String> = items
                .iter()
                .filter_map(|it| it.get("tags").and_then(Value::as_array))
                .flatten()
                .filter_map(|t| t.as_str().map(String::from))
                .collect();
            tags.sort();
            tags.dedup();
            Some(Ok(json!(tags)))
        }

        _ => None,
    }
}

/// Save the FULL array (tombstones kept on disk) and return only the LIVE records.
/// Nudges a background sync pass (no-op when sync is disabled).
fn persist<R: Runtime>(app: &AppHandle<R>, name: &str, items: Vec<Value>) -> Result<Value, String> {
    jsonstore::save(app, name, &items)?;
    // favorites + saved are SYNCABLE → nudge a sync (no-op when sync is disabled).
    crate::sync::nudge(app);
    Ok(json!(jsonstore::live(items)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    fn arr(v: Result<Value, String>) -> Vec<Value> {
        v.unwrap().as_array().cloned().unwrap()
    }

    #[test]
    fn favorites_add_list_returns_live_records_with_positions() {
        with_tmp_app(|app| {
            let r = dispatch(
                app,
                "favorites.add",
                &json!({ "input": { "name": "A", "url": "https://a.test/" } }),
            )
            .unwrap();
            let live = arr(r);
            assert_eq!(live.len(), 1);
            assert_eq!(live[0].get("name").and_then(Value::as_str), Some("A"));
            assert_eq!(live[0].get("position").and_then(Value::as_i64), Some(0));
            // list reflects the same single live record.
            let listed = dispatch(app, "favorites.list", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 1);
        });
    }

    #[test]
    fn favorites_remove_tombstones_so_list_hides_it_but_disk_keeps_it() {
        with_tmp_app(|app| {
            let live = arr(dispatch(
                app,
                "favorites.add",
                &json!({ "input": { "name": "A", "url": "https://a.test/" } }),
            )
            .unwrap());
            let id = live[0].get("id").and_then(Value::as_i64).unwrap();
            let after = arr(dispatch(app, "favorites.remove", &json!({ "id": id })).unwrap());
            assert!(
                after.is_empty(),
                "removed favorite is gone from the live list"
            );
            // The tombstone is still on disk (full array via load_synced).
            let full = jsonstore::load_synced(app, "favorites");
            assert_eq!(full.len(), 1);
            assert!(jsonstore::is_deleted(&full[0]));
        });
    }

    #[test]
    fn favorites_update_merges_partial_fields() {
        with_tmp_app(|app| {
            let live = arr(dispatch(
                app,
                "favorites.add",
                &json!({ "input": { "name": "A", "url": "https://a.test/" } }),
            )
            .unwrap());
            let id = live[0].get("id").and_then(Value::as_i64).unwrap();
            let after = arr(dispatch(
                app,
                "favorites.update",
                &json!({ "id": id, "partial": { "name": "Renamed" } }),
            )
            .unwrap());
            assert_eq!(
                after[0].get("name").and_then(Value::as_str),
                Some("Renamed")
            );
            assert_eq!(
                after[0].get("url").and_then(Value::as_str),
                Some("https://a.test/")
            );
        });
    }

    #[test]
    fn favorites_reorder_reassigns_positions() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "favorites.add",
                &json!({ "input": { "name": "A", "url": "https://a.test/" } }),
            )
            .unwrap()
            .unwrap();
            dispatch(
                app,
                "favorites.add",
                &json!({ "input": { "name": "B", "url": "https://b.test/" } }),
            )
            .unwrap()
            .unwrap();
            let live = jsonstore::live(jsonstore::load_synced(app, "favorites"));
            let id_a = live
                .iter()
                .find(|i| i.get("name").and_then(Value::as_str) == Some("A"))
                .unwrap()
                .get("id")
                .and_then(Value::as_i64)
                .unwrap();
            let id_b = live
                .iter()
                .find(|i| i.get("name").and_then(Value::as_str) == Some("B"))
                .unwrap()
                .get("id")
                .and_then(Value::as_i64)
                .unwrap();
            let after =
                arr(dispatch(app, "favorites.reorder", &json!({ "ids": [id_b, id_a] })).unwrap());
            let pos = |name: &str| {
                after
                    .iter()
                    .find(|i| i.get("name").and_then(Value::as_str) == Some(name))
                    .unwrap()
                    .get("position")
                    .and_then(Value::as_i64)
                    .unwrap()
            };
            assert_eq!(pos("B"), 0);
            assert_eq!(pos("A"), 1);
        });
    }

    #[test]
    fn saved_add_dedups_live_but_allows_readd_after_remove() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "saved.add",
                &json!({ "input": { "url": "https://x.test/", "title": "X", "tags": ["t"] } }),
            )
            .unwrap()
            .unwrap();
            // Adding the same live URL again is a no-op (still one live row).
            let again = arr(dispatch(
                app,
                "saved.add",
                &json!({ "input": { "url": "https://x.test/", "title": "X2", "tags": [] } }),
            )
            .unwrap());
            assert_eq!(again.len(), 1);
            assert!(
                dispatch(app, "saved.has", &json!({ "url": "https://x.test/" }))
                    .unwrap()
                    .unwrap()
                    .as_bool()
                    .unwrap()
            );
            let id = again[0].get("id").and_then(Value::as_i64).unwrap();
            dispatch(app, "saved.remove", &json!({ "id": id }))
                .unwrap()
                .unwrap();
            assert!(
                !dispatch(app, "saved.has", &json!({ "url": "https://x.test/" }))
                    .unwrap()
                    .unwrap()
                    .as_bool()
                    .unwrap()
            );
            // Re-add of a removed URL is allowed.
            let re = arr(dispatch(
                app,
                "saved.add",
                &json!({ "input": { "url": "https://x.test/", "title": "X3", "tags": [] } }),
            )
            .unwrap());
            assert_eq!(re.len(), 1);
        });
    }

    #[test]
    fn saved_tag_rename_delete_and_union() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "saved.add",
                &json!({ "input": { "url": "https://a.test/", "title": "A", "tags": ["news", "rust"] } }),
            )
            .unwrap()
            .unwrap();
            dispatch(
                app,
                "saved.add",
                &json!({ "input": { "url": "https://b.test/", "title": "B", "tags": ["rust"] } }),
            )
            .unwrap()
            .unwrap();
            // union is sorted + deduped over live rows.
            let union = dispatch(app, "saved.tagUnion", &json!({}))
                .unwrap()
                .unwrap();
            let tags: Vec<&str> = union
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(tags, vec!["news", "rust"]);
            // rename rust → crab everywhere.
            dispatch(
                app,
                "saved.renameTag",
                &json!({ "oldT": "rust", "newT": "crab" }),
            )
            .unwrap()
            .unwrap();
            let union2 = dispatch(app, "saved.tagUnion", &json!({}))
                .unwrap()
                .unwrap();
            let tags2: Vec<&str> = union2
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(tags2, vec!["crab", "news"]);
            // delete news → only crab remains.
            dispatch(app, "saved.deleteTag", &json!({ "tag": "news" }))
                .unwrap()
                .unwrap();
            let union3 = dispatch(app, "saved.tagUnion", &json!({}))
                .unwrap()
                .unwrap();
            let tags3: Vec<&str> = union3
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert_eq!(tags3, vec!["crab"]);
        });
    }
}
