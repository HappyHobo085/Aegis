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
    let id = label.strip_prefix("content:").and_then(|s| s.parse::<u32>().ok());
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
            if let Some(id) = id {
                crate::tabs::on_tab_title(&app, id, &title);
            }
        });
    });
}

/// Keep the address bar on the **main-frame** URL across ALL top-frame navigations,
/// including same-document History API (`pushState`/`replaceState`) and hash changes —
/// which `load-changed` (the signal behind `on_page_load`) does NOT fire for, so without
/// this the bar goes stale on SPA in-site navigation (common on streaming sites). The
/// WebView's `uri` property is the top document's URL and is main-frame only (a subframe
/// load does not change it), so `notify::uri` is the correct, flicker-free source.
/// (`on_navigation` can't be used for the bar — it fires for subframes too; see `nav.rs`.)
pub fn connect_url_tracker(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label.strip_prefix("content:").and_then(|s| s.parse::<u32>().ok()) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_uri_notify(move |wv| {
            let url = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            // The blank home (about:blank) is the chrome's Home tab — don't surface it.
            if url.is_empty() || url == "about:blank" {
                return;
            }
            let title = wv.title().map(|s| s.to_string()).unwrap_or_default();
            crate::nav::emit_state(&app, id, &url, &title, wv.is_loading());
        });
    });
}

/// Count ad/tracker subresources blocked on this tab, for the shield badge. WebKit
/// content filters block declaratively with no per-block callback, but resource-load-started
/// still fires for blocked resources (verified), so we run each subresource through the
/// same engine + EasyList and count the matches — which honors the on/off toggle +
/// per-site allowlist (`should_block` does). `note_blocked` pushes the totals to the chrome.
pub fn connect_block_counter(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let Some(id) = label.strip_prefix("content:").and_then(|s| s.parse::<u32>().ok()) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_resource_load_started(move |wv, _res, request| {
            use webkit2gtk::URIRequestExt;
            let url = request.uri().map(|s| s.to_string()).unwrap_or_default();
            let page = wv.uri().map(|s| s.to_string()).unwrap_or_default();
            if crate::adblock_engine::should_block(&url, &page, "other") {
                crate::adblock::note_blocked(&app, id);
            }
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

/// Capture tab keyboard shortcuts (Ctrl+T/W/Shift+T/Tab/Shift+Tab) in the content
/// webview and emit `tabs.shortcut` so the chrome can handle them. Mirrors
/// `connect_fullscreen_exit_label`; called from `nav::spawn_tab` for each tab.
pub fn connect_tab_keys_label(app: &AppHandle, label: &str) {
    let Some(content) = app.get_webview(label) else {
        return;
    };
    let app = app.clone();
    let _ = content.with_webview(move |pw| {
        pw.inner().connect_key_press_event(move |_w, ev| {
            let ctrl = ev.state().contains(gtk::gdk::ModifierType::CONTROL_MASK);
            let shift = ev.state().contains(gtk::gdk::ModifierType::SHIFT_MASK);
            if !ctrl {
                return glib::Propagation::Proceed;
            }
            use gtk::gdk::keys::constants as k;
            let s = match ev.keyval() {
                x if x == k::t && !shift => "new",
                x if x == k::w && !shift => "close",
                x if x == k::T && shift => "reopen",
                x if x == k::Tab && !shift => "next",
                x if (x == k::Tab || x == k::ISO_Left_Tab) && shift => "prev",
                x if x == k::_1 && !shift => "jump1",
                x if x == k::_2 && !shift => "jump2",
                x if x == k::_3 && !shift => "jump3",
                x if x == k::_4 && !shift => "jump4",
                x if x == k::_5 && !shift => "jump5",
                x if x == k::_6 && !shift => "jump6",
                x if x == k::_7 && !shift => "jump7",
                x if x == k::_8 && !shift => "jump8",
                x if x == k::_9 && !shift => "jumpLast",
                _ => return glib::Propagation::Proceed,
            };
            crate::emit_event(&app, "tabs.shortcut", s);
            glib::Propagation::Stop
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
    content_visible: bool,
) {
    let active_label = crate::nav::active_content_label(app);
    let Some(active) = app.get_webview(&active_label) else {
        return;
    };
    // The active content is shown only when no full-window chrome overlay is up AND the
    // tab isn't sitting at about:blank (where the chrome's home shows through). Read the
    // active tab's URL from the registry here (lock released before the GTK closure).
    let active_at_home = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| {
            let r = s.reg.lock().unwrap();
            let id = r.active_id();
            r.url_of(id).map(|u| u.starts_with("about:")).unwrap_or(true)
        })
        .unwrap_or(true);
    let active_visible = content_visible && !active_at_home;
    let app2 = app.clone();
    let _ = active.with_webview(move |pw| {
        let active_w = pw.inner();
        let active_widget: gtk::Widget = active_w.clone().upcast();
        let Some(parent) = active_w.parent() else {
            return;
        };

        // Resolve THE single canonical GtkFixed that must hold the chrome + every content
        // webview. The active webview's parent is either the window's GtkBox (this webview is
        // a stray just add_child'd) or the canonical GtkFixed (already reparented). Find the
        // GtkBox, find-or-create the one Fixed beneath it, then pull any stray webviews from
        // the Box into it. This prevents the nested-Fixed bug where new tabs land in a sibling
        // Fixed and never get hidden.
        let box_: gtk::Box;
        let fixed: gtk::Fixed;
        if let Some(f) = parent.dynamic_cast_ref::<gtk::Fixed>() {
            let Some(b) = f.parent().and_then(|p| p.downcast::<gtk::Box>().ok()) else { return; };
            box_ = b;
            fixed = f.clone();
        } else if let Some(b) = parent.dynamic_cast_ref::<gtk::Box>() {
            let existing = b.children().into_iter().find_map(|c| c.downcast::<gtk::Fixed>().ok());
            fixed = match existing {
                Some(f) => f,
                None => {
                    let f = gtk::Fixed::new();
                    b.pack_start(&f, true, true, 0);
                    f.show();
                    f
                }
            };
            box_ = b.clone();
        } else {
            eprintln!("[aegis-gtk] layout: unexpected parent {}", parent.type_().name());
            return;
        }
        // Pull every stray webview still parented to the Box (the chrome on the first call;
        // each newly add_child'd tab on later calls) INTO the canonical Fixed. Skip the Fixed
        // itself. Use show() per widget — NOT show_all(), which would re-reveal the hidden
        // fullscreen-exit button.
        let mut moved = 0;
        for child in box_.children() {
            if child.dynamic_cast_ref::<gtk::Fixed>().is_some() {
                continue; // the canonical Fixed
            }
            box_.remove(&child);
            fixed.put(&child, 0, 0);
            child.show();
            moved += 1;
        }
        if moved > 0 {
            eprintln!(
                "[aegis-gtk] reparented {moved} stray webview(s) into the canonical fixed; it now has {} children",
                fixed.children().len()
            );
        }

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
                child.set_visible(active_visible);
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
            // Content webviews added after the button sit above it in the Fixed's child
            // stacking, and GdkWindow.raise() alone doesn't reliably lift a GTK widget above
            // WebKit's native windows. Re-add the button LAST so it's the topmost child.
            fixed.remove(&btn);
            fixed.put(&btn, (win_w - FS_EXIT_SIZE - FS_EXIT_MARGIN).max(0), FS_EXIT_MARGIN);
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
