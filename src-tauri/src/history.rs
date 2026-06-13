//! Browsing history (history.* IPC) backed by the JSON store. Visits are recorded
//! from the content webview's page-load (see nav.rs). list/search return newest
//! first; the collection is capped to keep the file bounded.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

use crate::jsonstore;

const MAX_ENTRIES: usize = 5000;

/// Record a visit (called on top-frame page load). Skips non-web schemes and
/// de-dups consecutive visits to the same URL.
pub fn record(app: &AppHandle, url: &str, title: &str) {
    if url.is_empty() || url.starts_with("about:") || url.starts_with("data:") {
        return;
    }
    let mut items = jsonstore::load(app, "history");
    if items
        .last()
        .and_then(|i| i.get("url").and_then(Value::as_str))
        == Some(url)
    {
        return;
    }
    let id = jsonstore::next_id(&items);
    items.push(json!({ "id": id, "url": url, "title": title, "visitedAt": jsonstore::now_ms() }));
    let len = items.len();
    if len > MAX_ENTRIES {
        items.drain(0..len - MAX_ENTRIES);
    }
    let _ = jsonstore::save(app, "history", &items);
    let _ = app.emit("history.changed", Value::Null);
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "history.list" => {
            let opts = payload.get("opts");
            let limit = opts
                .and_then(|o| o.get("limit"))
                .and_then(Value::as_u64)
                .unwrap_or(200) as usize;
            let offset = opts
                .and_then(|o| o.get("offset"))
                .and_then(Value::as_u64)
                .unwrap_or(0) as usize;
            let out: Vec<Value> = jsonstore::load(app, "history")
                .into_iter()
                .rev()
                .skip(offset)
                .take(limit)
                .collect();
            Some(Ok(json!(out)))
        }
        "history.search" => {
            let q = payload
                .get("q")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            let out: Vec<Value> = jsonstore::load(app, "history")
                .into_iter()
                .rev()
                .filter(|it| {
                    if q.is_empty() {
                        return true;
                    }
                    let u = it.get("url").and_then(Value::as_str).unwrap_or("").to_lowercase();
                    let t = it.get("title").and_then(Value::as_str).unwrap_or("").to_lowercase();
                    u.contains(&q) || t.contains(&q)
                })
                .take(200)
                .collect();
            Some(Ok(json!(out)))
        }
        "history.remove" => {
            let mut items = jsonstore::load(app, "history");
            let id = payload.get("id").and_then(Value::as_i64);
            items.retain(|it| it.get("id").and_then(Value::as_i64) != id);
            let _ = jsonstore::save(app, "history", &items);
            let _ = app.emit("history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        "history.clear" => {
            let empty: [Value; 0] = [];
            let _ = jsonstore::save(app, "history", &empty);
            let _ = app.emit("history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}
