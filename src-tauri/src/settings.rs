//! Persistent settings (settings.* IPC). Stored as JSON in the app data dir —
//! a single config object doesn't need a DB. Lists (favorites/history/…) get a
//! real store in Phase 2; settings staying JSON is fine and keeps this contained.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("settings.json"))
}

/// Defaults matching `Settings` in shared/types.ts.
fn defaults() -> Value {
    json!({
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
        "httpsOnly": true,
        "tabIdleTimeout": 30
    })
}

/// The full settings object (for data export).
pub fn all(app: &AppHandle) -> Value {
    load(app)
}

/// Overwrite the settings file (for data import).
pub fn write(app: &AppHandle, value: &Value) {
    if let Some(p) = store_path(app) {
        if let Some(d) = p.parent() {
            let _ = std::fs::create_dir_all(d);
        }
        let _ = std::fs::write(p, serde_json::to_string_pretty(value).unwrap_or_default());
    }
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

/// Minutes a background tab may idle before discard (0 disables). Default 30.
pub fn tab_idle_timeout_min(app: &AppHandle) -> u64 {
    load(app).get("tabIdleTimeout").and_then(Value::as_u64).unwrap_or(30)
}

/// The configured home page as a URL (default about:blank). Blank or unparseable
/// values fall back to about:blank so Home/startup never fail to navigate.
pub fn home_url(app: &AppHandle) -> Url {
    let s = load(app);
    let raw = s
        .get("homeUrl")
        .and_then(Value::as_str)
        .unwrap_or("about:blank")
        .trim();
    let target = if raw.is_empty() { "about:blank" } else { raw };
    Url::parse(target).unwrap_or_else(|_| Url::parse("about:blank").expect("about:blank is valid"))
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
