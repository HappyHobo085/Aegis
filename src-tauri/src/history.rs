//! Browsing history (history.* IPC) backed by the JSON store. Visits are recorded
//! from the content webview's page-load — on desktop from `nav::spawn_tab`'s
//! `on_page_load` closure, on Android from `record_page_finished` (below; the
//! content view there is a native Kotlin WebView, so wry sees no page-load at all).
//! list/search return newest first; the collection is capped to keep the file bounded.
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
//! `data.import` calls `invalidate` BEFORE overwriting the file (and again after), so a
//! background flush can never write the pre-import rows back over the imported ones — see
//! `data.rs`'s import arm.
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
fn apply_visit(items: &mut Vec<Value>, url: &str, title: &str, now: i64) -> bool {
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

/// Schemes the WHATWG URL spec gives a TUPLE (non-opaque) origin. Every other scheme --
/// `about:`, `data:`, `file:` (special but always opaque), `chrome:`, and any custom
/// scheme -- has origin the literal string `"null"`, which the renderer's `originOf`
/// normalises to `null`. An origin string can therefore never equal one of those.
fn has_tuple_origin(scheme: &str) -> bool {
    matches!(scheme, "http" | "https" | "ws" | "wss" | "ftp")
}

/// The origin of `url` in EXACTLY the form the renderer produces -- the string
/// `new URL(url).origin` returns, with an opaque origin normalised to `None`.
///
/// Deliberately NOT `permissions::origin_of`. That one is `#[cfg(target_os = "linux")]`
/// and FALLS BACK to the raw URI string when parsing fails or there is no host, which is
/// a different contract from the renderer's `null`. The origin string handed to
/// `history.removeForOrigin` comes from `originOf(url)` in the renderer, so both ends
/// must implement one contract: a "clear this site" that quietly matched raw strings
/// would delete rows the renderer never showed the user.
fn origin_of(url: &str) -> Option<String> {
    let u = tauri::Url::parse(url).ok()?;
    if !has_tuple_origin(u.scheme()) {
        return None;
    }
    let host = u.host_str().filter(|h| !h.is_empty())?;
    Some(match u.port() {
        Some(p) => format!("{}://{}:{}", u.scheme(), host, p),
        None => format!("{}://{}", u.scheme(), host),
    })
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
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.loaded || !inner.dirty {
            return;
        }
        inner.dirty = false;
        inner.items.clone()
    };
    if jsonstore::save(app, "history", &pending).is_err() {
        store.0.lock().unwrap_or_else(|e| e.into_inner()).dirty = true;
    }
}

/// Drop the in-memory cache so the next read reloads from disk — used by `data.import` both
/// before it writes the history file (so a background flush cannot write the pre-import rows
/// back over it) and after.
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(store) = app.try_state::<HistoryStore>() {
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
    if mutate(app, false, |items| apply_visit(items, url, title, now)) {
        crate::emit_event(app, "history.changed", Value::Null);
    }
}

/// Record a finished top-level page load for `tab_id` — the ANDROID entry point.
///
/// Desktop records from the `on_page_load` closure in `nav::spawn_tab`, which is a
/// **wry** webview callback. Android's content view is a **native Kotlin `WebView`**
/// (`MainActivity.createTabWebView`), so wry never observes those loads and
/// `on_page_load` never fires for a browsed page. Nothing else called `record`
/// either, so on Android the store was never written and the History sheet was
/// permanently empty (the mobile UI itself was fine — it was a dead store, not a
/// dead panel). Kotlin now reports each `onPageFinished` through the
/// `NativeHistory.recordVisit` JNI export below, which lands here.
///
/// Privateness is resolved HERE from the tab registry, exactly as `nav.rs` does for
/// desktop: Kotlin passes only the tab id and is never trusted to decide it, since
/// getting it wrong would write a private tab's visits to disk.
///
/// Android also has a real `WebView.title` by the time `onPageFinished` fires, so
/// the title is recorded inline here instead of waiting for a title-changed signal
/// (which only exists on Linux — see `update_title`).
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn record_page_finished<R: Runtime>(app: &AppHandle<R>, tab_id: u32, url: &str, title: &str) {
    record(app, url, title, crate::tabs::is_private(app, tab_id));
}

/// The app handle, for the JNI entry point that needs managed state. Kotlin -> Rust
/// is the only usable direction on Android (Rust cannot up-call into Kotlin), and
/// every other native entry point gets away without an `AppHandle` because it is a
/// pure function over its arguments. Recording a visit cannot: the `HistoryStore`
/// and the tab registry only exist as managed state behind a handle.
/// The handle lives in `lib.rs` now (`set_android_app`/`android_app`), not here:
/// `downloads`' Android bridge needs the same handle, and this module's own doc
/// already predicted it — "expect the next native feature to want one too". Two
/// features that both need it must not make one of them depend on the other.

/// JNI bridge for Android's `NativeHistory.recordVisit`, called from each content
/// WebView's `onPageFinished`. Same pattern (and same `ffi_guard` obligation) as
/// `safety.rs` / `adblock_engine.rs`; lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeHistory_recordVisit(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    tab_id: jni::sys::jint,
    url: jni::objects::JString,
    title: jni::objects::JString,
) {
    // A tab id is unsigned in the registry, so a negative one is malformed.
    let Ok(tab_id) = u32::try_from(tab_id) else {
        return;
    };
    // Read the JNI args into owned Strings FIRST: `JNIEnv` is `!UnwindSafe`, so it
    // must stay outside the `ffi_guard` closure (see lib.rs::ffi_guard).
    let url: String = env.get_string(&url).map(|s| s.into()).unwrap_or_default();
    let title: String = env.get_string(&title).map(|s| s.into()).unwrap_or_default();
    // A page can finish before setup publishes the handle. Dropping one visit is
    // strictly better than writing into a store that isn't managed yet.
    let Some(app) = crate::android_app() else {
        return;
    };
    if crate::ffi_guard(|| record_page_finished(app, tab_id, &url, &title)).is_none() {
        eprintln!("[aegis-history] recordVisit panicked for tab {tab_id}; visit dropped");
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
        "history.removeForOrigin" => {
            // Delete every row for one origin. This has to be a CORE operation: the renderer
            // holds only the last `history.list` page (the core default cap is 200, against
            // MAX_ENTRIES = 5000), so a renderer-side loop over those entries cannot reach the
            // rest — it reports success while most of the site's history stays on disk. This
            // filters the FULL store, so "clear this site" means it.
            let origin = payload
                .get("origin")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let want = origin.as_str();
            let mut removed: usize = 0;
            // User-initiated deletion → flush now so it leaves disk immediately.
            mutate(app, true, |items| {
                let before = items.len();
                items.retain(|it| {
                    let u = it.get("url").and_then(Value::as_str).unwrap_or("");
                    origin_of(u).as_deref() != Some(want)
                });
                removed = before - items.len();
                removed > 0
            });
            // Only on an actual change: an event that says nothing happened would just make
            // every mounted panel refetch a store that did not move.
            if removed > 0 {
                crate::emit_event(app, "history.changed", Value::Null);
            }
            Some(Ok(json!(removed)))
        }
        "history.clear" => {
            // Truly remove (history isn't synced) — clear actually clears, and flushes now.
            if let Some(store) = app.try_state::<HistoryStore>() {
                {
                    let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
        assert!(apply_visit(&mut items, "https://a/", "A", 1));
        assert!(!apply_visit(&mut items, "https://a/", "A", 2)); // consecutive dup → no-op
        assert!(apply_visit(&mut items, "https://b/", "B", 3));
        assert_eq!(items.len(), 2);
        // cap: push MAX_ENTRIES+ distinct rows, oldest are dropped, newest kept.
        for n in 0..MAX_ENTRIES + 10 {
            apply_visit(&mut items, &format!("https://x{n}/"), "x", n as i64);
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

    /// The renderer hands this channel the string `new URL(url).origin` returns. If the two
    /// ends disagree about what an origin IS, "clear this site" quietly stops matching the
    /// rows the panel is showing. These are the shapes where a hand-rolled splitter is wrong:
    /// a default port, an explicit one, mixed case, userinfo, an IPv6 literal, and the opaque
    /// schemes the renderer normalises to `null` (and therefore can never pass in).
    #[test]
    fn origin_of_matches_the_renderer_contract() {
        assert_eq!(
            origin_of("https://example.com/deep/path?q=1#f").as_deref(),
            Some("https://example.com")
        );
        // The url crate drops a DEFAULT port; `new URL().origin` drops it too.
        assert_eq!(
            origin_of("https://example.com:443/x").as_deref(),
            Some("https://example.com")
        );
        // A non-default port is kept, on both sides.
        assert_eq!(
            origin_of("https://example.com:8443/x").as_deref(),
            Some("https://example.com:8443")
        );
        // Scheme + host are case-normalised, so a mixed-case row still matches a lowercased
        // origin from the renderer.
        assert_eq!(
            origin_of("HTTPS://Example.COM/").as_deref(),
            Some("https://example.com")
        );
        // Userinfo is not part of an origin.
        assert_eq!(
            origin_of("https://user:pw@example.com/x").as_deref(),
            Some("https://example.com")
        );
        // IPv6 keeps its brackets in both implementations.
        assert_eq!(
            origin_of("http://[::1]:8080/x").as_deref(),
            Some("http://[::1]:8080")
        );
        // Opaque origins are the renderer's `null`, so they are never an origin string.
        for opaque in [
            "about:blank",
            "data:text/html,x",
            "file:///etc/passwd",
            "not a url",
        ] {
            assert_eq!(origin_of(opaque), None, "{opaque} has no tuple origin");
        }
    }

    /// The bug this channel exists for. `history.list` caps at 200 rows (the core default
    /// against `MAX_ENTRIES` 5000), and the renderer's "Clear remembered data" used to loop
    /// over exactly that page, calling `history.remove` once per visible row. So on a site
    /// the user had visited more than 200 times it reported success while most of the site's
    /// history stayed on disk — and `history.search` filters the FULL snapshot, so the user
    /// could search the "erased" rows straight back up in the History panel.
    ///
    /// Asserts the rows are gone from the STORE (which is what search reads), that the decoy
    /// origins are untouched, and that the page the renderer held genuinely could not have
    /// reached them all — otherwise this test would pass on the old behaviour too.
    #[test]
    fn remove_for_origin_clears_every_row_not_just_the_last_page() {
        with_tmp_app(|app| {
            const VISITS: usize = 250;
            for n in 0..VISITS {
                // Distinct URLs on one origin: `apply_visit` only dedups a CONSECUTIVE
                // repeat, so every one of these is a real row.
                record(app, &format!("https://busy.test/page/{n}"), "Busy", false);
            }
            record(app, "https://other.test/keep", "Other", false);
            record(app, "http://busy.test/scheme-matters", "Insecure", false);
            record(app, "https://sub.busy.test/other-host", "Subdomain", false);

            // Precondition: the page the renderer held was SMALLER than the site's history.
            // Without this, the old renderer-side loop would have been enough and this test
            // would be proving nothing.
            let page = dispatch(app, "history.list", &json!({ "opts": {} }))
                .unwrap()
                .unwrap();
            let page_rows = page.as_array().unwrap();
            assert_eq!(page_rows.len(), 200, "the default list() page is the cap");
            let page_hits = page_rows
                .iter()
                .filter(|e| {
                    origin_of(e.get("url").and_then(Value::as_str).unwrap_or("")).as_deref()
                        == Some("https://busy.test")
                })
                .count();
            // The three decoys were recorded last, so the newest-first page is those three
            // plus 197 of the 250. Precisely the gap the renderer-side loop could not cross.
            assert_eq!(page_hits, 197, "3 newest decoys + 197 of the 250");
            assert!(
                page_hits < VISITS,
                "the page must be smaller than the rows to remove"
            );

            let removed = dispatch(
                app,
                "history.removeForOrigin",
                &json!({ "origin": "https://busy.test" }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                removed,
                json!(VISITS),
                "every row for that origin, not one page of them"
            );

            // The STORE is what `history.search` reads, so this is the user-visible proof.
            let left = snapshot(app);
            assert_eq!(
                left.iter()
                    .filter(
                        |e| origin_of(e.get("url").and_then(Value::as_str).unwrap_or(""))
                            .as_deref()
                            == Some("https://busy.test")
                    )
                    .count(),
                0,
                "the supposedly-cleared rows are still searchable"
            );
            // Decoys untouched: a different origin, a different SCHEME on the same host (the
            // scheme is part of an origin), and a different host.
            let left_urls: Vec<String> = left
                .iter()
                .filter_map(|e| e.get("url").and_then(Value::as_str).map(str::to_string))
                .collect();
            assert_eq!(
                left_urls.len(),
                3,
                "only the three decoys should remain: {left_urls:?}"
            );
            for keep in [
                "https://other.test/keep",
                "http://busy.test/scheme-matters",
                "https://sub.busy.test/other-host",
            ] {
                assert!(
                    left_urls.iter().any(|u| u == keep),
                    "{keep} was wrongly removed"
                );
            }
        });
    }

    /// A second call is a no-op and reports 0, so a caller that double-fires the button
    /// cannot tell the user it removed rows the second time.
    #[test]
    fn remove_for_origin_is_idempotent_and_reports_zero_the_second_time() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            record(app, "https://a.test/2", "A2", false);
            let first = dispatch(
                app,
                "history.removeForOrigin",
                &json!({ "origin": "https://a.test" }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(first, json!(2));
            let second = dispatch(
                app,
                "history.removeForOrigin",
                &json!({ "origin": "https://a.test" }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(second, json!(0));
            assert!(snapshot(app).is_empty());
        });
    }

    /// A degenerate origin must remove nothing, and must not fall back to some other
    /// representation of a row's URL.
    ///
    /// The rows with no tuple origin are PLANTED, not recorded: `should_record_visit` refuses
    /// `about:` and `data:`, but `data.import` writes whatever a backup bundle holds straight
    /// into this store, so the store really can hold them and this channel really can see
    /// them. `permissions::origin_of` — the one other origin parser in the crate — falls back
    /// to the RAW STRING for exactly these, which is the behaviour being ruled out here.
    #[test]
    fn remove_for_origin_never_matches_on_a_degenerate_origin() {
        with_tmp_app(|app| {
            record(app, "https://a.test/", "A", false);
            let planted = ["about:blank", "data:text/html,x", "file:///etc/passwd"];
            mutate(app, true, |items| {
                for (n, url) in planted.iter().enumerate() {
                    items.push(json!({
                        "id": 900_000 + n as i64,
                        "url": url,
                        "title": "Planted",
                        "visitedAt": 1,
                    }));
                }
                true
            });
            assert_eq!(
                snapshot(app).len(),
                4,
                "the planted rows are really in the store"
            );
            for degenerate in [
                "",
                "null",
                "about:blank",
                "file://",
                "not-a-url",
                "https://",
            ] {
                let removed = dispatch(
                    app,
                    "history.removeForOrigin",
                    &json!({ "origin": degenerate }),
                )
                .unwrap()
                .unwrap();
                assert_eq!(removed, json!(0), "{degenerate:?} must not match any row");
            }
            assert_eq!(snapshot(app).len(), 4, "every row must still be there");
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

    /// The Android record path (`record_page_finished`) resolves the tab's privateness
    /// from the registry. That resolution is the load-bearing part of the fix — Kotlin
    /// passes a bare tab id and never decides privateness itself, so if this lookup were
    /// wrong a private tab's pages would be written to disk in plain history. Runs on
    /// every target (the function is platform-agnostic; only its JNI caller is
    /// Android-only), which is the whole reason it exists as a separate seam.
    #[test]
    fn record_page_finished_skips_private_tabs_and_keeps_the_title() {
        with_tmp_app(|app| {
            // A normal tab (the boot tab, id 1) records, with the title Android has.
            record_page_finished(app, 1, "https://normal.test/", "Normal Page");
            let items = snapshot(app);
            assert_eq!(items.len(), 1, "a normal tab's visit must be recorded");
            assert_eq!(
                items[0].get("url").and_then(Value::as_str),
                Some("https://normal.test/")
            );
            assert_eq!(
                items[0].get("title").and_then(Value::as_str),
                Some("Normal Page"),
                "the title Android supplies must be stored, not dropped"
            );

            // A private tab's visit must NOT be recorded.
            let private_id = {
                let tabs = app.state::<crate::tabs::Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.create_private(Some("https://private.test/".into()), false, 0, true);
                let ts = reg.tabs_state();
                ts.active_id
            };
            assert!(
                crate::tabs::is_private(app, private_id),
                "fixture must be private"
            );
            record_page_finished(app, private_id, "https://private.test/", "Secret");

            let urls: Vec<String> = snapshot(app)
                .iter()
                .filter_map(|i| i.get("url").and_then(Value::as_str).map(String::from))
                .collect();
            assert_eq!(
                urls,
                vec!["https://normal.test/".to_string()],
                "a private tab's visit must never reach the history store"
            );
        });
    }

    /// Non-web URLs are filtered on the Android path too — the malware interstitial
    /// finishes its `loadDataWithBaseURL` warning page through the same
    /// `onPageFinished`, and recording it would put an Aegis error page in history.
    #[test]
    fn record_page_finished_skips_non_web_schemes() {
        with_tmp_app(|app| {
            record_page_finished(app, 1, "about:blank", "");
            record_page_finished(app, 1, "data:text/html,x", "");
            record_page_finished(app, 1, "", "");
            assert!(
                snapshot(app).is_empty(),
                "about:/data:/empty page-finishes must not be recorded"
            );
            record_page_finished(app, 1, "https://real.test/", "Real");
            assert_eq!(snapshot(app).len(), 1);
        });
    }
}
