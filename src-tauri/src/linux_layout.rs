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

/// Record page titles into history as WebKit makes them available. The visit is
/// recorded URL-only at page-load (nav.rs); the title arrives slightly later via
/// the WebView's "title" property, so we fill it in on the title-changed signal.
pub fn connect_title_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
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
pub fn connect_fullscreen_exit_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
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

/// Show/hide a specific content webview by label at the GTK level (Tauri's hide()
/// doesn't act on the reparented widget). Used per-tab from nav.rs's on_page_load so
/// each tab hides/shows its OWN webview.
pub fn set_content_visible_label(app: &AppHandle, label: &str, visible: bool) {
    let Some(w) = app.get_webview(label) else {
        return;
    };
    let _ = w.with_webview(move |pw| {
        pw.inner().set_visible(visible);
    });
}

/// Show/hide the active content webview at the GTK level. Used by
/// view.setChromeOverlay to reveal chrome overlays.
pub fn set_content_visible(app: &AppHandle, visible: bool) {
    let label = crate::nav::active_content_label(app);
    set_content_visible_label(app, &label, visible);
}

/// Stamp a content webview's GTK widget with CONTENT_WIDGET_NAME so layout() can
/// classify it. Called once per tab from nav::spawn_tab.
pub fn mark_content_label(app: &AppHandle, label: &str) {
    if let Some(w) = app.get_webview(label) {
        let _ = w.with_webview(|pw| {
            pw.inner().set_widget_name(CONTENT_WIDGET_NAME);
        });
    }
}

/// Widget name of the native floating fullscreen-exit button, so we can find it
/// among the GtkFixed's children on later layout calls.
const FS_EXIT_NAME: &str = "aegis-fs-exit";
/// GTK widget name stamped on every content (tab) webview so `layout()` can tell
/// content webviews apart from the chrome webview without per-frame `with_webview`.
const CONTENT_WIDGET_NAME: &str = "aegis-content";
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
/// behind) and the N content webviews. Called for the initial layout and on every
/// window resize; all coordinates in logical px (scale handled by the caller).
///
/// Drives off the ACTIVE tab's webview to find the GtkFixed parent (reparenting from
/// the GtkBox on the first call). The active content webview is positioned in the
/// inset area and shown; every OTHER content webview is hidden and parked offscreen;
/// the chrome webview is stretched full-window behind it.
///
/// Normal: chrome fills the window behind the active content, which is inset so the
/// toolbar shows in the gap above it. Fullscreen: the active content fills the whole
/// window edge-to-edge and a native floating exit button (`fs_exit_button`) is raised
/// on top in the top-right corner — no top strip, and no WebKit compositing for it.
pub fn layout(
    app: &AppHandle,
    left: i32,
    top: i32,
    right: i32,
    win_w: i32,
    win_h: i32,
    fullscreen: bool,
) {
    let active_label = crate::nav::active_content_label(app);
    let Some(active) = app.get_webview(&active_label) else {
        return;
    };
    let app2 = app.clone();
    let _ = active.with_webview(move |pw| {
        let active_w = pw.inner();
        let active_widget: gtk::Widget = active_w.clone().upcast();
        let Some(parent) = active_w.parent() else {
            return;
        };

        // Reparent the box's webviews into a GtkFixed the first time; on later calls
        // the parent is already the GtkFixed.
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
            f.show_all(); // show the fixed + webviews once (initial layout)
            f
        } else {
            eprintln!("[aegis-gtk] layout: unexpected parent {}", parent.type_().name());
            return;
        };

        // The active content fills the window in fullscreen (left/top/right all 0),
        // else it's inset and the chrome shows in the gap. The floating exit button is
        // skipped here — it's positioned/raised separately below, not stretched.
        let cw = (win_w - left - right).max(0);
        let ch = (win_h - top).max(0);
        let mut active_window = None;
        for child in fixed.children() {
            let is_active = child.as_ptr() == active_widget.as_ptr();
            let name = child.widget_name();
            if is_active {
                child.set_visible(true);
                child.set_size_request(cw, ch);
                fixed.move_(&child, left, top);
                active_window = child.window();
            } else if name == FS_EXIT_NAME {
                // handled below
            } else if name == CONTENT_WIDGET_NAME {
                // a background tab's webview: hide it and park it offscreen.
                child.set_visible(false);
                fixed.move_(&child, -10000, -10000);
            } else {
                // the chrome webview: fill the window behind the active content.
                child.set_size_request(win_w, win_h);
                fixed.move_(&child, 0, 0);
            }
        }
        // Active content on top so view.setChromeOverlay can hide it to reveal chrome
        // overlays. raise() acts on the realized GdkWindow (reliable on X11).
        if let Some(w) = active_window {
            w.raise();
        }

        // Native floating exit button: shown ABOVE the content in fullscreen only,
        // pinned to the top-right corner. Raised after the content so it stays on top.
        let btn = fs_exit_button(&fixed, &app2);
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
        // No show_all here: re-showing every layout call would override the hidden
        // background tabs and the content webview's hide (view.setChromeOverlay).
    });
}
