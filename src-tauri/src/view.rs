// Content-webview layout. The chrome reports a constant top inset (toolbar +
// favbar) via `view.setContentInset`; the content webview fills the window below
// it. Overlays/sidebar/fullscreen adjust this:
//   - a full-window chrome overlay (settings, downloads, …) HIDES the content so
//     the overlay (behind the opaque content) shows;
//   - the History/Saved sidebar is a chrome overlay — like the others it HIDES the
//     content (the opaque content webview would otherwise cover the panel);
//   - fullscreen keeps a slim top strip for the exit button; the content fills the rest.
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::nav::DEFAULT_INSET_TOP;

/// Default sidebar panel width (matches `.sidebar__panel` in index.css).
const SIDEBAR_WIDTH: f64 = 280.0;

/// Top strip kept clear in fullscreen (non-Linux) so the chrome's exit button stays
/// visible above the content. Linux fills the window edge-to-edge instead, with a
/// native floating exit button on top (see linux_layout).
#[cfg(not(target_os = "linux"))]
const FULLSCREEN_TOP: f64 = 44.0;

/// Content-webview layout state. Managed by Tauri state so the resize handler and
/// the view.* handlers agree.
#[derive(Clone, Copy)]
pub struct Layout {
    pub left: f64,
    pub top: f64,
    /// Right inset (the sidebar panel width when the sidebar is open).
    pub right: f64,
    pub fullscreen: bool,
    /// A full-window chrome overlay is active (hides the content).
    pub overlay: bool,
    /// The sidebar is open: inset the content from the right by its width so the page
    /// stays visible beside the panel (rather than hiding it like a full overlay).
    pub sidebar: bool,
}

pub struct ContentInset(pub Mutex<Layout>);

impl Default for ContentInset {
    fn default() -> Self {
        ContentInset(Mutex::new(Layout {
            left: 0.0,
            top: DEFAULT_INSET_TOP,
            right: 0.0,
            fullscreen: false,
            overlay: false,
            sidebar: false,
        }))
    }
}

fn layout_of(app: &AppHandle) -> Layout {
    app.try_state::<ContentInset>()
        .map(|s| *s.0.lock().unwrap())
        .unwrap_or(Layout {
            left: 0.0,
            top: DEFAULT_INSET_TOP,
            right: 0.0,
            fullscreen: false,
            overlay: false,
            sidebar: false,
        })
}

/// Hide the content for a full-window chrome overlay (settings, downloads, …) so the
/// chrome shows above the opaque content webview. The sidebar is NOT a full overlay — it
/// insets the content (page stays visible beside it), so it keeps content shown.
fn apply_visibility(app: &AppHandle, lay: Layout) {
    let visible = lay.fullscreen || lay.sidebar || !lay.overlay;
    #[cfg(target_os = "linux")]
    crate::linux_layout::set_content_visible(app, visible);
    // Windows/macOS: Tauri's hide/show work directly. (Mobile is single-webview —
    // there's no separate content webview to toggle.)
    #[cfg(all(desktop, not(target_os = "linux")))]
    if let Some(w) = crate::nav::active_webview(app) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

/// Resize/reposition the content webview to fill the window below the top inset and
/// left of the right inset (or the whole window in fullscreen).
pub fn apply_inset(app: &AppHandle) {
    let lay = layout_of(app);
    // Fullscreen content geometry differs by platform: Linux fills the window
    // edge-to-edge (a native floating exit button sits on top — see linux_layout),
    // while other platforms keep a top strip for the chrome's exit button.
    #[cfg(target_os = "linux")]
    let fs = (0.0, 0.0, 0.0);
    #[cfg(not(target_os = "linux"))]
    let fs = (0.0, FULLSCREEN_TOP, 0.0);
    let (left, top, right) = if lay.fullscreen {
        fs
    } else {
        (lay.left, lay.top, lay.right)
    };
    let Some(window) = app.get_window("main") else {
        return;
    };
    let Ok(inner) = window.inner_size() else {
        return;
    };
    let scale = window.scale_factor().unwrap_or(1.0);
    let logical = inner.to_logical::<f64>(scale);

    // Linux: wry's GtkBox ignores set_bounds (tauri#10420). Position the webviews
    // ourselves via the GtkFixed workaround. Other platforms: set_bounds works.
    #[cfg(target_os = "linux")]
    {
        let content_visible = lay.fullscreen || lay.sidebar || !lay.overlay;
        crate::linux_layout::layout(
            app,
            left as i32,
            top as i32,
            right as i32,
            logical.width as i32,
            logical.height as i32,
            lay.fullscreen,
            content_visible,
        );
    }

    #[cfg(all(desktop, not(target_os = "linux")))]
    if let Some(content) = crate::nav::active_webview(app) {
        let w = (logical.width - left - right).max(0.0);
        let h = (logical.height - top).max(0.0);
        let _ = content.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(left, top).into(),
            size: tauri::LogicalSize::new(w, h).into(),
        });
    }
}

/// Mutate the layout state, then re-apply visibility + geometry.
fn update<F: FnOnce(&mut Layout)>(app: &AppHandle, f: F) {
    if let Some(state) = app.try_state::<ContentInset>() {
        f(&mut state.0.lock().unwrap());
    }
    apply_visibility(app, layout_of(app));
    apply_inset(app);
}

/// Handle `view.*` channels. Returns `None` if not a view channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let res: Result<Value, String> = match channel {
        "view.setContentInset" => {
            let top = payload.pointer("/inset/top").and_then(Value::as_f64).unwrap_or(0.0);
            let left = payload.pointer("/inset/left").and_then(Value::as_f64).unwrap_or(0.0);
            update(app, |l| {
                l.left = left;
                l.top = top;
            });
            Ok(Value::Null)
        }
        "view.setContentVisible" => {
            #[cfg(desktop)]
            {
                let visible = payload.get("visible").and_then(Value::as_bool).unwrap_or(true);
                #[cfg(target_os = "linux")]
                crate::linux_layout::set_content_visible(app, visible);
                #[cfg(not(target_os = "linux"))]
                if let Some(w) = crate::nav::active_webview(app) {
                    let _ = if visible { w.show() } else { w.hide() };
                }
            }
            Ok(Value::Null)
        }
        // A full-window chrome overlay (settings, downloads, safety interstitial, …)
        // is in the chrome webview, behind the content; hide the content so it shows.
        "view.setChromeOverlay" => {
            let active = payload.get("active").and_then(Value::as_bool).unwrap_or(false);
            update(app, |l| l.overlay = active);
            Ok(Value::Null)
        }
        // The sidebar is a right panel: inset the content from the right (page stays
        // visible) instead of hiding it.
        "view.setSidebar" => {
            let active = payload.get("active").and_then(Value::as_bool).unwrap_or(false);
            // The sidebar panel is user-resizable; inset the content by its ACTUAL width
            // (reported by the chrome) so the opaque content never overlaps the panel.
            let width = payload.get("width").and_then(Value::as_f64).unwrap_or(SIDEBAR_WIDTH);
            update(app, |l| {
                l.sidebar = active;
                l.right = if active { width } else { 0.0 };
            });
            Ok(Value::Null)
        }
        // Fullscreen: content fills the window below a slim top strip that holds the
        // chrome's exit button; Esc (handled in the content webview) also exits.
        "view.setFullscreen" => {
            let on = payload.get("on").and_then(Value::as_bool).unwrap_or(false);
            update(app, |l| l.fullscreen = on);
            Ok(Value::Null)
        }
        _ => return None,
    };
    Some(res)
}
