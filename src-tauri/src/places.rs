//! Favorites + saved-items repos (favorites.* / saved.* IPC), backed by the JSON
//! store. Each mutation returns the full updated collection (matching AegisApi).
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

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        // ---- favorites ----
        "favorites.list" => Some(Ok(json!(jsonstore::load(app, "favorites")))),

        "favorites.add" => {
            let mut items = jsonstore::load(app, "favorites");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let id = jsonstore::next_id(&items);
            let position = items.len() as i64;
            items.push(json!({
                "id": id,
                "name": input.get("name").and_then(Value::as_str).unwrap_or(""),
                "url": input.get("url").and_then(Value::as_str).unwrap_or(""),
                "position": position
            }));
            Some(persist(app, "favorites", items))
        }

        "favorites.update" => {
            let mut items = jsonstore::load(app, "favorites");
            let id = payload.get("id").and_then(Value::as_i64);
            for it in items.iter_mut() {
                if id_of(it) == id {
                    merge_into(it, payload.get("partial"));
                }
            }
            Some(persist(app, "favorites", items))
        }

        "favorites.remove" => {
            let mut items = jsonstore::load(app, "favorites");
            let id = payload.get("id").and_then(Value::as_i64);
            items.retain(|it| id_of(it) != id);
            Some(persist(app, "favorites", items))
        }

        "favorites.reorder" => {
            let mut items = jsonstore::load(app, "favorites");
            let order: Vec<i64> = payload
                .get("ids")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Value::as_i64).collect())
                .unwrap_or_default();
            items.sort_by_key(|it| {
                let id = id_of(it).unwrap_or(0);
                order.iter().position(|x| *x == id).unwrap_or(usize::MAX)
            });
            for (i, it) in items.iter_mut().enumerate() {
                if let Some(o) = it.as_object_mut() {
                    o.insert("position".into(), json!(i as i64));
                }
            }
            Some(persist(app, "favorites", items))
        }

        // ---- saved (with tags) ----
        "saved.list" => Some(Ok(json!(jsonstore::load(app, "saved")))),

        "saved.has" => {
            let items = jsonstore::load(app, "saved");
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            Some(Ok(json!(items
                .iter()
                .any(|it| it.get("url").and_then(Value::as_str) == Some(url)))))
        }

        "saved.add" => {
            let mut items = jsonstore::load(app, "saved");
            let input = payload.get("input").cloned().unwrap_or_else(|| json!({}));
            let url = input.get("url").and_then(Value::as_str).unwrap_or("");
            if !items
                .iter()
                .any(|it| it.get("url").and_then(Value::as_str) == Some(url))
            {
                let id = jsonstore::next_id(&items);
                items.push(json!({
                    "id": id,
                    "url": url,
                    "title": input.get("title").and_then(Value::as_str).unwrap_or(""),
                    "tags": input.get("tags").cloned().unwrap_or_else(|| json!([])),
                    "savedAt": jsonstore::now_ms()
                }));
            }
            Some(persist(app, "saved", items))
        }

        "saved.remove" => {
            let mut items = jsonstore::load(app, "saved");
            let id = payload.get("id").and_then(Value::as_i64);
            items.retain(|it| id_of(it) != id);
            Some(persist(app, "saved", items))
        }

        "saved.update" => {
            let mut items = jsonstore::load(app, "saved");
            let id = payload.get("id").and_then(Value::as_i64);
            for it in items.iter_mut() {
                if id_of(it) == id {
                    merge_into(it, payload.get("partial"));
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.renameTag" => {
            let mut items = jsonstore::load(app, "saved");
            let old = payload.get("oldT").and_then(Value::as_str).unwrap_or("");
            let new = payload.get("newT").and_then(Value::as_str).unwrap_or("");
            for it in items.iter_mut() {
                if let Some(tags) = it.get_mut("tags").and_then(Value::as_array_mut) {
                    for t in tags.iter_mut() {
                        if t.as_str() == Some(old) {
                            *t = json!(new);
                        }
                    }
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.deleteTag" => {
            let mut items = jsonstore::load(app, "saved");
            let tag = payload.get("tag").and_then(Value::as_str).unwrap_or("");
            for it in items.iter_mut() {
                if let Some(tags) = it.get_mut("tags").and_then(Value::as_array_mut) {
                    tags.retain(|t| t.as_str() != Some(tag));
                }
            }
            Some(persist(app, "saved", items))
        }

        "saved.tagUnion" => {
            let items = jsonstore::load(app, "saved");
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

/// Save and return the collection (or the write error).
fn persist(app: &AppHandle, name: &str, items: Vec<Value>) -> Result<Value, String> {
    jsonstore::save(app, name, &items)?;
    Ok(json!(items))
}
