//! Browsing history (history.* IPC) backed by the JSON store. Visits are recorded
//! from the content webview's page-load (see nav.rs). list/search return newest
//! first; the collection is capped to keep the file bounded.
//!
//! History is NOT syncable (product decision) — it stays device-local with plain
//! hard-delete storage (no sync envelope / tombstones), so `clear` truly removes the URLs
//! from disk rather than leaving them as deleted-but-present tombstones.
//!
//! ## Write batching
//! `record` runs on every top-frame page load. To avoid a full read-modify-serialize-fsync
//! of the whole (up to 5000-row) file per navigation, the live history lives in an
//! in-memory cache (`HistoryStore`, managed state). `record`/`update_title` mutate the
//! cache and mark it dirty WITHOUT touching disk; a background flush (`start_flush`,
//! started in lib.rs setup) coalesces those into one write every few seconds. User-initiated
//! deletions (`remove`/`clear`) flush synchronously so a "cleared" history is gone from disk
//! immediately (privacy), and `data.export` calls `flush` first so a backup is never stale.
//! `data.import` calls `invalidate` after overwriting the file so the next read reloads it.
//! Reads (`list`/`search`) serve from the cache. Crash within the flush window loses at most
//! the last few seconds of visits — acceptable for history (mirrors Chrome/Firefox batching).
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

const MAX_ENTRIES: usize = 5000;

/// In-memory history cache (managed state) — the source of truth while the app runs.
#[derive(Default)]
pub struct HistoryStore(Mutex<HistInner>);

#[derive(Default)]
struct HistInner {
    items: Vec<Value>,
    loaded: bool,
    dirty: bool,
}

/// Pure predicate: should this (url, owning-tab-privateness) pair be written to history?
pub fn should_record_visit(url: &str, is_private: bool) -> bool {
    if is_private {
        return false;
    }
    !(url.is_empty() || url.starts_with("about:") || url.starts_with("data:"))
}

/// Pure: append a visit to `items` (dedup the immediately-previous URL + cap to MAX_ENTRIES).
/// Returns true if a row was added (false = a consecutive duplicate, a no-op).
fn apply_visit<R: Runtime>(items: &mut Vec<Value>, url: &str, title: &str, now: i64) -> bool {
    if items
        .last()
        .and_then(|i| i.get("url").and_then(Value::as_str))
        == Some(url)
    {
        return false;
    }
    let id = jsonstore::next_id(items);
    items.push(json!({ "id": id, "url": url, "title": title, "visitedAt": now }));
    let len = items.len();
    if len > MAX_ENTRIES {
        items.drain(0..len - MAX_ENTRIES);
    }
    true
}

/// Pure: set the title of the most-recent entry for `url`. Returns true if it changed.
fn apply_title(items: &mut [Value], url: &str, title: &str) -> bool {
    let Some(i) = items
        .iter()
        .rposition(|it| it.get("url").and_then(Value::as_str) == Some(url))
    else {
        return false;
    };
    if items[i].get("title").and_then(Value::as_str) != Some(title) {
        items[i]["title"] = json!(title);
        true
    } else {
        false
    }
}

/// Load the on-disk history into the cache on first access.
fn ensure_loaded<R: Runtime>(app: &AppHandle<R>, inner: &mut HistInner) {
    if !inner.loaded {
        inner.items = jsonstore::load(app, "history");
        inner.loaded = true;
        inner.dirty = false;
    }
}

/// A copy of the live history (newest LAST, like the on-disk array). Reads serve from the
/// in-memory cache when present; falls back to disk if the state isn't managed.
fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    if let Some(store) = app.try_state::<HistoryStore>() {
        let mut inner = store.0.lock().unwrap();
        ensure_loaded(app, &mut inner);
        inner.items.clone()
    } else {
        jsonstore::load(app, "history")
    }
}

/// Apply a mutation to the history items — through the in-memory cache when present, else
/// directly on disk — persisting now iff `flush_now`. Returns whether the items changed.
fn mutate<R: Runtime>(
    app: &AppHandle<R>,
    flush_now: bool,
    f: impl FnOnce(&mut Vec<Value>) -> bool,
) -> bool {
    if let Some(store) = app.try_state::<HistoryStore>() {
        let changed = {
            let mut inner = store.0.lock().unwrap();
            ensure_loaded(app, &mut inner);
            let changed = f(&mut inner.items);
            if changed {
                inner.dirty = true;
            }
            changed
        };
        if flush_now {
            flush(app);
        }
        changed
    } else {
        let mut items = jsonstore::load(app, "history");
        let changed = f(&mut items);
        if changed {
            let _ = jsonstore::save(app, "history", &items);
        }
        changed
    }
}

/// Persist the in-memory history to disk if it changed. Clones under the lock and writes
/// OUTSIDE it so a slow fsync never blocks `record`; on write failure, re-marks dirty so the
/// next flush retries. No-op when the cache isn't managed or isn't dirty.
pub fn flush<R: Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<HistoryStore>() else {
        return;
    };
    let pending = {
        let mut inner = store.0.lock().unwrap();
        if !inner.loaded || !inner.dirty {
            return;
        }
        inner.dirty = false;
        inner.items.clone()
    };
    if jsonstore::save(app, "history", &pending).is_err() {
        store.0.lock().unwrap().dirty = true;
    }
}

/// Drop the in-memory cache so the next read reloads from disk — used after `data.import`
/// overwrites the history file.
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(store) = app.try_state::<HistoryStore>() {
        let mut inner = store.0.lock().unwrap();
        inner.items.clear();
        inner.loaded = false;
        inner.dirty = false;
    }
}

/// Start the background flush loop: every few seconds, persist the cache if it's dirty.
/// `record` only touches memory (the hot, per-navigation path); this coalesces many visits
/// into one write. Mirrors `tabs::start_idle_sweep`. Started once from lib.rs setup.
pub fn start_flush(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        flush(&app);
    });
}

/// Record a visit (called on top-frame page load). Skips non-web schemes and
/// de-dups consecutive visits to the same URL. No-ops for private tabs. Batched in
/// memory — see the module-level "Write batching" note.
pub fn record<R: Runtime>(app: &AppHandle<R>, url: &str, title: &str, is_private: bool) {
    if !should_record_visit(url, is_private) {
        return;
    }
    let now = jsonstore::now_ms();
    if mutate(app, false, |items| apply_visit::<R>(items, url, title, now)) {
        crate::emit_event(app, "history.changed", Value::Null);
    }
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
    if mutate(app, false, |items| apply_title(items, url, title)) {
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
            let out: Vec<Value> = snapshot(app)
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
            let out: Vec<Value> = snapshot(app)
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
            let id = payload.get("id").and_then(Value::as_i64);
            // User-initiated deletion → flush now so it leaves disk immediately.
            mutate(app, true, |items| {
                let before = items.len();
                items.retain(|it| it.get("id").and_then(Value::as_i64) != id);
                items.len() != before
            });
            crate::emit_event(app, "history.changed", Value::Null);
            Some(Ok(Value::Null))
        }
        "history.clear" => {
            // Truly remove (history isn't synced) — clear actually clears, and flushes now.
            if let Some(store) = app.try_state::<HistoryStore>() {
                {
                    let mut inner = store.0.lock().unwrap();
                    inner.items.clear();
                    inner.loaded = true; // cleared state is authoritative; don't reload disk
                    inner.dirty = true;
                }
                flush(app);
            } else {
                let empty: [Value; 0] = [];
                let _ = jsonstore::save(app, "history", &empty);
            }
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
    fn apply_visit_dedups_consecutive_and_caps() {
        let mut items = Vec::new();
        assert!(apply_visit::<crate::test_support::MockRuntime>(
            &mut items,
            "https://a/",
            "A",
            1
        ));
        assert!(!apply_visit::<crate::test_support::MockRuntime>(
            &mut items,
            "https://a/",
            "A",
            2
        )); // consecutive dup → no-op
        assert!(apply_visit::<crate::test_support::MockRuntime>(
            &mut items,
            "https://b/",
            "B",
            3
        ));
        assert_eq!(items.len(), 2);
        // cap: push MAX_ENTRIES+ distinct rows, oldest are dropped, newest kept.
        for n in 0..MAX_ENTRIES + 10 {
            apply_visit::<crate::test_support::MockRuntime>(
                &mut items,
                &format!("https://x{n}/"),
                "x",
                n as i64,
            );
        }
        assert_eq!(items.len(), MAX_ENTRIES);
        let last = items.last().unwrap().get("url").and_then(Value::as_str);
        let expected = format!("https://x{}/", MAX_ENTRIES + 9);
        assert_eq!(last, Some(expected.as_str()));
    }

    #[test]
    fn record_batches_in_memory_and_flush_persists() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            // Batched: nothing written to disk yet (the win — no per-navigation fsync)…
            assert!(
                jsonstore::load(app, "history").is_empty(),
                "record must batch in memory, not write to disk per visit"
            );
            // …but it IS visible to reads (served from the cache).
            assert_eq!(snapshot(app).len(), 1);
            // An explicit flush persists it.
            flush(app);
            assert_eq!(jsonstore::load(app, "history").len(), 1);
        });
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
            let urls: Vec<String> = snapshot(app)
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str).map(String::from))
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
    fn remove_deletes_by_id_and_flushes() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            record(app, "https://b.test/", "B", false);
            let id = snapshot(app)[0].get("id").and_then(Value::as_i64).unwrap();
            dispatch(app, "history.remove", &json!({ "id": id }))
                .unwrap()
                .unwrap();
            let after = snapshot(app);
            assert_eq!(after.len(), 1);
            assert_ne!(after[0].get("id").and_then(Value::as_i64), Some(id));
            // remove flushes synchronously → the deletion is on disk immediately.
            assert_eq!(jsonstore::load(app, "history").len(), 1);
        });
    }

    #[test]
    fn clear_empties_cache_and_disk() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            flush(app); // ensure disk has a row to be cleared
            assert_eq!(jsonstore::load(app, "history").len(), 1);
            dispatch(app, "history.clear", &json!({})).unwrap().unwrap();
            assert!(snapshot(app).is_empty());
            assert!(jsonstore::load(app, "history").is_empty());
        });
    }

    #[test]
    fn update_title_sets_most_recent_matching_url() {
        with_tmp_app(|app| {
            record(app, "https://t.test/", "", false);
            update_title(app, "https://t.test/", "Titled", false);
            let items = snapshot(app);
            let title = items[0].get("title").and_then(Value::as_str);
            assert_eq!(title, Some("Titled"));
        });
    }

    #[test]
    fn dispatch_ignores_unknown_channel() {
        with_tmp_app(|app| {
            assert!(dispatch(app, "history.nope", &json!({})).is_none());
        });
    }
}
