//! Data export/import (data.* IPC). Bundles every JSON store + settings + custom
//! filters into one file (in the Downloads dir) and restores from it. Import is
//! replace-mode (restore from backup); a file picker + merge-mode are follow-ups.
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::jsonstore;

const STORES: &[&str] = &["favorites", "saved", "history", "downloads"];

/// Target file for export/import: the path the user chose in the file dialog
/// (passed by the Tauri client), else the default backup in the Downloads dir.
fn export_file(app: &AppHandle, payload: &Value) -> PathBuf {
    if let Some(p) = payload.get("path").and_then(Value::as_str) {
        if !p.is_empty() {
            return PathBuf::from(p);
        }
    }
    app.path()
        .download_dir()
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
        .join("aegis-export.json")
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "data.export" => {
            let mut bundle = Map::new();
            bundle.insert("version".into(), json!(1));
            bundle.insert("settings".into(), crate::settings::all(app));
            for s in STORES {
                bundle.insert((*s).into(), json!(jsonstore::load(app, s)));
            }
            bundle.insert("customFilters".into(), json!(crate::customfilters::load(app)));

            let path = export_file(app, payload);
            let txt = serde_json::to_string_pretty(&Value::Object(bundle)).unwrap_or_default();
            match std::fs::write(&path, txt) {
                Ok(()) => Some(Ok(json!({ "ok": true, "path": path.to_string_lossy() }))),
                Err(e) => Some(Ok(json!({ "ok": false, "error": e.to_string() }))),
            }
        }

        "data.import" => {
            let path = export_file(app, payload);
            let Ok(txt) = std::fs::read_to_string(&path) else {
                return Some(Ok(json!({ "ok": false })));
            };
            let Ok(bundle) = serde_json::from_str::<Value>(&txt) else {
                return Some(Ok(json!({ "ok": false })));
            };
            let mut counts = Map::new();
            for s in STORES {
                if let Some(arr) = bundle.get(*s).and_then(Value::as_array) {
                    let _ = jsonstore::save(app, s, arr);
                    counts.insert((*s).into(), json!(arr.len()));
                }
            }
            if let Some(settings) = bundle.get("settings") {
                crate::settings::write(app, settings);
            }
            if let Some(cf) = bundle.get("customFilters").and_then(Value::as_str) {
                crate::customfilters::write(app, cf);
            }
            // Custom filters may have changed → re-install ad-blocking.
            #[cfg(target_os = "linux")]
            crate::install_adblock(app.clone());
            Some(Ok(json!({ "ok": true, "counts": Value::Object(counts) })))
        }

        _ => None,
    }
}
