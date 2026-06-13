//! User custom filter rules (customFilters.* IPC). Persisted as text in the app
//! data dir and folded into the ad-block engine alongside EasyList (see
//! install_adblock), so the user's rules actually block.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("custom-filters.txt"))
}

/// The user's custom filter-list text (empty if none).
pub fn load(app: &AppHandle) -> String {
    path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .unwrap_or_default()
}

/// Overwrite the custom filters file (for data import).
pub fn write(app: &AppHandle, text: &str) {
    if let Some(p) = path(app) {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, text);
    }
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "customFilters.get" => Some(Ok(json!(load(app)))),
        "customFilters.set" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            if let Some(p) = path(app) {
                if let Some(d) = p.parent() {
                    let _ = std::fs::create_dir_all(d);
                }
                if let Err(e) = std::fs::write(&p, text) {
                    return Some(Err(format!("write custom filters: {e}")));
                }
            }
            // Re-apply ad-block so the new rules take effect.
            #[cfg(target_os = "linux")]
            crate::install_adblock(app.clone());
            Some(Ok(json!(text)))
        }
        _ => None,
    }
}
