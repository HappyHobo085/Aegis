//! Page zoom (zoom.* IPC). v1 is SESSION-ONLY: the factor is held in an in-memory
//! per-tab map (NOT persisted, NOT per-origin — see the design doc §"persistence
//! decision"). The core owns the canonical value so a discarded→reloaded tab keeps
//! its zoom (replayed at spawn via `apply_to_tab`). v2 (per-origin) can layer a disk
//! store + a main-frame-origin re-apply hook WITHOUT changing this IPC surface.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 3.0;

#[derive(Default)]
pub struct ZoomStore(pub Mutex<HashMap<u32, f64>>);

/// Clamp to [ZOOM_MIN, ZOOM_MAX]; non-finite → 1.0. Pure (testable without Tauri).
pub fn clamp(f: f64) -> f64 {
    if !f.is_finite() {
        return 1.0;
    }
    // Use explicit max/min rather than f64::clamp: clamp() propagates NaN (returns NaN
    // if the input is NaN), whereas we already handled non-finite above and want the
    // bounds to be strictly [ZOOM_MIN, ZOOM_MAX]. clippy::manual_clamp is suppressed
    // because the NaN-guard above makes the semantics intentionally different.
    #[allow(clippy::manual_clamp)]
    {
        f.max(ZOOM_MIN).min(ZOOM_MAX)
    }
}

/// The stored factor for tab `id`, or 1.0 if unset.
pub fn factor_of(app: &AppHandle, id: u32) -> f64 {
    app.try_state::<ZoomStore>()
        .map(|s| *s.0.lock().unwrap().get(&id).unwrap_or(&1.0))
        .unwrap_or(1.0)
}

/// Store + apply a factor to a tab, then emit zoom.changed. Shared by set/reset.
fn put(app: &AppHandle, id: u32, factor: f64) -> Value {
    let f = clamp(factor);
    if let Some(s) = app.try_state::<ZoomStore>() {
        s.0.lock().unwrap().insert(id, f);
    }
    apply_native(app, id, f);
    let state = json!({ "viewId": id, "factor": f });
    crate::emit_event(app, "zoom.changed", state.clone());
    state
}

/// Re-apply a tab's stored factor to its (re)spawned webview. Called at the end of
/// `nav::spawn_tab` so a discard→reload keeps the user's zoom. No-op at 1.0.
// On Android the native Kotlin WebView is not reached via spawn_tab (Android uses
// its own bridge); suppress the dead_code lint only for that target.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn apply_to_tab(app: &AppHandle, id: u32) {
    let f = factor_of(app, id);
    if (f - 1.0).abs() > f64::EPSILON {
        apply_native(app, id, f);
    }
}

/// Per-platform fan-out to the live webview. Each engine's setter is gated; the
/// non-matching arms are no-ops so the lib compiles for every target.
fn apply_native(app: &AppHandle, id: u32, factor: f64) {
    let _ = (app, id, factor); // silence unused on platforms with no setter (none today)
    let label = crate::nav::content_label(id);

    #[cfg(target_os = "linux")]
    crate::linux_layout::set_zoom_level_label(app, &label, factor);

    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let _ = content.with_webview(move |pw| crate::zoom_win::set(&pw, factor));
    }

    #[cfg(target_os = "macos")]
    if let Some(content) = app.get_webview(&label) {
        let _ = content.with_webview(move |pw| crate::zoom_mac::set(&pw, factor));
    }
    // Android applies in MainActivity (native WebView the Rust core can't reach);
    // the chrome routes zoom.set through the AegisAndroid bridge instead of this dispatch.
}

/// Handle `zoom.*` channels. Returns `None` if not a zoom channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let active = || {
        app.try_state::<crate::tabs::Tabs>()
            .map(|s| s.reg.lock().unwrap().active_id())
            .unwrap_or(1)
    };
    let id = payload
        .get("viewId")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .unwrap_or_else(active);
    match channel {
        "zoom.get" => Some(Ok(json!({ "viewId": id, "factor": factor_of(app, id) }))),
        "zoom.set" => {
            let f = payload.get("factor").and_then(Value::as_f64).unwrap_or(1.0);
            Some(Ok(put(app, id, f)))
        }
        "zoom.reset" => Some(Ok(put(app, id, 1.0))),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clamp_bounds_and_nonfinite() {
        assert_eq!(clamp(0.1), ZOOM_MIN);
        assert_eq!(clamp(9.0), ZOOM_MAX);
        assert_eq!(clamp(1.25), 1.25);
        assert_eq!(clamp(f64::NAN), 1.0);
        assert_eq!(clamp(f64::INFINITY), 1.0);
    }
}
