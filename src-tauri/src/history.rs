//! Browsing history (history.* IPC) backed by the JSON store. Visits are recorded
//! from the content webview's page-load (see nav.rs). list/search return newest
//! first; the collection is capped to keep the file bounded.
//!
//! History is NOT syncable (product decision) — it stays device-local with plain
//! hard-delete storage (no sync envelope / tombstones), so `clear` truly removes the URLs
//! from disk rather than leaving them as deleted-but-present tombstones.
use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::jsonstore;

const MAX_ENTRIES: usize = 5000;

/// Pure predicate: should this (url, owning-tab-privateness) pair be written to history?
pub fn should_record_visit(url: &str, is_private: bool) -> bool {
    if is_private {
        return false;
    }
    !(url.is_empty() || url.starts_with("about:") || url.starts_with("data:"))
}

/// Record a visit (called on top-frame page load). Skips non-web schemes and
/// de-dups consecutive visits to the same URL. No-ops for private tabs.
pub fn record<R: Runtime>(app: &AppHandle<R>, url: &str, title: &str, is_private: bool) {
    if !should_record_visit(url, is_private) {
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
    crate::emit_event(app, "history.changed", Value::Null);
}

/// Fill in the title of the most-recent history entry for `url`. WebKit sets the
/// page title after the load finishes, so the URL-only visit recorded at page-load
/// (see nav.rs) gets its title here when the title-changed signal fires.
/// No-ops for private tabs.
#[allow(dead_code)] // only called from the Linux WebKit title-changed signal (linux_layout)
pub fn update_title<R: Runtime>(app: &AppHandle<R>, url: &str, title: &str, is_private: bool) {
    if is_private
        || url.is_empty()
        || title.is_empty()
        || url.starts_with("about:")
        || url.starts_with("data:")
    {
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
        crate::emit_event(app, "history.changed", Value::Null);
    }
}

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
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
            crate::emit_event(app, "history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        "history.clear" => {
            // Truly remove (history isn't synced) — clear actually clears.
            let empty: [Value; 0] = [];
            let _ = jsonstore::save(app, "history", &empty);
            crate::emit_event(app, "history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn skips_non_web_and_private() {
        assert!(should_record_visit("https://example.com/", false));
        assert!(!should_record_visit("about:blank", false));
        assert!(!should_record_visit("data:text/html,x", false));
        assert!(!should_record_visit("", false));
        // a private tab never records, even for a real web URL.
        assert!(!should_record_visit("https://example.com/", true));
    }

    #[test]
    fn record_dedups_and_skips_non_web_schemes() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            record(app, "https://a.test/", "A", false); // consecutive dup → ignored
            record(app, "about:blank", "blank", false); // non-web → ignored
            record(app, "data:text/html,x", "data", false); // non-web → ignored
            record(app, "", "", false); // empty → ignored
            record(app, "https://b.test/", "B", false);
            let items = jsonstore::load(app, "history");
            let urls: Vec<&str> = items
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str))
                .collect();
            assert_eq!(urls, vec!["https://a.test/", "https://b.test/"]);
        });
    }

    #[test]
    fn list_returns_newest_first_with_limit_and_offset() {
        with_tmp_app(|app| {
            for n in 0..5 {
                record(app, &format!("https://s{n}.test/"), &format!("S{n}"), false);
            }
            // newest-first, skip the newest (offset 1), take 2
            let v = dispatch(
                app,
                "history.list",
                &json!({ "opts": { "limit": 2, "offset": 1 } }),
            )
            .unwrap()
            .unwrap();
            let urls: Vec<&str> = v
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str))
                .collect();
            assert_eq!(urls, vec!["https://s3.test/", "https://s2.test/"]);
        });
    }

    #[test]
    fn search_is_case_insensitive_over_url_and_title() {
        with_tmp_app(|app| {
            record(app, "https://rust-lang.org/", "The Rust Language", false);
            record(app, "https://example.com/", "Example", false);
            let by_title = dispatch(app, "history.search", &json!({ "q": "RUST" }))
                .unwrap()
                .unwrap();
            assert_eq!(by_title.as_array().unwrap().len(), 1);
            let by_url = dispatch(app, "history.search", &json!({ "q": "example.com" }))
                .unwrap()
                .unwrap();
            assert_eq!(by_url.as_array().unwrap().len(), 1);
            // empty query returns everything
            let all = dispatch(app, "history.search", &json!({ "q": "" }))
                .unwrap()
                .unwrap();
            assert_eq!(all.as_array().unwrap().len(), 2);
        });
    }

    #[test]
    fn remove_deletes_by_id_and_clear_empties() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            record(app, "https://b.test/", "B", false);
            let items = jsonstore::load(app, "history");
            let id = items[0].get("id").and_then(Value::as_i64).unwrap();
            dispatch(app, "history.remove", &json!({ "id": id }))
                .unwrap()
                .unwrap();
            let after = jsonstore::load(app, "history");
            assert_eq!(after.len(), 1);
            assert_ne!(after[0].get("id").and_then(Value::as_i64), Some(id));
            dispatch(app, "history.clear", &json!({})).unwrap().unwrap();
            assert!(jsonstore::load(app, "history").is_empty());
        });
    }

    #[test]
    fn dispatch_ignores_unknown_channel() {
        with_tmp_app(|app| {
            assert!(dispatch(app, "history.nope", &json!({})).is_none());
        });
    }
}
