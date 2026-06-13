// Content-webview layout (Phase 0 Task 7). The chrome reports a constant inset
// (toolbar + favbar height) via `view.setContentInset`; we size/position the
// content webview to fill the window below that inset, and recompute on resize.
use serde_json::Value;
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

use crate::nav::{CONTENT_LABEL, DEFAULT_INSET_TOP};

/// Current content inset (left, top) in logical px. Managed by Tauri state so the
/// resize handler and `setContentInset` agree.
pub struct ContentInset(pub Mutex<(f64, f64)>);

impl Default for ContentInset {
    fn default() -> Self {
        ContentInset(Mutex::new((0.0, DEFAULT_INSET_TOP)))
    }
}

/// Resize/reposition the content webview to fill the window below the stored inset.
pub fn apply_inset(app: &AppHandle) {
    let (left, top) = app
        .try_state::<ContentInset>()
        .map(|s| *s.0.lock().unwrap())
        .unwrap_or((0.0, DEFAULT_INSET_TOP));
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
        logical.width as i32,
        logical.height as i32,
    );

    #[cfg(not(target_os = "linux"))]
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let w = (logical.width - left).max(0.0);
        let h = (logical.height - top).max(0.0);
        let _ = content.set_bounds(tauri::Rect {
            position: tauri::LogicalPosition::new(left, top).into(),
            size: tauri::LogicalSize::new(w, h).into(),
        });
    }
}

/// Handle `view.*` channels. Returns `None` if not a view channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let res: Result<Value, String> = match channel {
        "view.setContentInset" => {
            let top = payload.pointer("/inset/top").and_then(Value::as_f64).unwrap_or(0.0);
            let left = payload.pointer("/inset/left").and_then(Value::as_f64).unwrap_or(0.0);
            if let Some(state) = app.try_state::<ContentInset>() {
                *state.0.lock().unwrap() = (left, top);
            }
            apply_inset(app);
            Ok(Value::Null)
        }
        "view.setContentVisible" => {
            let visible = payload.get("visible").and_then(Value::as_bool).unwrap_or(true);
            if let Some(w) = app.get_webview(CONTENT_LABEL) {
                let _ = if visible { w.show() } else { w.hide() };
            }
            Ok(Value::Null)
        }
        // Full-window chrome overlay z-swap + fullscreen land in Phase 2.
        "view.setChromeOverlay" => Ok(Value::Null),
        "view.setFullscreen" => Ok(Value::Null),
        _ => return None,
    };
    Some(res)
}
