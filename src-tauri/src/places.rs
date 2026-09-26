//! Favorites + saved-items repos (favorites.* / saved.* IPC), backed by the JSON
//! store. Each mutation returns the full updated collection (matching AegisApi).
//!
//! Syncable (F2a): records carry uuid/hlc/deleted. Mutations load the FULL array via
//! `load_synced` (incl. tombstones), persist the full array, and return only `live`
//! records to the renderer; deletes become tombstones; edits bump the hlc via `touch`.
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::jsonstore;

/// `load_id_keyed` in the shape `dispatch` needs.
///
/// `dispatch` returns `Option<Result<Value, String>>`, so the `?` operator only propagates the
/// `Option` half — a `Result` has to be unwrapped by hand. Doing that at sixteen call sites
/// would be noise, hence this one-liner. Defined at module scope (with
/// `#[macro_use]`-free late binding via `macro_rules!` hoisting) so tests can use it too.
macro_rules! id_keyed {
    ($app:expr, $name:expr) => {
        match load_id_keyed($app, $name) {
            Ok(v) => v,
            Err(e) => return Some(Err(e)),
        }
    };
}

fn id_of(item: &Value) -> Option<i64> {
    item.get("id").and_then(Value::as_i64)
}

/// Load an id-keyed store for mutation, healing duplicate ids on the way.
///
/// Self-healing rather than a one-shot migration: a store written by the old cached
/// `next_id_optimized` can hold any number of rows sharing one `id`, and as long as it does,
/// a single `remove`/`update` aimed at one row hits all of them. Every mutation goes through
/// here, so the first one after the upgrade repairs the file and the hazard is gone for good.
///
/// Returns the loaded array. The repair is persisted immediately, and a write failure is
/// surfaced rather than swallowed — silently failing here would leave the duplicates in place
/// while reporting success, which is the same class of bug as the one being fixed.
fn load_id_keyed<R: Runtime>(
    app: &AppHandle<R>,
    name: &str,
) -> std::result::Result<Vec<Value>, String> {
    let mut items = jsonstore::load_synced(app, name);
    if jsonstore::rekey_duplicate_ids(&mut items) > 0 {
        jsonstore::save(app, name, &items)?;
    }
    Ok(items)
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
    // Every arm below is a read-modify-write on ONE jsonstore collection, and the
    // background sync thread writes the same files via `sync_stores::merge_into`. Hold that
    // store's write lock for the whole `match` so the two cannot interleave — otherwise a
    // `favorites.add` landing between sync's read and sync's save is silently dropped.
    // The store is the channel's prefix (`favorites.add` → `favorites`), so one rule covers
    // every arm. Read-only arms are unaffected apart from a little serialization on the
    // same collection, which is the correct trade for losing no writes.
    let store_arc = crate::jsonstore::store_lock(store_of(channel));
    let _store_guard = store_arc.lock();
    match channel {
        // ---- favorites ----
        "favorites.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app,
            "favorites"
        ))))),

        "favorites.add" => {
            let mut items = id_keyed!(app, "favorites");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let id = jsonstore::next_id(&items);
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
            let Some(id) = payload.get("id").and_then(Value::as_i64) else {
                return Some(Err("favorites.update requires an integer id".into()));
            };
            let mut items = id_keyed!(app, "favorites");
            for it in items.iter_mut() {
                if id_of(it) == Some(id) {
                    merge_into(it, payload.get("partial"));
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "favorites", items))
        }

        "favorites.remove" => {
            let Some(id) = payload.get("id").and_then(Value::as_i64) else {
                return Some(Err("favorites.remove requires an integer id".into()));
            };
            let mut items = id_keyed!(app, "favorites");
            jsonstore::tombstone(&mut items, |it| id_of(it) == Some(id), app);
            Some(persist(app, "favorites", items))
        }

        "favorites.reorder" => {
            let mut items = id_keyed!(app, "favorites");
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
            let items = id_keyed!(app, "saved");
            let url_str = payload.get("url").and_then(Value::as_str).unwrap_or("");
            Some(Ok(json!(live_has_url(&items, url_str))))
        }

        "saved.add" => {
            let mut items = id_keyed!(app, "saved");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            // Dedup against LIVE records only (a previously-removed url can be re-added).
            let url_str = input.get("url").and_then(Value::as_str).unwrap_or("");
            if !live_has_url(&items, url_str) {
                let id = jsonstore::next_id(&items);
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
            let Some(id) = payload.get("id").and_then(Value::as_i64) else {
                return Some(Err("saved.remove requires an integer id".into()));
            };
            let mut items = id_keyed!(app, "saved");
            jsonstore::tombstone(&mut items, |it| id_of(it) == Some(id), app);
            Some(persist(app, "saved", items))
        }

        "saved.update" => {
            let Some(id) = payload.get("id").and_then(Value::as_i64) else {
                return Some(Err("saved.update requires an integer id".into()));
            };
            let mut items = id_keyed!(app, "saved");
            for it in items.iter_mut() {
                if id_of(it) == Some(id) {
                    merge_into(it, payload.get("partial"));
                    jsonstore::touch(it, app);
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.renameTag" => {
            let mut items = id_keyed!(app, "saved");
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
            let mut items = id_keyed!(app, "saved");
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
            let items = jsonstore::live(id_keyed!(app, "saved"));
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
/// The jsonstore collection a channel operates on: the part before the first `.`
/// (`favorites.add` → `favorites`). See the lock comment in [`dispatch`].
fn store_of(channel: &str) -> &str {
    channel.split_once('.').map_or(channel, |(s, _)| s)
}

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

    // ---- duplicate-id healing ----------------------------------------------
    //
    // The broken store this guards against really existed: 104 `saved` rows all carrying
    // `id: 0`, written by the deleted `next_id_optimized` cache. Every one of them was
    // individually deletable only at the price of all the others.

    #[test]
    fn loading_for_mutation_heals_a_store_where_every_row_shares_one_id() {
        with_tmp_app(|app| {
            let rows: Vec<Value> = (0..5)
                .map(|i| json!({ "id": 0, "url": format!("https://x{i}.test/"), "uuid": format!("u{i}") }))
                .collect();
            jsonstore::save(app, "saved", &rows).expect("seed the broken store");

            let loaded = load_id_keyed(app, "saved").expect("load must succeed");
            let ids: Vec<i64> = loaded
                .iter()
                .filter_map(|v| v.get("id").and_then(Value::as_i64))
                .collect();
            assert_eq!(ids.len(), 5, "every row must still be present");
            let unique: std::collections::HashSet<i64> = ids.iter().copied().collect();
            assert_eq!(
                unique.len(),
                5,
                "every id must now be distinct, got {ids:?}"
            );

            // The repair must be ON DISK, not just in the returned array — otherwise the next
            // process start reloads the duplicates and the hazard returns.
            let disk_ids: std::collections::HashSet<i64> = jsonstore::load(app, "saved")
                .iter()
                .filter_map(|v| v.get("id").and_then(Value::as_i64))
                .collect();
            assert_eq!(disk_ids.len(), 5, "the repair must be persisted");
        });
    }

    #[test]
    fn healing_keeps_the_first_holder_of_an_id_so_live_references_stay_valid() {
        // Re-keying the LATER duplicate is the least destructive choice: anything holding a
        // reference to the first row (an open menu, a pending action) still points at it.
        let mut items = vec![
            json!({ "id": 7, "url": "https://first.test/" }),
            json!({ "id": 7, "url": "https://second.test/" }),
        ];
        assert_eq!(jsonstore::rekey_duplicate_ids(&mut items), 1);
        assert_eq!(items[0]["id"], json!(7), "the first holder keeps its id");
        assert_ne!(items[1]["id"], json!(7), "the duplicate is re-keyed");
        assert_eq!(
            items[1]["url"],
            json!("https://second.test/"),
            "payload is untouched"
        );
    }

    #[test]
    fn healing_leaves_id_less_and_already_unique_stores_alone() {
        // `allowlist`/`fp-allowlist` are host-keyed and have no id at all; inventing one would
        // be noise. A clean store must not be rewritten either.
        let mut host_keyed = vec![json!({ "host": "a.test" }), json!({ "host": "b.test" })];
        assert_eq!(jsonstore::rekey_duplicate_ids(&mut host_keyed), 0);

        let mut unique = vec![json!({ "id": 0 }), json!({ "id": 1 }), json!({ "id": 2 })];
        assert_eq!(jsonstore::rekey_duplicate_ids(&mut unique), 0);
        assert_eq!(unique[1]["id"], json!(1), "ids must not shift");
    }

    #[test]
    fn removing_one_row_from_a_healed_store_leaves_the_others_live() {
        // End to end: the exact user action that wiped 104 rows, against a healed store.
        with_tmp_app(|app| {
            let rows: Vec<Value> = (0..4)
                .map(|i| json!({ "id": 0, "url": format!("https://y{i}.test/"), "uuid": format!("v{i}") }))
                .collect();
            jsonstore::save(app, "saved", &rows).expect("seed the broken store");

            let loaded = load_id_keyed(app, "saved").expect("load must succeed");
            let victim = loaded[1]["id"].as_i64().expect("healed rows carry ids");
            dispatch(app, "saved.remove", &json!({ "id": victim }))
                .expect("saved.remove is owned by places")
                .expect("remove must succeed");

            let live = jsonstore::load(app, "saved")
                .iter()
                .filter(|v| !jsonstore::is_deleted(v))
                .count();
            assert_eq!(live, 3, "exactly one row may be tombstoned, got {live}");
        });
    }

    /// The regression guard for the 2026-09-26 data-loss incident, client half: a remove with
    /// a MISSING or non-integer `id` must be refused, and must tombstone nothing.
    ///
    /// The old predicate was `id_of(it) == id` with `id: Option<i64>`, so `None == None` was
    /// true for every row without an integer `id` — a single call tombstoned the whole store
    /// (104 `saved` pages, all sharing one `wall_ms`). A store-wide delete must never be the
    /// consequence of a malformed id, so this refuses instead.
    #[test]
    fn a_remove_without_an_integer_id_tombstones_nothing() {
        with_tmp_app(|app| {
            for n in 0..3 {
                dispatch(
                    app,
                    "saved.add",
                    &json!({ "input": { "url": format!("https://keep-{n}.test/") } }),
                )
                .expect("saved.add is owned by places")
                .expect("saved.add must succeed");
            }
            let before = load_id_keyed(app, "saved")
                .expect("load must succeed")
                .len();
            assert_eq!(before, 3, "three pages seeded");

            // Missing id, and an id of the wrong type — both must be refused.
            for bad in [json!({}), json!({ "id": null }), json!({ "id": "3" })] {
                let r = dispatch(app, "saved.remove", &bad).unwrap();
                assert!(
                    r.is_err(),
                    "saved.remove with {bad} must error, got ok: {r:?}"
                );
            }

            let after = load_id_keyed(app, "saved").expect("load must succeed");
            assert_eq!(
                after.len(),
                3,
                "the rows must survive verbatim, not be tombstoned: {after:?}"
            );
            assert!(
                after.iter().all(|r| !crate::jsonstore::is_deleted(r)),
                "nothing may be tombstoned by a malformed id: {after:?}"
            );
        });
    }

    /// Deleting ONE page must leave the others alone — the end-to-end shape of the incident,
    /// driven through the real store rather than by narrating around it.
    #[test]
    fn removing_one_saved_page_leaves_the_others_live() {
        with_tmp_app(|app| {
            let mut ids = Vec::new();
            for n in 0..4 {
                dispatch(
                    app,
                    "saved.add",
                    &json!({ "input": { "url": format!("https://row-{n}.test/") } }),
                )
                .expect("saved.add is owned by places")
                .expect("saved.add must succeed");
                ids.push(
                    load_id_keyed(app, "saved").expect("load must succeed")[n as usize]
                        .get("id")
                        .and_then(Value::as_i64)
                        .expect("saved.add must mint an id"),
                );
            }

            dispatch(app, "saved.remove", &json!({ "id": ids[1] }))
                .expect("saved.remove is owned by places")
                .expect("removing a real id must succeed");

            let live = arr(dispatch(app, "saved.list", &json!({})).unwrap());
            assert_eq!(live.len(), 3, "exactly one page should be gone: {live:?}");
            assert!(
                !live
                    .iter()
                    .any(|r| r.get("url").and_then(Value::as_str) == Some("https://row-1.test/")),
                "the named page must be the one removed: {live:?}"
            );
        });
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
            let full = load_id_keyed(app, "favorites").expect("load must succeed");
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
            let live = jsonstore::live(load_id_keyed(app, "favorites").expect("load must succeed"));
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
