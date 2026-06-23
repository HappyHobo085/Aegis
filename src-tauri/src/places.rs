//! Favorites + saved-items repos (favorites.* / saved.* IPC), backed by the JSON
//! store. Each mutation returns the full updated collection (matching AegisApi).
//!
//! Syncable (F2a): records carry uuid/hlc/deleted. Mutations load the FULL array via
//! `load_synced` (incl. tombstones), persist the full array, and return only `live`
//! records to the renderer; deletes become tombstones; edits bump the hlc via `touch`.
use serde_json::{json, Value};
use tauri::AppHandle;

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

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        // ---- favorites ----
        "favorites.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app,
            "favorites"
        ))))),

        "favorites.add" => {
            let mut items = jsonstore::load_synced(app, "favorites");
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
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            Some(Ok(json!(live_has_url(&items, url))))
        }

        "saved.add" => {
            let mut items = jsonstore::load_synced(app, "saved");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let url = input.get("url").and_then(Value::as_str).unwrap_or("");
            // Dedup against LIVE records only (a previously-removed url can be re-added).
            if !live_has_url(&items, url) {
                let id = jsonstore::next_id(&items);
                let mut item = json!({
                    "id": id,
                    "url": url,
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
fn persist(app: &AppHandle, name: &str, items: Vec<Value>) -> Result<Value, String> {
    jsonstore::save(app, name, &items)?;
    // favorites + saved are SYNCABLE → nudge a sync (no-op when sync is disabled).
    crate::sync::nudge(app);
    Ok(json!(jsonstore::live(items)))
}
