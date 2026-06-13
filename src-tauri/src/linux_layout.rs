// Linux-only workaround for tauri#10420: wry packs every webview into the
// window's vertical GtkBox (pack_start, expand+fill), so a chrome + content pair
// stacks vertically and `set_bounds` is ignored. We reach the underlying
// webkit2gtk widgets via `with_webview`, reparent them into a GtkFixed (which
// honors absolute positions), and drive their geometry ourselves.
//
// Hierarchy before:  GtkApplicationWindow → GtkBox → [chrome, content]
// Hierarchy after:   GtkApplicationWindow → GtkBox → GtkFixed → [chrome@(0,0), content@(left,top)]
use gtk::prelude::*;
use tauri::{AppHandle, Manager};
use webkit2gtk::WebViewExt;

use crate::nav::CONTENT_LABEL;

/// Record page titles into history as WebKit makes them available. The visit is
/// recorded URL-only at page-load (nav.rs); the title arrives slightly later via
/// the WebView's "title" property, so we fill it in on the title-changed signal.
pub fn connect_title(app: &AppHandle) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_title_notify(move |wv| {
            let title = wv.title().map(|s| s.to_string()).unwrap_or_default();
            // The element picker signals a picked selector via a title sentinel
            // (off the native IPC surface); route it instead of recording it.
            if let Some(payload) = title.strip_prefix(crate::picker::SENTINEL) {
                crate::picker::on_picked(&app, payload);
                return;
            }
            let url = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            crate::history::update_title(&app, &url, &title);
        });
    });
}

/// Exit fullscreen on Esc pressed in the content webview. In fullscreen the content
/// fills the window and covers the chrome's exit button, so Esc (which the focused
/// content webview receives) is the exit. Only acts while fullscreen; otherwise the
/// key passes through to the page.
pub fn connect_fullscreen_exit(app: &AppHandle) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_key_press_event(move |_w, ev| {
            if ev.keyval() == gtk::gdk::keys::constants::Escape {
                if let Some(s) = app.try_state::<crate::view::ContentInset>() {
                    let mut g = s.0.lock().unwrap();
                    if g.fullscreen {
                        g.fullscreen = false;
                        drop(g);
                        crate::view::apply_inset(&app);
                        crate::emit_event(&app, "view.fullscreen", serde_json::json!({ "on": false }));
                        return glib::Propagation::Stop;
                    }
                }
            }
            glib::Propagation::Proceed
        });
    });
}

/// Show/hide the content webview at the GTK level (Tauri's hide() doesn't act on
/// the reparented widget). Used by view.setChromeOverlay to reveal chrome overlays.
pub fn set_content_visible(app: &AppHandle, visible: bool) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let _ = content.with_webview(move |pw| {
        pw.inner().set_visible(visible);
    });
}

/// Reparent (once, idempotent) into a GtkFixed and lay out the chrome (full
/// window) and content (inset) webviews. Called for the initial layout and on
/// every window resize, all coordinates in physical/logical px (scale handled by
/// the caller — GTK here is at the window's device scale).
pub fn layout(app: &AppHandle, left: i32, top: i32, right: i32, win_w: i32, win_h: i32) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let _ = content.with_webview(move |pw| {
        let content_w = pw.inner();
        let content_widget: gtk::Widget = content_w.clone().upcast();
        let Some(parent) = content_w.parent() else {
            return;
        };

        // Reparent the box's two webviews into a GtkFixed the first time; on
        // later calls the parent is already the GtkFixed.
        let fixed: gtk::Fixed = if let Some(f) = parent.dynamic_cast_ref::<gtk::Fixed>() {
            f.clone()
        } else if let Some(box_) = parent.dynamic_cast_ref::<gtk::Box>() {
            let children = box_.children();
            let f = gtk::Fixed::new();
            for child in &children {
                box_.remove(child); // child kept alive by the Vec's ref
                f.put(child, 0, 0);
            }
            box_.pack_start(&f, true, true, 0);
            f.show_all(); // show the fixed + both webviews once (initial layout)
            f
        } else {
            eprintln!("[aegis-gtk] layout: unexpected parent {}", parent.type_().name());
            return;
        };

        let cw = (win_w - left - right).max(0);
        let ch = (win_h - top).max(0);
        for child in fixed.children() {
            if child.as_ptr() == content_widget.as_ptr() {
                child.set_size_request(cw, ch);
                fixed.move_(&child, left, top);
            } else {
                // chrome: fills the whole window, the toolbar shows above the content
                child.set_size_request(win_w, win_h);
                fixed.move_(&child, 0, 0);
            }
        }
        // No show_all here: re-showing every layout call would override the content
        // webview's hide (used by view.setChromeOverlay to reveal chrome overlays).
    });
}
