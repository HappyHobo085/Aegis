//! Tiny JSON-array store in the app data dir, backing the data repos (favorites,
//! saved, …). For personal-use data volumes a JSON file per collection is simpler
//! than a DB and good enough; each repo loads, mutates, and saves the whole array.
use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::Value;
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle, name: &str) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(format!("{name}.json")))
}

/// Load a collection (empty if missing/corrupt).
pub fn load(app: &AppHandle, name: &str) -> Vec<Value> {
    path(app, name)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
}

/// Persist a collection.
pub fn save(app: &AppHandle, name: &str, items: &[Value]) -> Result<(), String> {
    let Some(p) = path(app, name) else {
        return Err("no app data dir".into());
    };
    if let Some(d) = p.parent() {
        let _ = std::fs::create_dir_all(d);
    }
    let txt = serde_json::to_string_pretty(items).map_err(|e| e.to_string())?;
    std::fs::write(&p, txt).map_err(|e| e.to_string())
}

/// Next monotonic id = max existing id + 1.
pub fn next_id(items: &[Value]) -> i64 {
    items
        .iter()
        .filter_map(|i| i.get("id").and_then(Value::as_i64))
        .max()
        .unwrap_or(0)
        + 1
}

/// Current time, epoch milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}
