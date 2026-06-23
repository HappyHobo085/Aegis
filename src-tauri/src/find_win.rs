//! Windows find-in-page via WebView2's `ICoreWebView2Find` interface.
//!
//! Access path: `with_webview` → `PlatformWebview::controller()` →
//! `CoreWebView2()` → `cast::<ICoreWebView2_28>()` → `Find()` →
//! `ICoreWebView2Find`.  Mirrors the patterns in `adblock_win.rs` and
//! `nav_url_win.rs`.
//!
//! Runtime-floor safety: `ICoreWebView2_28::Find` requires a 2024+ WebView2
//! Runtime.  If the `QueryInterface`-backed `cast` fails (older runtime),
//! every public function is a silent no-op — browsing is unaffected.
//!
//! Compile-verified via `cargo check --target x86_64-pc-windows-gnu`.
//! GUI runtime-verification is the user's Windows 11 device (CI builds it).

use tauri::{AppHandle, Manager};
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment15, ICoreWebView2Find, ICoreWebView2_28,
};
use webview2_com::{
    FindActiveMatchIndexChangedEventHandler, FindMatchCountChangedEventHandler,
    FindStartCompletedHandler,
};
use windows::core::{Interface, HSTRING};

// ── helpers ──────────────────────────────────────────────────────────────────

/// Obtain the `ICoreWebView2Find` for `pw`, returning `None` if the runtime is
/// too old to support the Find interface.
///
/// # Safety
/// Must be called from inside a `with_webview` closure (COM objects are
/// single-threaded apartment; WebView2 runs on the UI thread).
unsafe fn get_find(pw: &tauri::webview::PlatformWebview) -> Option<ICoreWebView2Find> {
    let core = pw.controller().CoreWebView2().ok()?;
    core.cast::<ICoreWebView2_28>().ok()?.Find().ok()
}

// ── public API ───────────────────────────────────────────────────────────────

/// Install `MatchCountChanged` + `ActiveMatchIndexChanged` listeners on this
/// tab's Find object so search results push the live count to the chrome.
///
/// Call inside `content.with_webview(|pw| find_win::install(&pw, app, id))`.
/// Fails silently when the runtime is too old — browsing is unaffected.
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    unsafe {
        let Some(find) = get_find(pw) else { return };

        // ── MatchCountChanged ─────────────────────────────────────────────
        let app_mc = app.clone();
        let find_mc = find.clone();
        let mc_handler =
            FindMatchCountChangedEventHandler::create(Box::new(move |_sender, _args| {
                // Read MatchCount + ActiveMatchIndex from the Find object.
                let mut count: i32 = 0;
                let _ = find_mc.MatchCount(&mut count);
                let mut active: i32 = 0;
                let _ = find_mc.ActiveMatchIndex(&mut active);
                crate::find::emit_state(&app_mc, id, "", count.max(0) as u32, active.max(0) as u32);
                Ok(())
            }));
        let mut token_mc: i64 = 0;
        let _ = find.add_MatchCountChanged(&mc_handler, &mut token_mc);

        // ── ActiveMatchIndexChanged ───────────────────────────────────────
        // Fires on FindNext/FindPrevious so the active-index indicator updates
        // without waiting for a full MatchCountChanged.
        let app_ai = app.clone();
        let find_ai = find.clone();
        let ai_handler =
            FindActiveMatchIndexChangedEventHandler::create(Box::new(move |_sender, _args| {
                let mut count: i32 = 0;
                let _ = find_ai.MatchCount(&mut count);
                let mut active: i32 = 0;
                let _ = find_ai.ActiveMatchIndex(&mut active);
                crate::find::emit_state(&app_ai, id, "", count.max(0) as u32, active.max(0) as u32);
                Ok(())
            }));
        let mut token_ai: i64 = 0;
        let _ = find.add_ActiveMatchIndexChanged(&ai_handler, &mut token_ai);
    }
}

/// Start (or restart) a find session for `query`.  Empty `query` → stop.
pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    let Some(content) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let q = query.to_string();
    let cs = case_sensitive;
    let app_clone = app.clone();
    let _ = content.with_webview(move |pw| unsafe {
        let Some(find) = get_find(&pw) else { return };

        if q.is_empty() {
            let _ = find.Stop();
            crate::find::emit_state(&app_clone, id, "", 0, 0);
            return;
        }

        // Build find options from the environment.
        let env = pw.environment();
        let Ok(env15) = env.cast::<ICoreWebView2Environment15>() else {
            return;
        };
        let Ok(opts) = env15.CreateFindOptions() else {
            return;
        };
        let _ = opts.SetFindTerm(&HSTRING::from(q.as_str()));
        let _ = opts.SetIsCaseSensitive(cs);
        let _ = opts.SetShouldHighlightAllMatches(true);
        // Suppress the native Find dialog — we draw our own FindBar.
        let _ = opts.SetSuppressDefaultFindDialog(true);

        // Completion handler: ignore the result (match counts arrive via the
        // MatchCountChanged event installed by `install()`).
        let completed = FindStartCompletedHandler::create(Box::new(|_hr| Ok(())));
        let _ = find.Start(&opts, &completed);
    });
}

/// Advance to the next match.
pub fn next(app: &AppHandle, id: u32) {
    with_find(app, id, |find| unsafe {
        let _ = find.FindNext();
    });
}

/// Go back to the previous match.
pub fn prev(app: &AppHandle, id: u32) {
    with_find(app, id, |find| unsafe {
        let _ = find.FindPrevious();
    });
}

/// Stop the find session and reset the FindBar to zero matches.
pub fn close(app: &AppHandle, id: u32) {
    with_find(app, id, |find| unsafe {
        let _ = find.Stop();
    });
    // Always reset — even if the tab was idle-discarded and with_find was a no-op.
    crate::find::emit_state(app, id, "", 0, 0);
}

// ── internal helper ───────────────────────────────────────────────────────────

/// Acquire `ICoreWebView2Find` inside `with_webview` and call `g`.
/// Silent no-op when the webview is gone or the runtime is too old.
fn with_find<G>(app: &AppHandle, id: u32, g: G)
where
    G: FnOnce(&ICoreWebView2Find) + Send + 'static,
{
    let Some(content) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let _ = content.with_webview(move |pw| unsafe {
        if let Some(find) = get_find(&pw) {
            g(&find);
        }
    });
}
