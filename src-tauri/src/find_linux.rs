// Linux find-in-page via WebKitFindController.
//
// Confirmed bindings (webkit2gtk-2.0.2 src/auto/find_controller.rs,
// src/auto/web_view.rs, src/auto/flags.rs):
//
//   WebViewExt::find_controller()             → Option<FindController>  (web_view.rs:1019)
//   FindControllerExt::search(text, opts:u32, max:u32)                  (find_controller.rs:115)
//   FindControllerExt::search_next()                                    (find_controller.rs:133)
//   FindControllerExt::search_previous()                                (find_controller.rs:141)
//   FindControllerExt::search_finish()                                  (find_controller.rs:127)
//   FindControllerExt::search_text() → Option<glib::GString>           (find_controller.rs:96)
//   FindControllerExt::connect_found_text(Fn(&Self, u32))               (find_controller.rs:206)
//   FindControllerExt::connect_failed_to_find_text(Fn(&Self))           (find_controller.rs:181)
//   FindOptions::{ CASE_INSENSITIVE, WRAP_AROUND }  (flags.rs:124,132)
//
// GLib/WebKit objects are NOT Send, so FindController cannot be moved out of the
// with_webview closure (which is FnOnce + Send + 'static). Instead every public
// function looks up the controller inside with_webview and calls it there — this
// is the documented fallback in the task brief (task-6-brief.md §verify-first).
//
// The `found-text` / `failed-to-find-text` signals are installed once at tab spawn
// (via `install`) and push live match counts back to the chrome via emit_state.

use tauri::{AppHandle, Manager};
use webkit2gtk::{FindControllerExt, FindOptions, WebViewExt};

/// Options bit-helper: returns the `u32` to pass to `search()`.
/// Exported as `pub` so it can be unit-tested.
pub fn options_bits(case_sensitive: bool) -> u32 {
    let mut opts = FindOptions::WRAP_AROUND;
    if !case_sensitive {
        opts |= FindOptions::CASE_INSENSITIVE;
    }
    opts.bits()
}

/// Install the `found-text` / `failed-to-find-text` signal handlers on this
/// tab's WebKitFindController.
///
/// # MUST be called exactly once per content webview
///
/// This function connects two GLib signals and discards the returned
/// `SignalHandlerId`s — there is no deduplication guard.  A second call on
/// the same webview would stack duplicate handlers: every subsequent
/// `found-text` signal would fire `find.state` N times (once per handler),
/// producing incorrect match counts in the FindBar.
///
/// The contract is satisfied today: the only caller is `nav::spawn_tab`
/// (Linux block, next to `connect_block_counter`), which runs exactly once
/// per tab at webview creation time.  Do not add a second call site.
pub fn install(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label
        .strip_prefix("content:")
        .and_then(|s| s.parse::<u32>().ok())
    else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        if let Some(fc) = pw.inner().find_controller() {
            let app_found = app.clone();
            fc.connect_found_text(move |c, count| {
                let q = c.search_text().map(|s| s.to_string()).unwrap_or_default();
                // WebKitGTK has no active-index getter; report 1 when at least one
                // match exists (the controller focuses the first), else 0.
                let active = if count > 0 { 1 } else { 0 };
                crate::find::emit_state(&app_found, id, &q, count, active);
            });
            let app_fail = app.clone();
            fc.connect_failed_to_find_text(move |c| {
                let q = c.search_text().map(|s| s.to_string()).unwrap_or_default();
                crate::find::emit_state(&app_fail, id, &q, 0, 0);
            });
        }
    });
}

const MAX_MATCHES: u32 = 1000;

pub fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    let Some(w) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let query = query.to_string();
    let app = app.clone();
    let _ = w.with_webview(move |pw| {
        if let Some(fc) = pw.inner().find_controller() {
            if query.is_empty() {
                fc.search_finish();
                crate::find::emit_state(&app, id, "", 0, 0);
            } else {
                fc.search(&query, options_bits(case_sensitive), MAX_MATCHES);
                // The live count arrives via the connected found-text / failed-to-find-text
                // signal — no need to call emit_state here.
            }
        }
    });
}

pub fn next(app: &AppHandle, id: u32) {
    let Some(w) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let _ = w.with_webview(|pw| {
        if let Some(fc) = pw.inner().find_controller() {
            fc.search_next();
        }
    });
}

pub fn prev(app: &AppHandle, id: u32) {
    let Some(w) = app.get_webview(&crate::nav::content_label(id)) else {
        return;
    };
    let _ = w.with_webview(|pw| {
        if let Some(fc) = pw.inner().find_controller() {
            fc.search_previous();
        }
    });
}

pub fn close(app: &AppHandle, id: u32) {
    // Stop the WebKit find session when the webview is still alive.
    if let Some(w) = app.get_webview(&crate::nav::content_label(id)) {
        let _ = w.with_webview(move |pw| {
            if let Some(fc) = pw.inner().find_controller() {
                fc.search_finish();
            }
        });
    }
    // Always reset the FindBar — even if the webview was idle-discarded and
    // the with_webview block above was skipped.
    crate::find::emit_state(app, id, "", 0, 0);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn options_bits_case_insensitive() {
        let bits = options_bits(false);
        // Must include WRAP_AROUND and CASE_INSENSITIVE
        assert_ne!(bits, 0);
        let expected = (FindOptions::WRAP_AROUND | FindOptions::CASE_INSENSITIVE).bits();
        assert_eq!(bits, expected);
    }

    #[test]
    fn options_bits_case_sensitive() {
        let bits = options_bits(true);
        let expected = FindOptions::WRAP_AROUND.bits();
        assert_eq!(bits, expected);
    }

    #[test]
    fn options_bits_differ_by_case_sensitivity() {
        assert_ne!(options_bits(false), options_bits(true));
    }
}
