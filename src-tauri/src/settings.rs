//! Persistent settings (settings.* IPC). Stored as JSON in the app data dir —
//! a single config object doesn't need a DB. Lists (favorites/history/…) get a
//! real store in Phase 2; settings staying JSON is fine and keeps this contained.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

/// Defaults matching `Settings` in shared/types.ts.
fn defaults() -> Value {
    json!({
        "siteName": "Aegis",
        "homeUrl": "about:blank",
        "primaryColor": "#3b82f6",
        "defaultSearchTemplate": "https://duckduckgo.com/?q=%s",
        "searchEngines": [
            { "id": "ddg", "name": "DuckDuckGo", "template": "https://duckduckgo.com/?q=%s" },
            { "id": "google", "name": "Google", "template": "https://www.google.com/search?q=%s" },
            { "id": "bing", "name": "Bing", "template": "https://www.bing.com/search?q=%s" }
        ],
        "hideChromeByDefault": false,
        "downloadDir": "",
        "httpsOnly": true
    })
}

/// Configured download directory ("" = use the OS Downloads dir).
pub fn download_dir(app: &AppHandle) -> String {
    load(app)
        .get("downloadDir")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Whether HTTPS-Only upgrading is on (default true).
pub fn https_only(app: &AppHandle) -> bool {
    load(app)
        .get("httpsOnly")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Defaults overlaid with any persisted values.
fn load(app: &AppHandle) -> Value {
    let mut s = defaults();
    if let Some(p) = store_path(app) {
        if let Ok(txt) = std::fs::read_to_string(&p) {
            if let Ok(saved) = serde_json::from_str::<Value>(&txt) {
                merge(&mut s, &saved);
            }
        }
    }
    s
}

/// Shallow-merge `over`'s keys into `base` (both objects).
fn merge(base: &mut Value, over: &Value) {
    if let (Some(b), Some(o)) = (base.as_object_mut(), over.as_object()) {
        for (k, v) in o {
            b.insert(k.clone(), v.clone());
        }
    }
}

/// Handle `settings.*` channels. Returns `None` if not a settings channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "settings.get" => Some(Ok(load(app))),
        "settings.set" => {
            let mut current = load(app);
            if let Some(partial) = payload.get("partial") {
                merge(&mut current, partial);
            }
            if let Some(p) = store_path(app) {
                if let Some(dir) = p.parent() {
                    let _ = std::fs::create_dir_all(dir);
                }
                match serde_json::to_string_pretty(&current) {
                    Ok(txt) => {
                        if let Err(e) = std::fs::write(&p, txt) {
                            return Some(Err(format!("write settings: {e}")));
                        }
                    }
                    Err(e) => return Some(Err(e.to_string())),
                }
            }
            Some(Ok(current))
        }
        _ => None,
    }
}
