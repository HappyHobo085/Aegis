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

/// Leave fullscreen: clear the flag, re-inset the content, and notify the chrome.
/// Shared by the Esc key handler and the native floating exit button.
fn exit_fullscreen(app: &AppHandle) {
    if let Some(s) = app.try_state::<crate::view::ContentInset>() {
        let mut g = s.0.lock().unwrap();
        if g.fullscreen {
            g.fullscreen = false;
            drop(g);
            crate::view::apply_inset(app);
            crate::emit_event(app, "view.fullscreen", serde_json::json!({ "on": false }));
        }
    }
}

/// Exit fullscreen on Esc pressed in the content webview. In fullscreen the content
/// fills the whole window; Esc (which the focused content webview receives) exits,
/// alongside the floating exit button. Only acts while fullscreen; otherwise the key
/// passes through to the page.
pub fn connect_fullscreen_exit(app: &AppHandle) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_key_press_event(move |_w, ev| {
            if ev.keyval() == gtk::gdk::keys::constants::Escape {
                let in_fs = app
                    .try_state::<crate::view::ContentInset>()
                    .map(|s| s.0.lock().unwrap().fullscreen)
                    .unwrap_or(false);
                if in_fs {
                    exit_fullscreen(&app);
                    return glib::Propagation::Stop;
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

/// Widget name of the native floating fullscreen-exit button, so we can find it
/// among the GtkFixed's children on later layout calls.
const FS_EXIT_NAME: &str = "aegis-fs-exit";
/// Floating exit button box size (px).
const FS_EXIT_SIZE: i32 = 34;
/// Its margin from the top-right corner (px).
const FS_EXIT_MARGIN: i32 = 8;

/// Find (or create once) the native GTK floating fullscreen-exit button in the
/// GtkFixed. It's a real GTK widget — not the WebKit chrome — so it paints reliably
/// over the opaque, edge-to-edge content (a shrunk WebKit chrome wouldn't repaint on
/// the NVIDIA/X11 path) and needs no transparency/compositing (the GPU path that
/// crashes the NVIDIA WebKit web process). Styled via the CSS provider in lib.rs.
fn fs_exit_button(fixed: &gtk::Fixed, app: &AppHandle) -> gtk::Widget {
    if let Some(w) = fixed
        .children()
        .into_iter()
        .find(|c| c.widget_name() == FS_EXIT_NAME)
    {
        return w;
    }
    let ebox = gtk::EventBox::new();
    ebox.set_visible_window(true);
    ebox.set_widget_name(FS_EXIT_NAME);
    ebox.set_size_request(FS_EXIT_SIZE, FS_EXIT_SIZE);
    let label = gtk::Label::new(Some("\u{2715}")); // ✕
    ebox.add(&label);
    let app = app.clone();
    ebox.connect_button_press_event(move |_, _| {
        exit_fullscreen(&app);
        glib::Propagation::Stop
    });
    fixed.put(&ebox, 0, 0);
    label.show();
    ebox.upcast()
}

/// Reparent (once, idempotent) into a GtkFixed and lay out the chrome (full window,
/// behind) and content webviews. Called for the initial layout and on every window
/// resize; all coordinates in logical px (scale handled by the caller).
///
/// Normal: chrome fills the window behind the content, which is inset so the toolbar
/// shows in the gap above it. Fullscreen: the content fills the whole window
/// edge-to-edge and a native floating exit button (`fs_exit_button`) is raised on top
/// in the top-right corner — no top strip, and no WebKit compositing for the button.
pub fn layout(
    app: &AppHandle,
    left: i32,
    top: i32,
    right: i32,
    win_w: i32,
    win_h: i32,
    fullscreen: bool,
) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let app = app.clone();
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

        // Content fills the window in fullscreen (left/top/right all 0), else it's
        // inset and the chrome shows in the gap. The floating exit button is skipped
        // here — it's positioned/raised separately below, not stretched like the chrome.
        let cw = (win_w - left - right).max(0);
        let ch = (win_h - top).max(0);
        let mut content_window = None;
        for child in fixed.children() {
            if child.as_ptr() == content_widget.as_ptr() {
                child.set_size_request(cw, ch);
                fixed.move_(&child, left, top);
                content_window = child.window();
            } else if child.widget_name() == FS_EXIT_NAME {
                // handled below
            } else {
                child.set_size_request(win_w, win_h);
                fixed.move_(&child, 0, 0);
            }
        }
        // Content on top so view.setChromeOverlay can hide it to reveal chrome overlays.
        // raise() acts on the realized GdkWindow (reliable on X11).
        if let Some(w) = content_window {
            w.raise();
        }

        // Native floating exit button: shown ABOVE the content in fullscreen only,
        // pinned to the top-right corner. Raised after the content so it stays on top.
        let btn = fs_exit_button(&fixed, &app);
        if fullscreen {
            fixed.move_(&btn, (win_w - FS_EXIT_SIZE - FS_EXIT_MARGIN).max(0), FS_EXIT_MARGIN);
            btn.show_all();
            if btn.window().is_none() {
                btn.realize();
            }
            if let Some(w) = btn.window() {
                w.raise();
            }
        } else {
            btn.hide();
        }
        // No show_all here: re-showing every layout call would override the content
        // webview's hide (used by view.setChromeOverlay to reveal chrome overlays).
    });
}
