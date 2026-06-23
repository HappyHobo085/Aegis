//! Browsing history (history.* IPC) backed by the JSON store. Visits are recorded
//! from the content webview's page-load (see nav.rs). list/search return newest
//! first; the collection is capped to keep the file bounded.
//!
//! History is NOT syncable (product decision) — it stays device-local with plain
//! hard-delete storage (no sync envelope / tombstones), so `clear` truly removes the URLs
//! from disk rather than leaving them as deleted-but-present tombstones.
use serde_json::{json, Value};
use tauri::AppHandle;

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
    let _ = crate::emit_event(app, "history.changed", Value::Null);
}

/// Fill in the title of the most-recent history entry for `url`. WebKit sets the
/// page title after the load finishes, so the URL-only visit recorded at page-load
/// (see nav.rs) gets its title here when the title-changed signal fires.
#[allow(dead_code)] // only called from the Linux WebKit title-changed signal (linux_layout)
pub fn update_title(app: &AppHandle, url: &str, title: &str) {
    if url.is_empty() || title.is_empty() || url.starts_with("about:") || url.starts_with("data:") {
        return;
    }
    let mut items = jsonstore::load(app, "history");
    let Some(i) = items
        .iter()
        .rposition(|it| it.get("url").and_then(Value::as_str) == Some(url))
    else {
        return;
    };
    if items[i].get("title").and_then(Value::as_str) != Some(title) {
        items[i]["title"] = json!(title);
        let _ = jsonstore::save(app, "history", &items);
        let _ = crate::emit_event(app, "history.changed", Value::Null);
    }
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
                    let u = it
                        .get("url")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
                    let t = it
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_lowercase();
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
            let _ = crate::emit_event(app, "history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        "history.clear" => {
            // Truly remove (history isn't synced) — clear actually clears.
            let empty: [Value; 0] = [];
            let _ = jsonstore::save(app, "history", &empty);
            let _ = crate::emit_event(app, "history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}
