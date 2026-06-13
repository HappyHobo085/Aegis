// Content-webview layout. The chrome reports a constant top inset (toolbar +
// favbar) via `view.setContentInset`; the content webview fills the window below
// it. Overlays/sidebar/fullscreen adjust this:
//   - a full-window chrome overlay (settings, downloads, …) HIDES the content so
//     the overlay (behind the opaque content) shows;
//   - the sidebar is a right panel — it INSETS the content from the right (keeping
//     the page visible) rather than hiding it;
//   - fullscreen fills the whole window with content.
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::nav::{CONTENT_LABEL, DEFAULT_INSET_TOP};

/// Default sidebar panel width (matches `.sidebar__panel` in index.css).
const SIDEBAR_WIDTH: f64 = 280.0;

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
    /// The sidebar is active (insets content from the right; content stays visible).
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

/// Hide the content only for a full-window overlay (not the sidebar, which keeps
/// the page visible) and not in fullscreen.
fn apply_visibility(app: &AppHandle, lay: Layout) {
    let visible = lay.fullscreen || lay.sidebar || !lay.overlay;
    #[cfg(target_os = "linux")]
    crate::linux_layout::set_content_visible(app, visible);
    #[cfg(not(target_os = "linux"))]
    if let Some(w) = app.get_webview(CONTENT_LABEL) {
        let _ = if visible { w.show() } else { w.hide() };
    }
}

/// Resize/reposition the content webview to fill the window below the top inset and
/// left of the right inset (or the whole window in fullscreen).
pub fn apply_inset(app: &AppHandle) {
    let lay = layout_of(app);
    let (left, top, right) = if lay.fullscreen {
        (0.0, 0.0, 0.0)
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
    crate::linux_layout::layout(
        app,
        left as i32,
        top as i32,
        right as i32,
        logical.width as i32,
        logical.height as i32,
    );

    #[cfg(not(target_os = "linux"))]
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
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
            let visible = payload.get("visible").and_then(Value::as_bool).unwrap_or(true);
            if let Some(w) = app.get_webview(CONTENT_LABEL) {
                let _ = if visible { w.show() } else { w.hide() };
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
            update(app, |l| {
                l.sidebar = active;
                l.right = if active { SIDEBAR_WIDTH } else { 0.0 };
            });
            Ok(Value::Null)
        }
        // Fullscreen: content fills the whole window; the chrome's exit button is
        // covered, so Esc (handled in the content webview) exits.
        "view.setFullscreen" => {
            let on = payload.get("on").and_then(Value::as_bool).unwrap_or(false);
            update(app, |l| l.fullscreen = on);
            Ok(Value::Null)
        }
        _ => return None,
    };
    Some(res)
}
