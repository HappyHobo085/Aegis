//! Data export/import (data.* IPC). Bundles every JSON store + settings + custom
//! filters into one file (in the Downloads dir) and restores from it. Import takes
//! pasted JSON (the in-app field) or, if none, the Downloads backup — no native file
//! picker (it renders in the OS light theme). Import is replace-mode; merge-mode is a
//! follow-up.
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager};

use crate::jsonstore;

// `allowlist` joins the exported stores in bundle v2 (it became a persisted store in
// F2a). All are exported with their sync envelopes (uuid/hlc/deleted) so a re-import
// preserves sync identity + delete state.
const STORES: &[&str] = &["favorites", "saved", "history", "downloads", "allowlist"];

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
            bundle.insert("version".into(), json!(2));
            bundle.insert("settings".into(), crate::settings::all(app));
            for s in STORES {
                // Full arrays incl. tombstones + sync envelopes (load_synced migrates any
                // not-yet-migrated rows first).
                bundle.insert((*s).into(), json!(jsonstore::load_synced(app, s)));
            }
            bundle.insert(
                "customFilters".into(),
                json!(crate::customfilters::load(app)),
            );

            let path = export_file(app, payload);
            let txt = serde_json::to_string_pretty(&Value::Object(bundle)).unwrap_or_default();
            // Durable write, but no `.bak` sidecar next to the user's export file.
            match jsonstore::write_atomic_no_backup(&path, txt.as_bytes()) {
                Ok(()) => Some(Ok(json!({ "ok": true, "path": path.to_string_lossy() }))),
                Err(e) => Some(Ok(json!({ "ok": false, "error": e.to_string() }))),
            }
        }

        "data.import" => {
            // Source: pasted JSON text from the in-app field, else the backup file
            // (the path the client passed, or the default in Downloads). No native
            // file picker — that renders in the OS's light theme, clashing with the UI.
            let bundle: Value = match payload
                .get("text")
                .and_then(Value::as_str)
                .filter(|s| !s.trim().is_empty())
            {
                Some(t) => match serde_json::from_str(t) {
                    Ok(v) => v,
                    Err(_) => return Some(Ok(json!({ "ok": false }))),
                },
                None => {
                    let path = export_file(app, payload);
                    let Ok(txt) = std::fs::read_to_string(&path) else {
                        return Some(Ok(json!({ "ok": false })));
                    };
                    match serde_json::from_str::<Value>(&txt) {
                        Ok(v) => v,
                        Err(_) => return Some(Ok(json!({ "ok": false }))),
                    }
                }
            };
            let mut counts = Map::new();
            let node = crate::sync_identity::node_id(app);
            for s in STORES {
                if let Some(arr) = bundle.get(*s).and_then(Value::as_array) {
                    // Migrate envelope-less rows (a v1 bundle, or hand-edited) so every
                    // imported record is syncable; rows that already have a uuid keep it.
                    let mut migrated = arr.clone();
                    for it in migrated.iter_mut() {
                        jsonstore::ensure_sync_meta(it, &node, jsonstore::now_ms());
                    }
                    let _ = jsonstore::save(app, s, &migrated);
                    counts.insert((*s).into(), json!(arr.len()));
                }
            }
            if let Some(settings) = bundle.get("settings") {
                crate::settings::write(app, settings);
                // Rebuild the per-key sync projection from the imported flat settings.
                crate::settings::rebuild_projection_from_current(app);
            }
            if let Some(cf) = bundle.get("customFilters").and_then(Value::as_str) {
                crate::customfilters::write(app, cf); // stamps the customFilters sync record
            }
            // Re-seed the in-memory allowlist + engine from the imported allowlist store.
            crate::adblock::seed_from_disk(app);
            // Custom filters / subs may have changed → re-apply ad-block everywhere.
            crate::adblock_refresh::refresh(app);
            Some(Ok(json!({ "ok": true, "counts": Value::Object(counts) })))
        }

        _ => None,
    }
}
