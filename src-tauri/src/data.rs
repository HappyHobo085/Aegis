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
const STORES: &[&str] = &[
    "favorites",
    "saved",
    "history",
    "downloads",
    "allowlist",
    // `subs` (filter subscriptions) and `fp-allowlist` (per-site farbling opt-outs) are
    // ordinary `jsonstore` arrays of envelope-stamped objects, so they ride the same
    // export/import path as everything above. They were missing from this list, which made
    // `data.export` silently drop both: a user who exported a backup and restored it on a
    // new machine came back with no filter subscriptions and no fingerprinting opt-outs,
    // and the import reported `ok: true` with plausible-looking counts. Neither is in
    // `sync_stores::SYNCABLE` (so neither syncs between devices — see that module's docs),
    // which is exactly why a backup was the only way to move them and why losing them
    // silently was the worst possible outcome.
    "subs",
    "fp-allowlist",
];

/// Target file for export/import — always the fixed default backup location.
///
/// The renderer deliberately gets no say in where this lands. There is no native save
/// dialog (it renders in the OS's light theme and clashes with the dark UI), so the
/// renderer never passes a path anyway — `aegis.data.export()` sends `{}` and
/// `aegis.data.import()` sends `{ mode, text? }`.
///
/// An earlier version *did* honour a `path` from the IPC payload and wrote the bundle
/// wherever it was told. That let a compromised chrome renderer overwrite any file the
/// user can write — `~/.bashrc`, `~/.ssh/authorized_keys`, or the app's own `vault.json`
/// — and, because the export temp file is created 0644 and then renamed over the target,
/// also downgrade the permissions of a file that had been 0600. `data.import` was the
/// read-side mirror (an existence oracle over arbitrary paths). Both halves are gone: the
/// renderer has no path input, so this is the only place an export can land.
///
/// The fallback is the app data dir rather than `/tmp` — a world-writable shared
/// directory is the wrong home for a bundle that may contain vault-adjacent metadata,
/// and a per-app dir keeps concurrent test runs from colliding on one filename.
fn export_file<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
    app.path()
        .download_dir()
        .or_else(|_| app.path().app_data_dir())
        .unwrap_or_else(|_| std::env::temp_dir())
        .join("aegis-export.json")
}

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "data.export" => {
            // History + downloads are batched in memory — flush them so the export reads the
            // latest rows from disk, not a stale file.
            crate::history::flush(app);
            crate::downloads::flush(app);
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

            let path = export_file(app);
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
                    let path = export_file(app);
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
            // History's + downloads' files were just overwritten — drop their in-memory caches
            // so the next read reloads the imported rows (see history.rs "Write batching").
            crate::history::invalidate(app);
            crate::downloads::invalidate(app);
            let mut refused_settings: Vec<String> = Vec::new();
            if let Some(settings) = bundle.get("settings") {
                // Merges over the current values (not a wholesale replace) and validates each
                // key through the same allowlist `settings.set` uses — see
                // `settings::apply_imported` for why both matter.
                refused_settings = crate::settings::apply_imported(app, settings);
            }
            if let Some(cf) = bundle.get("customFilters").and_then(Value::as_str) {
                crate::customfilters::write(app, cf); // stamps the customFilters sync record
            }
            // Re-seed the in-memory allowlist + engine from the imported allowlist store.
            crate::adblock::seed_from_disk(app);
            // Custom filters / subs may have changed → re-apply ad-block everywhere.
            crate::adblock_refresh::refresh(app);
            Some(Ok(json!({
                "ok": true,
                "counts": Value::Object(counts),
                // Non-empty only when a setting was refused. Surfaced rather than swallowed so
                // a poisoned or misspelled key in a bundle is visible to the user instead of
                // the import looking complete when it wasn't.
                "refusedSettings": refused_settings,
            })))
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
        // A filter subscription and a farbling opt-out. These two stores were absent from
        // `STORES` for the life of the export feature, so they are seeded here specifically:
        // both are ordinary envelope-stamped object arrays, so both ride the same path, and
        // the assertions below are what stop them being quietly dropped again.
        let mut sub =
            json!({ "listId": "seed-list", "url": "https://lists.test/a.txt", "enabled": true });
        jsonstore::stamp_new(&mut sub, app);
        jsonstore::save(app, "subs", &[sub]).unwrap();
        jsonstore::add_host(app, "fp-allowlist", "nofarble.test").unwrap();
    }

    /// Export writes a version-2 bundle file that contains every store key.
    #[test]
    fn export_writes_a_v2_bundle_with_every_store() {
        with_tmp_app(|app| {
            seed_all(app);
            // No path is accepted from the payload any more, so read the target back
            // off the response — which is also what the Data tab shows the user.
            let res = dispatch(app, "data.export", &json!({})).unwrap().unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(true));
            let path = std::path::PathBuf::from(res.get("path").unwrap().as_str().unwrap());
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
                "subs",
                "fp-allowlist",
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
            let res = dispatch(app, "data.export", &json!({})).unwrap().unwrap();
            let path = std::path::PathBuf::from(res.get("path").unwrap().as_str().unwrap());
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

            // Filter subscriptions. Neither `subs` nor `fp-allowlist` syncs between devices
            // (they are not in `sync_stores::SYNCABLE`), so a backup was the only way to move
            // them to a new machine — which is exactly why the two were missed.
            assert!(
                jsonstore::load(app, "subs")
                    .iter()
                    .any(|it| it.get("listId").and_then(Value::as_str) == Some("seed-list")),
                "filter subscriptions did not survive import"
            );
            assert!(
                jsonstore::live_hosts(app, "fp-allowlist").contains(&"nofarble.test".to_string()),
                "fp-allowlist did not survive import"
            );
        });
    }

    /// The export target must NOT be redirectable by the payload. A `path` in the payload
    /// used to be honoured verbatim, which let a compromised chrome renderer overwrite any
    /// user-writable file and downgrade a 0600 file's mode. The renderer has no path input
    /// by design, so the core must ignore one even if it is sent.
    #[test]
    fn export_ignores_a_path_in_the_payload() {
        with_tmp_app(|app| {
            seed_all(app);
            let decoy = app.path().app_data_dir().unwrap().join("decoy.json");
            let res = dispatch(
                app,
                "data.export",
                &json!({ "path": decoy.to_string_lossy() }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(res.get("ok").and_then(Value::as_bool), Some(true));
            let chosen = std::path::PathBuf::from(res.get("path").unwrap().as_str().unwrap());
            assert_ne!(
                chosen, decoy,
                "export must not write to a renderer-supplied path"
            );
            assert!(!decoy.exists(), "the decoy path must never be created");
            assert!(chosen.exists(), "the fixed export target must be written");
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

    /// A bundle must not be able to set a `file:` `homeUrl` — the setting that turns a
    /// remote write into a local file read. `home_url()` only checks that the string parses
    /// as a URL, so without the allowlist here a pasted bundle (or a peer record, same
    /// validator) would make the content webview load `file:///…` on every launch.
    #[test]
    fn import_refuses_a_file_url_home_and_keeps_the_local_one() {
        with_tmp_app(|app| {
            // Seeded with `settings::write` rather than the `settings.set` channel:
            // `dispatch` takes a concrete (non-generic) `&AppHandle` and so cannot be driven
            // from a `MockRuntime` test.
            crate::settings::write(app, &json!({ "homeUrl": "https://keepme.test/" }));
            let bundle = json!({ "settings": { "homeUrl": "file:///etc/passwd" } });
            let res = dispatch(app, "data.import", &json!({ "text": bundle.to_string() }))
                .unwrap()
                .unwrap();
            assert_eq!(
                res.get("ok").and_then(Value::as_bool),
                Some(true),
                "a refused key must not fail the whole import"
            );
            assert_eq!(
                res.get("refusedSettings").and_then(Value::as_array),
                Some(&vec![json!("homeUrl")]),
                "the refused key must be reported, not silently dropped"
            );
            // `settings::home_url` takes a concrete `&AppHandle`, so read the persisted value
            // through the generic `all()` instead — `home_url` only parses whatever is here.
            assert_eq!(
                crate::settings::all(app)
                    .get("homeUrl")
                    .and_then(Value::as_str),
                Some("https://keepme.test/"),
                "a file: homeUrl must never reach the flat settings file"
            );
        });
    }

    /// Settings must MERGE, not replace. The stores in a bundle are imported key-by-key
    /// ("partial bundles are valid"), so a bundle carrying one key used to reset every other
    /// setting to its default — silently turning off httpsOnly, the ad-block allowlist sync,
    /// the sync server URL and the vault, with no error anywhere.
    #[test]
    fn import_merges_settings_instead_of_resetting_unspecified_ones() {
        with_tmp_app(|app| {
            crate::settings::write(
                app,
                &json!({
                    "httpsOnly": false,
                    "webrtcPolicy": "disable",
                    "downloadDir": "/tmp/aegis-keep",
                }),
            );
            // A bundle that mentions exactly one setting.
            let bundle = json!({ "settings": { "homeUrl": "https://imported.test/" } });
            dispatch(app, "data.import", &json!({ "text": bundle.to_string() }))
                .unwrap()
                .unwrap();
            let s = crate::settings::all(app);
            assert_eq!(
                s.get("homeUrl").and_then(Value::as_str),
                Some("https://imported.test/"),
                "the imported key must be applied"
            );
            assert_eq!(
                s.get("httpsOnly").and_then(Value::as_bool),
                Some(false),
                "a setting absent from the bundle must survive the import"
            );
            assert_eq!(
                s.get("webrtcPolicy").and_then(Value::as_str),
                Some("disable"),
                "a setting absent from the bundle must survive the import"
            );
            assert_eq!(
                s.get("downloadDir").and_then(Value::as_str),
                Some("/tmp/aegis-keep"),
                "a setting absent from the bundle must survive the import"
            );
        });
    }

    /// An unknown key must be refused, not written. The allowlist is an ALLOW list on
    /// purpose: a new setting is not renderer- or bundle-writable until someone has decided
    /// what a valid value for it is.
    #[test]
    fn import_refuses_an_unknown_setting_key() {
        with_tmp_app(|app| {
            let bundle = json!({ "settings": { "totallyNotASetting": "x" } });
            let res = dispatch(app, "data.import", &json!({ "text": bundle.to_string() }))
                .unwrap()
                .unwrap();
            assert_eq!(
                res.get("refusedSettings").and_then(Value::as_array),
                Some(&vec![json!("totallyNotASetting")])
            );
            assert!(
                crate::settings::all(app)
                    .get("totallyNotASetting")
                    .is_none(),
                "an unknown key must not land in the settings file"
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
