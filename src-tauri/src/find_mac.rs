//! macOS: find-in-page via `WKWebView::findString:withConfiguration:completionHandler:`.
//!
//! # Degradation (honest)
//! `WKFindResult` exposes ONLY `matchFound` (a bool) — there is no match count and
//! `findString:` selects/scrolls to ONE result rather than highlighting all matches.
//! So on macOS via this native API:
//! - `start` / `next` / `prev` each issue `findString:` (with `backwards` toggled for
//!   `prev`) and `emit_state` with `matchCount = if matchFound { 1 } else { 0 }`,
//!   `activeMatchIndex = 0` (unknown).
//! - The FindBar shows "1 match" when something is found and "0 matches" when not —
//!   the real count + highlight-all would require a JS-shim tier (documented follow-up).
//!
//! # Compile note
//! macOS objc2 code cannot be compiled from Linux (objc2's build script needs a macOS
//! C toolchain). All verification of this file is CI-only (macos-latest in
//! tauri-build-check.yml). GUI behavior requires a macOS desktop session.
//!
//! # WKWebView access
//! Mirrors `nav_url_mac::install`: `with_webview` → `pw.inner() as *mut WKWebView` →
//! `Retained::retain(ptr)`. The `with_webview` callback runs on the main thread, so
//! `MainThreadMarker::new_unchecked()` is safe within it.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::MainThreadMarker;
use objc2_foundation::NSString;
use objc2_web_kit::{WKFindConfiguration, WKFindResult, WKWebView};
use tauri::{AppHandle, Manager};

// ── Per-tab last-query store ─────────────────────────────────────────────────

/// Last-issued query per tab id. Needed so `next`/`prev` can re-issue the same
/// query after `start` — `findString:` takes a full query string each call; there
/// is no "move to next" API without reissuing the string.
static LAST_QUERY: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();

fn last_query_store() -> &'static Mutex<HashMap<u32, String>> {
    LAST_QUERY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_last_query(id: u32, query: &str) {
    if let Ok(mut map) = last_query_store().lock() {
        map.insert(id, query.to_string());
    }
}

fn get_last_query(id: u32) -> Option<String> {
    last_query_store()
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned())
}

// ── WKWebView accessor ───────────────────────────────────────────────────────

/// Retain a strong reference to the content WKWebView for `id`.
/// Must only be called from within a `with_webview` closure (which runs on the
/// main thread), but we can't do the async call there — so instead we call
/// `run` directly inside `with_webview`.
fn with_content_webview<F>(app: &AppHandle, id: u32, f: F)
where
    F: FnOnce(&WKWebView) + Send + 'static,
{
    let label = crate::nav::content_label(id);
    let Some(content) = app.get_webview(&label) else {
        return;
    };
    let _ = content.with_webview(move |pw| {
        let ptr = pw.inner() as *mut WKWebView;
        if ptr.is_null() {
            return;
        }
        // pw.inner() is a borrowed pointer — retain so we have a valid strong ref.
        // SAFETY: ptr is non-null and is a valid WKWebView owned by wry.
        if let Some(wv) = unsafe { Retained::retain(ptr) } {
            f(&wv);
        }
    });
}

// ── Core find call ───────────────────────────────────────────────────────────

/// Issue `findString:withConfiguration:completionHandler:` on the content
/// WKWebView for tab `id`.
fn run(app: &AppHandle, id: u32, query: &str, case_sensitive: bool, backwards: bool) {
    let app_for_webview = app.clone();
    let app_for_callback = app.clone();
    let query_owned = query.to_string();
    with_content_webview(&app_for_webview, id, move |wv| {
        unsafe {
            // `with_webview` runs on the main thread; MainThreadMarker::new_unchecked
            // is safe here.
            let mtm = MainThreadMarker::new_unchecked();

            let cfg = WKFindConfiguration::new(mtm);
            cfg.setBackwards(backwards);
            cfg.setCaseSensitive(case_sensitive);
            cfg.setWraps(true);

            let ns_query = NSString::from_str(&query_owned);

            // Clone what the completion block needs (app is already Clone).
            let app_cb = app_for_callback.clone();
            let q_cb = query_owned.clone();

            // RcBlock<dyn Fn(NonNull<WKFindResult>)> derefs to Block<...> == DynBlock<...>.
            let block = RcBlock::new(move |res: std::ptr::NonNull<WKFindResult>| {
                let found = res.as_ref().matchFound();
                // Degraded: WKFindResult only exposes matchFound (bool).
                // matchCount = 1 if found, 0 if not; activeMatchIndex always 0 (unknown).
                crate::find::emit_state(&app_cb, id, &q_cb, if found { 1 } else { 0 }, 0);
            });

            // findString:withConfiguration:completionHandler: requires features
            // WKFindConfiguration + WKFindResult + block2 (all enabled in Cargo.toml).
            // &*block coerces RcBlock<F> → &Block<F> (== &DynBlock<F>) via Deref.
            wv.findString_withConfiguration_completionHandler(&ns_query, Some(&cfg), &*block);
        }
    });
}

// ── Public API (called from find.rs dispatcher) ──────────────────────────────

/// Install hook — no persistent listener needed on macOS (the completion block
/// carries the result per call). Called from `nav::spawn_tab` on the macOS path.
pub fn install(_pw: &tauri::webview::PlatformWebview, _app: AppHandle, _id: u32) {
    // No-op: WKWebView find is fully callback-per-call; nothing to wire at spawn time.
}

/// Start (or restart) a find session with `query`.
pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    if query.is_empty() {
        // Clear the bar and reset the stored query.
        set_last_query(id, "");
        crate::find::emit_state(app, id, "", 0, 0);
        return;
    }
    set_last_query(id, query);
    run(app, id, query, case_sensitive, false);
}

/// Move to the next match (re-issue last query forwards).
pub fn next(app: &AppHandle, id: u32) {
    if let Some(q) = get_last_query(id) {
        if !q.is_empty() {
            // Re-issue forwards; case_sensitive state is not stored — default to false
            // (matches the start default; a follow-up could store it alongside the query).
            run(app, id, &q, false, false);
        }
    }
}

/// Move to the previous match (re-issue last query backwards).
pub fn prev(app: &AppHandle, id: u32) {
    if let Some(q) = get_last_query(id) {
        if !q.is_empty() {
            run(app, id, &q, false, true);
        }
    }
}

/// Close the find session: reset the stored query and clear the FindBar.
pub fn close(app: &AppHandle, id: u32) {
    set_last_query(id, "");
    crate::find::emit_state(app, id, "", 0, 0);
}
