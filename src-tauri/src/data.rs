//! Data export/import (data.* IPC). Bundles every JSON store + settings + custom
//! filters into one file (in the Downloads dir) and restores from it. Import takes
//! pasted JSON (the in-app field) or, if none, the Downloads backup — no native file
//! picker (it renders in the OS light theme). Import is replace-mode; merge-mode is a
//! follow-up.
use std::path::PathBuf;

use serde_json::{json, Map, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

// `allowlist` joins the exported stores in bundle v2 (it became a persisted store in
// F2a). All are exported with their sync envelopes (uuid/hlc/deleted) so a re-import
// preserves sync identity + delete state.
const STORES: &[&str] = &["favorites", "saved", "history", "downloads", "allowlist"];

/// Target file for export/import: the path the user chose in the file dialog
/// (passed by the Tauri client), else the default backup in the Downloads dir.
fn export_file<R: Runtime>(app: &AppHandle<R>, payload: &Value) -> PathBuf {
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

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "data.export" => {
            // History is batched in memory (see history.rs) — flush it so the export reads
            // the latest visits from disk, not a stale file.
            crate::history::flush(app);
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
            // History's file was just overwritten — drop its in-memory cache so the next
            // read reloads the imported rows (see history.rs "Write batching").
            crate::history::invalidate(app);
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    /// Seed one real row in every exported store + a settings change + a custom filter.
    /// Must use the correct call signatures for each module function.
    fn seed_all<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
        crate::places::dispatch(
            app,
            "favorites.add",
            &json!({ "input": { "name": "Fav", "url": "https://fav.test/" } }),
        )
        .unwrap()
        .unwrap();
        crate::places::dispatch(
            app,
            "saved.add",
            &json!({ "input": { "url": "https://saved.test/", "title": "Saved", "tags": ["t"] } }),
        )
        .unwrap()
        .unwrap();
        // history::record takes (app, url, title, is_private)
        crate::history::record(app, "https://hist.test/", "Hist", false);
        // downloads::on_requested takes (app, url, dest, private)
        let mut dest = std::path::PathBuf::new();
        crate::downloads::on_requested(app, "https://dl.test/file.bin", &mut dest, false);
        // an allowlist host
        crate::adblock::dispatch(
            app,
            "adblock.toggleAllowlist",
            &json!({ "host": "allow.test" }),
        )
        .unwrap()
        .unwrap();
        // a non-default setting — write takes &AppHandle<R>
        crate::settings::write(
            app,
            &json!({ "homeUrl": "https://home.seed/", "primaryColor": "#abcdef", "httpsOnly": false }),
        );
        // a custom filter
        crate::customfilters::write(app, "||seed-filter.example^\n");
    }

    /// Export writes a version-2 bundle file that contains every store key.
    #[test]
    fn export_writes_a_v2_bundle_with_every_store() {
        with_tmp_app(|app| {
            seed_all(app);
            let path = app.path().app_data_dir().unwrap().join("export.json");
            let res = dispatch(
                app,
                "data.export",
                &json!({ "path": path.to_string_lossy() }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(true));
            let txt = std::fs::read_to_string(&path).unwrap();
            let bundle: Value = serde_json::from_str(&txt).unwrap();
            assert_eq!(
                bundle.get("version").and_then(Value::as_i64),
                Some(2),
                "bundle version must be 2"
            );
            for key in [
                "favorites",
                "saved",
                "history",
                "downloads",
                "allowlist",
                "settings",
                "customFilters",
            ] {
                assert!(
                    bundle.get(key).is_some(),
                    "export bundle is missing `{key}`"
                );
            }
            // Sanity: the favorite we seeded is in the bundle.
            assert!(
                bundle
                    .get("favorites")
                    .and_then(Value::as_array)
                    .unwrap()
                    .iter()
                    .any(|it| it.get("url").and_then(Value::as_str) == Some("https://fav.test/")),
                "seeded favorite not found in exported bundle"
            );
        });
    }

    /// The capstone: seed EVERY store, export, then import into a FRESH empty app.
    /// Every store must survive — a dropped store fails here.
    #[test]
    fn export_then_import_into_a_fresh_app_restores_every_store() {
        // 1) Export from app A (seeded), capturing the bundle text.
        let bundle_text = with_tmp_app(|app| {
            seed_all(app);
            let path = app.path().app_data_dir().unwrap().join("export.json");
            dispatch(
                app,
                "data.export",
                &json!({ "path": path.to_string_lossy() }),
            )
            .unwrap()
            .unwrap();
            std::fs::read_to_string(&path).unwrap()
        });

        // 2) Import the bundle into a FRESH, empty app B and assert each store.
        //    Exporting and importing into the SAME app could pass even if import is a no-op
        //    (data is already there). A second empty app proves import actually writes.
        with_tmp_app(|app| {
            // Fresh app: every array store starts empty.
            assert!(
                jsonstore::live(jsonstore::load_synced(app, "favorites")).is_empty(),
                "fresh app must have empty favorites"
            );

            let res = dispatch(app, "data.import", &json!({ "text": bundle_text }))
                .unwrap()
                .unwrap();
            assert_eq!(
                res.get("ok").and_then(Value::as_bool),
                Some(true),
                "import must return ok:true"
            );

            // favorites
            let favs = crate::places::dispatch(app, "favorites.list", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                favs.as_array()
                    .unwrap()
                    .iter()
                    .any(|it| it.get("url").and_then(Value::as_str) == Some("https://fav.test/")),
                "favorites did not survive import"
            );

            // saved
            let saved = crate::places::dispatch(app, "saved.list", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                saved
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|it| it.get("url").and_then(Value::as_str) == Some("https://saved.test/")),
                "saved did not survive import"
            );

            // history
            let hist = crate::history::dispatch(app, "history.list", &json!({ "opts": {} }))
                .unwrap()
                .unwrap();
            assert!(
                hist.as_array()
                    .unwrap()
                    .iter()
                    .any(|it| it.get("url").and_then(Value::as_str) == Some("https://hist.test/")),
                "history did not survive import"
            );

            // downloads
            let dls = crate::downloads::dispatch(app, "downloads.list", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                dls.as_array()
                    .unwrap()
                    .iter()
                    .any(|it| it.get("url").and_then(Value::as_str)
                        == Some("https://dl.test/file.bin")),
                "downloads did not survive import"
            );

            // allowlist (re-seeded into the live engine cache by import's seed_from_disk)
            assert!(
                crate::adblock::load_allowlist_hosts(app).contains(&"allow.test".to_string()),
                "allowlist did not survive import"
            );

            // settings
            let s = crate::settings::all(app);
            assert_eq!(
                s.get("homeUrl").and_then(Value::as_str),
                Some("https://home.seed/"),
                "settings.homeUrl did not survive import"
            );
            assert_eq!(
                s.get("httpsOnly").and_then(Value::as_bool),
                Some(false),
                "settings.httpsOnly did not survive import"
            );

            // custom filters
            assert!(
                crate::customfilters::load(app).contains("||seed-filter.example^"),
                "custom filters did not survive import"
            );
        });
    }

    /// A completely invalid JSON payload must not panic and must return ok:false.
    #[test]
    fn import_of_garbage_text_returns_not_ok() {
        with_tmp_app(|app| {
            let res = dispatch(app, "data.import", &json!({ "text": "{ not json" }))
                .unwrap()
                .unwrap();
            assert_eq!(
                res.get("ok").and_then(Value::as_bool),
                Some(false),
                "malformed JSON must return ok:false, not panic"
            );
        });
    }

    /// A partial bundle (only some stores present) must import whatever keys exist and
    /// return ok:true — partial imports are valid (forward-compat / hand-edited bundles).
    #[test]
    fn import_of_partial_bundle_imports_present_keys_and_returns_ok() {
        with_tmp_app(|app| {
            // Only favorites in the bundle; other stores absent.
            let partial = json!({
                "version": 2,
                "favorites": [{ "id": 1, "url": "https://partial.test/", "name": "Partial" }],
                "settings": { "homeUrl": "https://partial.test/" }
            });
            let res = dispatch(app, "data.import", &json!({ "text": partial.to_string() }))
                .unwrap()
                .unwrap();
            assert_eq!(
                res.get("ok").and_then(Value::as_bool),
                Some(true),
                "partial bundle must return ok:true"
            );
            // The present store should be written.
            let favs = crate::places::dispatch(app, "favorites.list", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                favs.as_array().unwrap().iter().any(
                    |it| it.get("url").and_then(Value::as_str) == Some("https://partial.test/")
                ),
                "partial-bundle favorite was not imported"
            );
            // Absent stores should be untouched (empty).
            let hist = crate::history::dispatch(app, "history.list", &json!({ "opts": {} }))
                .unwrap()
                .unwrap();
            assert!(
                hist.as_array().unwrap().is_empty(),
                "absent store (history) must stay empty after partial import"
            );
        });
    }
}
