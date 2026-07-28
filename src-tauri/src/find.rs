// Find-in-page dispatcher (PLACE 2). Routes `find.*` channels to per-platform
// native find implementations. Returns `None` for non-find channels.
// Real implementations: Task 6 (Linux), Task 7 (Windows), Task 8 (macOS).

use serde_json::Value;
use tauri::{AppHandle, Manager};

/// Returns true iff `channel` is one of the four find channels.
/// AppHandle-free so it can be unit-tested directly.
#[allow(dead_code)] // pub fn called from platform find modules — lib-crate analysis can't trace cross-platform dispatch
pub fn is_find_channel(channel: &str) -> bool {
    matches!(
        channel,
        "find.start" | "find.next" | "find.prev" | "find.close"
    )
}

/// Handle `find.*` channels. Returns `None` if `channel` is not a find channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    // Resolve the target tab id (default = active), mirroring the pattern in nav::dispatch
    // (nav.rs lines 468-472: try_state::<Tabs>().map(active_id).unwrap_or(1)).
    let id = payload
        .get("viewId")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .unwrap_or_else(|| {
            app.try_state::<crate::tabs::Tabs>()
                .map(|s| s.reg.lock().unwrap().active_id())
                .unwrap_or(1)
        });

    let res: Result<Value, String> = match channel {
        "find.start" => {
            let q = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let cs = payload
                .get("caseSensitive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            start(app, id, &q, cs);
            Ok(Value::Null)
        }
        "find.next" => {
            next(app, id);
            Ok(Value::Null)
        }
        "find.prev" => {
            prev(app, id);
            Ok(Value::Null)
        }
        "find.close" => {
            close(app, id);
            Ok(Value::Null)
        }
        _ => return None,
    };
    Some(res)
}

/// Emit a find.state snapshot to the chrome (dotted name; emit_event rewrites .→:).
/// Called by Tasks 6-8 platform modules once native find delivers match counts.
// Linux: find_linux (Task 6). Windows: find_win (Task 7). macOS: find_mac (Task 8).
// Android: find is handled natively in Kotlin (no Rust caller), so dead_code is
// expected there; suppress it only on android, not on the three desktop targets.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) fn emit_state(
    app: &AppHandle,
    view_id: u32,
    query: &str,
    match_count: u32,
    active: u32,
) {
    crate::emit_event(
        app,
        "find.state",
        serde_json::json!({
            "viewId": view_id,
            "query": query,
            "matchCount": match_count,
            "activeMatchIndex": active,
        }),
    );
}

// Platform dispatch: each is a thin cfg-routed call into the per-platform module.
fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    #[cfg(target_os = "linux")]
    crate::find_linux::start(app, id, query, case_sensitive);
    #[cfg(target_os = "windows")]
    crate::find_win::start(app, id, query, case_sensitive);
    #[cfg(target_os = "macos")]
    crate::find_mac::start(app, id, query, case_sensitive);
    // Suppress "unused" warnings on platforms where cfg blocks don't expand.
    let _ = (app, id, query, case_sensitive);
}

fn next(app: &AppHandle, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::next(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::next(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::next(app, id);
    let _ = (app, id);
}

fn prev(app: &AppHandle, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::prev(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::prev(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::prev(app, id);
    let _ = (app, id);
}

fn close(app: &AppHandle, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::close(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::close(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::close(app, id);
    let _ = (app, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn find_channels_recognized() {
        assert!(is_find_channel("find.start"));
        assert!(is_find_channel("find.next"));
        assert!(is_find_channel("find.prev"));
        assert!(is_find_channel("find.close"));
    }

    #[test]
    fn non_find_channel_rejected() {
        assert!(!is_find_channel("settings.get"));
        assert!(!is_find_channel("nav.navigate"));
        assert!(!is_find_channel("find."));
        assert!(!is_find_channel(""));
    }
}
