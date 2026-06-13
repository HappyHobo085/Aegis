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
use webkit2gtk::{PermissionRequestExt, WebViewExt};

use crate::nav::CONTENT_LABEL;

/// Deny all content-webview permission requests (geolocation, camera, mic,
/// notifications, …) by default, so sites can't grab sensitive capabilities
/// without an explicit allow flow (a remembered-permission prompt is a follow-up).
/// Mirrors the Electron app's deny-by-default.
pub fn deny_permissions(app: &AppHandle) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let _ = content.with_webview(|pw| {
        pw.inner().connect_permission_request(|_, request| {
            request.deny();
            true
        });
    });
}

/// Reparent (once, idempotent) into a GtkFixed and lay out the chrome (full
/// window) and content (inset) webviews. Called for the initial layout and on
/// every window resize, all coordinates in physical/logical px (scale handled by
/// the caller — GTK here is at the window's device scale).
pub fn layout(app: &AppHandle, left: i32, top: i32, win_w: i32, win_h: i32) {
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
            f.show();
            f
        } else {
            eprintln!("[aegis-gtk] layout: unexpected parent {}", parent.type_().name());
            return;
        };

        let cw = (win_w - left).max(0);
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
        fixed.show_all();
    });
}
