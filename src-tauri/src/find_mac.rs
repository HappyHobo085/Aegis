//! macOS: find-in-page via a JS shim injected into the content WKWebView.
//!
//! # Why a shim?
//! The native `WKWebView::findString:withConfiguration:completionHandler:` only
//! returns `matchFound` (a bool) — no match count, no highlight-all, no active
//! index.  Linux (WebKitFindController) and Windows (`ICoreWebView2Find`) both
//! provide full fidelity.  This shim closes that parity gap.
//!
//! # How it works
//! At tab spawn (`install`), a JS module is injected via `evaluateJavaScript`
//! that defines `window.__aegisFind(query, caseSensitive, direction, close)`.
//! The shim uses `TreeWalker` to walk visible text nodes, highlights all matches
//! via `Range` + overlay divs, tracks the active match index, and returns the
//! result as a sentinel string `AEGISFIND:{matchCount}:{activeMatchIndex}`.  It
//! also sets `document.title` to the sentinel (restored after a brief delay) for
//! any title observers.
//!
//! Every `start`/`next`/`prev`/`close` call re-includes the shim definition
//! (idempotent — guarded by `if (window.__aegisFind) return`) so the function
//! survives page navigations within the same tab.
//!
//! # Compile note
//! macOS objc2 code cannot be compiled from Linux (objc2's build script needs a
//! macOS C toolchain).  All verification of this file is CI-only (macos-latest
//! in tauri-build-check.yml).  GUI behavior requires a macOS desktop session.
//!
//! # WKWebView access
//! Mirrors `nav_url_mac::install`: `with_webview` → `pw.inner() as *mut WKWebView`
//! → `Retained::retain(ptr)`.  The `with_webview` callback runs on the main
//! thread, so `MainThreadMarker::new_unchecked()` is safe within it.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

use block2::RcBlock;
use objc2::rc::Retained;
use objc2::runtime::AnyObject;
use objc2::MainThreadMarker;
use objc2_foundation::{NSError, NSString};
use objc2_web_kit::WKWebView;
use tauri::{AppHandle, Manager};

// ── Bundled JS shim ──────────────────────────────────────────────────────────

/// The find-in-page JS shim, bundled at compile time via `include_str!`.
/// Defines `window.__aegisFind` and is idempotent (safe to re-inject).
const FIND_SHIM_JS: &str = include_str!("find_shim.js");

// ── Per-tab state ────────────────────────────────────────────────────────────

/// Last-issued query + case_sensitive per tab id.  `next`/`prev` re-use these
/// so the caller doesn't need to resend them.
static LAST_QUERY: OnceLock<Mutex<HashMap<u32, (String, bool)>>> = OnceLock::new();

fn query_store() -> &'static Mutex<HashMap<u32, (String, bool)>> {
    LAST_QUERY.get_or_init(|| Mutex::new(HashMap::new()))
}

fn set_last_query(id: u32, query: &str, case_sensitive: bool) {
    if let Ok(mut map) = query_store().lock() {
        map.insert(id, (query.to_string(), case_sensitive));
    }
}

fn get_last_query(id: u32) -> Option<(String, bool)> {
    query_store()
        .lock()
        .ok()
        .and_then(|map| map.get(&id).cloned())
}

fn clear_last_query(id: u32) {
    if let Ok(mut map) = query_store().lock() {
        map.remove(&id);
    }
}

// ── Sentinel parsing ─────────────────────────────────────────────────────────

/// Parse `AEGISFIND:{matchCount}:{activeMatchIndex}` from the JS return value.
/// Any malformed input yields `(0, 0)` — fail-open.
fn parse_sentinel(s: &str) -> (u32, u32) {
    let Some(rest) = s.strip_prefix("AEGISFIND:") else {
        return (0, 0);
    };
    let mut parts = rest.splitn(2, ':');
    let count = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    let index = parts.next().and_then(|p| p.parse().ok()).unwrap_or(0);
    (count, index)
}

// ── WKWebView accessor ───────────────────────────────────────────────────────

/// Run a closure with a retained reference to the content WKWebView for `id`.
/// The closure runs on the main thread (via `with_webview`).
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
        // SAFETY: ptr is non-null and is a valid WKWebView owned by wry.
        if let Some(wv) = unsafe { Retained::retain(ptr) } {
            f(&wv);
        }
    });
}

// ── JS evaluation helper ─────────────────────────────────────────────────────

/// Build the full JS string: shim definition (idempotent) + `__aegisFind(...)` call.
fn build_js_call(query: &str, case_sensitive: bool, direction: &str, close: bool) -> String {
    // JSON-encode the query for safe embedding in a JS string literal.
    let q_json = serde_json::to_string(query).unwrap_or_else(|_| "\"\"".into());
    let d_json = serde_json::to_string(direction).unwrap_or_else(|_| "\"\"".into());
    format!("{FIND_SHIM_JS}\n__aegisFind({q_json}, {case_sensitive}, {d_json}, {close});")
}

/// Execute a JS string on the content WKWebView and call `f` with the parsed
/// sentinel when the evaluation completes.
fn eval_find<F>(app: &AppHandle, id: u32, js: String, f: F)
where
    F: FnOnce(u32, u32) + Send + 'static,
{
    with_content_webview(app, id, move |wv| {
        unsafe {
            let ns_js = NSString::from_str(&js);
            let block = RcBlock::new(move |result: *mut AnyObject, _error: *mut NSError| {
                let (count, idx) = if !result.is_null() {
                    // SAFETY: result is a non-null NSString returned by the JS expression
                    // `__aegisFind(...)` which always returns a string.
                    let s = unsafe { &*(result as *const NSString) }.to_string();
                    parse_sentinel(&s)
                } else {
                    (0, 0)
                };
                f(count, idx);
            });
            // evaluateJavaScript:completionHandler: (requires block2 feature).
            // &*block coerces RcBlock → &Block via Deref.
            wv.evaluateJavaScript_completionHandler(&ns_js, Some(&*block));
        }
    });
}

// ── Core find call ───────────────────────────────────────────────────────────

/// Run the JS shim find call on the content webview for tab `id` and emit
/// the parsed result via `find::emit_state`.
fn run_find(
    app: &AppHandle,
    id: u32,
    query: &str,
    case_sensitive: bool,
    direction: &str,
    close: bool,
) {
    let app_cb = app.clone();
    let query_owned = query.to_string();
    let js = build_js_call(query, case_sensitive, direction, close);
    eval_find(app, id, js, move |count, idx| {
        crate::find::emit_state(&app_cb, id, &query_owned, count, idx);
    });
}

// ── Public API (called from find.rs dispatcher) ──────────────────────────────

/// Install the find-in-page JS shim on the content webview for tab `id`.
/// Called once from `nav::spawn_tab` on the macOS path.  The shim defines
/// `window.__aegisFind` so it's available for subsequent find calls.
pub fn install(pw: &tauri::webview::PlatformWebview, _app: AppHandle, _id: u32) {
    let ptr = pw.inner() as *mut WKWebView;
    if ptr.is_null() {
        return;
    }
    // SAFETY: ptr is non-null and is a valid WKWebView owned by wry.
    let Some(wv) = (unsafe { Retained::retain(ptr) }) else {
        return;
    };
    unsafe {
        let ns_js = NSString::from_str(FIND_SHIM_JS);
        // Fire-and-forget: the completion handler is a no-op.  We only need the
        // shim defined; the actual find calls happen later via `start`/`next`/etc.
        let _block = RcBlock::new(move |_result: *mut AnyObject, _error: *mut NSError| {});
        // We intentionally don't keep the block alive — the evaluateJavaScript
        // call retains it internally until the JS finishes executing.
        wv.evaluateJavaScript_completionHandler(&ns_js, None);
    }
}

/// Start (or restart) a find session with `query`.
pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    if query.is_empty() {
        clear_last_query(id);
        crate::find::emit_state(app, id, "", 0, 0);
        return;
    }
    set_last_query(id, query, case_sensitive);
    run_find(app, id, query, case_sensitive, "forward", false);
}

/// Move to the next match (re-issue last query forwards).
pub fn next(app: &AppHandle, id: u32) {
    if let Some((q, cs)) = get_last_query(id) {
        if !q.is_empty() {
            run_find(app, id, &q, cs, "forward", false);
        }
    }
}

/// Move to the previous match (re-issue last query backwards).
pub fn prev(app: &AppHandle, id: u32) {
    if let Some((q, cs)) = get_last_query(id) {
        if !q.is_empty() {
            run_find(app, id, &q, cs, "backward", false);
        }
    }
}

/// Close the find session: clear highlights, reset stored query, reset FindBar.
pub fn close(app: &AppHandle, id: u32) {
    clear_last_query(id);
    // Tell the shim to clear all highlights.  The sentinel result (0,0) is
    // emitted after the JS completes.  Also emit immediately so the FindBar
    // resets even if the webview was idle-discarded.
    let app_cb = app.clone();
    let js = build_js_call("", false, "", true);
    eval_find(app, id, js, move |_, _| {
        crate::find::emit_state(&app_cb, id, "", 0, 0);
    });
    // Emit now as a belt-and-suspenders — if the webview was discarded, the
    // eval_find closure never fires.
    crate::find::emit_state(app, id, "", 0, 0);
}

// ── Tests ────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sentinel_valid() {
        assert_eq!(parse_sentinel("AEGISFIND:42:7"), (42, 7));
    }

    #[test]
    fn parse_sentinel_zero() {
        assert_eq!(parse_sentinel("AEGISFIND:0:0"), (0, 0));
    }

    #[test]
    fn parse_sentinel_missing_prefix() {
        assert_eq!(parse_sentinel("garbage"), (0, 0));
    }

    #[test]
    fn parse_sentinel_empty() {
        assert_eq!(parse_sentinel(""), (0, 0));
    }

    #[test]
    fn parse_sentinel_partial() {
        // Missing index part — only count.
        assert_eq!(parse_sentinel("AEGISFIND:5"), (5, 0));
    }

    #[test]
    fn parse_sentinel_non_numeric() {
        assert_eq!(parse_sentinel("AEGISFIND:abc:def"), (0, 0));
    }

    #[test]
    fn build_js_call_escaping() {
        let js = build_js_call("hello \"world\"", true, "forward", false);
        // The query should be JSON-escaped in the JS string.
        assert!(js.contains("hello \\\"world\\\""));
        assert!(js.contains("true"));
        assert!(js.contains("\"forward\""));
        assert!(js.contains("false"));
        // The shim definition is prepended.
        assert!(js.contains("__aegisFind"));
        assert!(js.contains("TreeWalker"));
    }

    #[test]
    fn build_js_call_close() {
        let js = build_js_call("", false, "", true);
        assert!(js.contains("true")); // close param
        assert!(js.contains("\"\"")); // empty query
    }

    #[test]
    fn query_store_round_trip() {
        // Use a unique id to avoid colliding with other tests.
        let id = 999_999;
        set_last_query(id, "test", true);
        assert_eq!(get_last_query(id), Some(("test".into(), true)));
        clear_last_query(id);
        assert_eq!(get_last_query(id), None);
    }

    #[test]
    fn query_store_overwrites() {
        let id = 999_998;
        set_last_query(id, "first", false);
        set_last_query(id, "second", true);
        assert_eq!(get_last_query(id), Some(("second".into(), true)));
        clear_last_query(id);
    }
}
