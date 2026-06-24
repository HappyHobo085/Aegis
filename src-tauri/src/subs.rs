//! Filter-list subscriptions (subs.* IPC). Each subscription is a remote filter
//! list (EasyPrivacy, regional/language lists, …) fetched over HTTPS, cached to
//! disk, and folded into the ad-block engine alongside EasyList + custom rules.
//!
//! Fetching runs on a background thread so the IPC call returns immediately (no
//! UI stall): `subs.add` inserts the row optimistically, then the fetch fills the
//! cache, stamps `lastUpdated`/`hash`, and re-installs the engine. `enabled_text`
//! concatenates the cached text of every enabled subscription for install_adblock.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

/// Stable list id from a URL: the last path segment without a `.txt` suffix
/// (matches the Electron app's `listIdFromUrl`).
fn list_id_from_url(url: &str) -> String {
    let last = url.rsplit('/').find(|s| !s.is_empty()).unwrap_or(url);
    last.strip_suffix(".txt").unwrap_or(last).to_string()
}

fn subs_dir<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/aegis"))
        .join("subs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn cache_path<R: Runtime>(app: &AppHandle<R>, list_id: &str) -> std::path::PathBuf {
    subs_dir(app).join(format!("{list_id}.txt"))
}

fn hash_text(text: &str) -> String {
    use std::hash::{Hash, Hasher};
    let mut h = std::collections::hash_map::DefaultHasher::new();
    text.hash(&mut h);
    format!("{:x}", h.finish())
}

/// Blocking HTTPS GET on a dedicated thread (so an ambient async runtime can't
/// make `reqwest::blocking` panic). 2xx → body text.
fn fetch_text(url: String) -> Result<String, String> {
    std::thread::spawn(move || -> Result<String, String> {
        let client = reqwest::blocking::Client::builder()
            .timeout(std::time::Duration::from_secs(25))
            .user_agent("Aegis/0.1 (filter-list updater)")
            .build()
            .map_err(|e| e.to_string())?;
        let resp = client.get(&url).send().map_err(|e| e.to_string())?;
        if !resp.status().is_success() {
            return Err(format!("HTTP {}", resp.status()));
        }
        resp.text().map_err(|e| e.to_string())
    })
    .join()
    .map_err(|e| {
        let msg = e
            .downcast_ref::<&str>()
            .map(|s| s.to_string())
            .or_else(|| e.downcast_ref::<String>().cloned())
            .unwrap_or_else(|| "unknown panic".to_string());
        format!("fetch thread panicked: {msg}")
    })?
}

/// Concatenated text of every ENABLED subscription, read from cache. Folded into
/// the engine by `install_adblock`. Subscriptions with no cache yet contribute
/// nothing (so a still-fetching or failed list is simply absent).
pub fn enabled_text<R: Runtime>(app: &AppHandle<R>) -> String {
    let mut out = String::new();
    for row in jsonstore::load(app, "subs") {
        if jsonstore::is_deleted(&row) {
            continue; // tombstoned subscription contributes nothing
        }
        if !row.get("enabled").and_then(Value::as_bool).unwrap_or(false) {
            continue;
        }
        if let Some(id) = row.get("listId").and_then(Value::as_str) {
            if let Ok(text) = std::fs::read_to_string(cache_path(app, id)) {
                out.push('\n');
                out.push_str(&text);
            }
        }
    }
    out
}

/// Rebuild + reapply ad-block after a subscription change, on every platform (Linux
/// WebKit filters + the engine FilterSet reload via adblock_refresh).
fn reinstall_adblock<R: Runtime>(app: &AppHandle<R>) {
    crate::adblock_refresh::refresh(app);
}

/// Fetch a subscription in the background, cache it, stamp `lastUpdated`/`hash` on
/// its row, re-install the engine, and notify the renderer. On failure the row
/// keeps `lastUpdated: null` (shows as "never updated") and contributes no rules.
fn fetch_in_background<R: Runtime>(app: AppHandle<R>, list_id: String, url: String) {
    std::thread::spawn(move || match fetch_text(url) {
        Ok(text) => {
            // No .bak: the cache is regenerable from the network, so a recovery copy
            // would just clutter the cache dir (and orphan on subs.remove).
            let _ = jsonstore::write_atomic_no_backup(&cache_path(&app, &list_id), text.as_bytes());
            let hash = hash_text(&text);
            let mut items = jsonstore::load_synced(&app, "subs");
            for it in items.iter_mut() {
                if it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()) {
                    it["lastUpdated"] = json!(jsonstore::now_ms());
                    it["hash"] = json!(hash);
                    jsonstore::touch(it, &app);
                }
            }
            let _ = jsonstore::save(&app, "subs", &items);
            reinstall_adblock(&app);
            crate::emit_event(&app, "subs.changed", Value::Null);
        }
        Err(e) => eprintln!("[aegis-subs] fetch {list_id} failed: {e}"),
    });
}

fn url_of(items: &[Value], list_id: &str) -> Option<String> {
    items
        .iter()
        .find(|it| it.get("listId").and_then(Value::as_str) == Some(list_id))
        .and_then(|it| it.get("url").and_then(Value::as_str))
        .map(str::to_string)
}

/// Re-fetch every ENABLED subscription, refresh its cache + stamp, re-install the
/// engine once, and return a `ListUpdateResult` (per-source ok/error + timestamp).
/// Fetches run concurrently so wall-time is the slowest single list. Backs
/// `lists.updateNow`.
pub fn update_all<R: Runtime>(app: &AppHandle<R>) -> Value {
    let now = jsonstore::now_ms();
    let enabled: Vec<(String, String)> = jsonstore::load(app, "subs")
        .iter()
        .filter(|it| !jsonstore::is_deleted(it))
        .filter(|it| it.get("enabled").and_then(Value::as_bool).unwrap_or(false))
        .filter_map(|it| {
            Some((
                it.get("listId").and_then(Value::as_str)?.to_string(),
                it.get("url").and_then(Value::as_str)?.to_string(),
            ))
        })
        .collect();

    // Fetch all enabled lists concurrently; cache each success, return its hash.
    let handles: Vec<_> = enabled
        .into_iter()
        .map(|(id, url)| {
            let app = app.clone();
            std::thread::spawn(move || {
                let res = fetch_text(url).map(|text| {
                    // Regenerable cache → no .bak (see fetch_in_background).
                    let _ =
                        jsonstore::write_atomic_no_backup(&cache_path(&app, &id), text.as_bytes());
                    hash_text(&text)
                });
                (id, res)
            })
        })
        .collect();

    let mut per_source = Vec::new();
    let mut hashes: std::collections::HashMap<String, String> = std::collections::HashMap::new();
    for h in handles {
        if let Ok((id, res)) = h.join() {
            match res {
                Ok(hash) => {
                    hashes.insert(id.clone(), hash);
                    per_source.push(json!({ "listId": id, "ok": true }));
                }
                Err(e) => per_source.push(json!({ "listId": id, "ok": false, "error": e })),
            }
        }
    }

    // Stamp the rows we refreshed, then rebuild the engine if anything changed.
    let mut items = jsonstore::load_synced(app, "subs");
    for it in items.iter_mut() {
        let id = it.get("listId").and_then(Value::as_str).map(str::to_string);
        if let Some(hash) = id.and_then(|id| hashes.get(&id)) {
            it["lastUpdated"] = json!(now);
            it["hash"] = json!(hash);
            jsonstore::touch(it, app);
        }
    }
    let _ = jsonstore::save(app, "subs", &items);
    if !hashes.is_empty() {
        reinstall_adblock(app);
        crate::emit_event(app, "subs.changed", Value::Null);
    }
    json!({ "perSource": per_source, "lastUpdated": now })
}

/// Handle `subs.*`. Returns `None` if not a subs channel.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "subs.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app, "subs"
        ))))),

        "subs.add" => {
            let url = payload
                .get("url")
                .and_then(Value::as_str)
                .unwrap_or("")
                .trim()
                .to_string();
            if !(url.starts_with("https://") || url.starts_with("http://")) {
                return Some(Err("subscription url must be http(s)".into()));
            }
            let list_id = list_id_from_url(&url);
            let mut items = jsonstore::load_synced(app, "subs");
            // Upsert by listId. Revive an existing row IN PLACE (preserving its uuid) —
            // including a tombstoned one — instead of dropping + re-creating, so a
            // re-added subscription keeps its sync identity. lastUpdated=null until the
            // background fetch completes (so the IPC returns without a network wait).
            match items
                .iter_mut()
                .find(|it| it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()))
            {
                Some(it) => {
                    if let Some(o) = it.as_object_mut() {
                        o.insert("url".into(), json!(url));
                        o.insert("enabled".into(), json!(true));
                        o.insert("lastUpdated".into(), Value::Null);
                        o.insert("deleted".into(), json!(false)); // revive if tombstoned
                    }
                    jsonstore::touch(it, app);
                }
                None => {
                    let mut item = json!({
                        "listId": list_id, "url": url, "enabled": true,
                        "lastUpdated": Value::Null, "etag": Value::Null, "hash": Value::Null,
                    });
                    jsonstore::stamp_new(&mut item, app);
                    items.push(item);
                }
            }
            let _ = jsonstore::save(app, "subs", &items);
            fetch_in_background(app.clone(), list_id, url);
            Some(Ok(json!(jsonstore::live(items))))
        }

        "subs.setEnabled" => {
            let list_id = payload
                .get("listId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let mut items = jsonstore::load_synced(app, "subs");
            let mut need_fetch = false;
            for it in items.iter_mut() {
                if !jsonstore::is_deleted(it)
                    && it.get("listId").and_then(Value::as_str) == Some(list_id.as_str())
                {
                    it["enabled"] = json!(enabled);
                    // Enabling a list we've never fetched → fetch it now.
                    need_fetch =
                        enabled && it.get("lastUpdated").map(Value::is_null).unwrap_or(true);
                    jsonstore::touch(it, app);
                }
            }
            let _ = jsonstore::save(app, "subs", &items);
            match (need_fetch, url_of(&items, &list_id)) {
                (true, Some(url)) => fetch_in_background(app.clone(), list_id, url),
                _ => reinstall_adblock(app),
            }
            Some(Ok(json!(jsonstore::live(items))))
        }

        "subs.remove" => {
            let list_id = payload
                .get("listId")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let mut items = jsonstore::load_synced(app, "subs");
            jsonstore::tombstone(
                &mut items,
                |it| it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()),
                app,
            );
            let _ = jsonstore::save(app, "subs", &items);
            let _ = std::fs::remove_file(cache_path(app, &list_id)); // cache is regenerable
            reinstall_adblock(app);
            Some(Ok(json!(jsonstore::live(items))))
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn list_id_from_url_strips_txt_and_takes_last_segment() {
        assert_eq!(
            list_id_from_url("https://x.test/lists/easyprivacy.txt"),
            "easyprivacy"
        );
        assert_eq!(list_id_from_url("https://x.test/regional/de"), "de");
        assert_eq!(list_id_from_url("https://x.test/trailing/"), "trailing");
        assert_eq!(list_id_from_url("noslash"), "noslash");
    }

    #[test]
    fn hash_text_is_stable_and_distinguishes() {
        assert_eq!(hash_text("a"), hash_text("a"));
        assert_ne!(hash_text("a"), hash_text("b"));
    }

    #[test]
    fn url_of_finds_the_row_by_list_id() {
        let items = vec![
            json!({ "listId": "ep", "url": "https://x/ep.txt" }),
            json!({ "listId": "de", "url": "https://x/de.txt" }),
        ];
        assert_eq!(url_of(&items, "de").as_deref(), Some("https://x/de.txt"));
        assert_eq!(url_of(&items, "missing"), None);
    }

    #[test]
    fn add_rejects_non_http_scheme() {
        with_tmp_app(|app| {
            let r = dispatch(app, "subs.add", &json!({ "url": "ftp://x/list.txt" }));
            assert!(
                matches!(r, Some(Err(_))),
                "non-http(s) url must be rejected"
            );
        });
    }

    #[test]
    fn add_inserts_optimistic_row_then_list_and_remove() {
        with_tmp_app(|app| {
            let after = dispatch(
                app,
                "subs.add",
                &json!({ "url": "https://x.test/easyprivacy.txt" }),
            )
            .unwrap()
            .unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 1);
            assert_eq!(
                rows[0].get("listId").and_then(Value::as_str),
                Some("easyprivacy")
            );
            assert_eq!(rows[0].get("enabled").and_then(Value::as_bool), Some(true));
            assert!(
                rows[0]
                    .get("lastUpdated")
                    .map(Value::is_null)
                    .unwrap_or(false),
                "fetch is async → null until done"
            );
            // list reflects it.
            let listed = dispatch(app, "subs.list", &json!({})).unwrap().unwrap();
            assert_eq!(listed.as_array().unwrap().len(), 1);
            // remove tombstones it (live list empties).
            let removed = dispatch(app, "subs.remove", &json!({ "listId": "easyprivacy" }))
                .unwrap()
                .unwrap();
            assert!(removed.as_array().unwrap().is_empty());
        });
    }

    #[test]
    fn set_enabled_flips_persisted_flag() {
        with_tmp_app(|app| {
            let _ = dispatch(
                app,
                "subs.add",
                &json!({ "url": "https://x.test/easyprivacy.txt" }),
            )
            .unwrap();
            let after = dispatch(
                app,
                "subs.setEnabled",
                &json!({ "listId": "easyprivacy", "enabled": false }),
            )
            .unwrap()
            .unwrap();
            assert_eq!(
                after.as_array().unwrap()[0]
                    .get("enabled")
                    .and_then(Value::as_bool),
                Some(false)
            );
        });
    }

    #[test]
    fn enabled_text_concatenates_cached_enabled_lists_only() {
        with_tmp_app(|app| {
            // Seed two rows: one enabled with a cache file, one disabled.
            let rows = vec![
                json!({ "listId": "ep", "url": "https://x/ep.txt", "enabled": true }),
                json!({ "listId": "off", "url": "https://x/off.txt", "enabled": false }),
            ];
            jsonstore::save(app, "subs", &rows).unwrap();
            // Write the cache file enabled_text reads (cache_path is private — mirror it via the cache dir).
            let cache = subs_dir(app).join("ep.txt");
            std::fs::write(&cache, "||cached-ad.example^\n").unwrap();
            let text = enabled_text(app);
            assert!(
                text.contains("||cached-ad.example^"),
                "enabled cached list contributes its text"
            );
            assert!(!text.contains("off"), "a disabled list contributes nothing");
        });
    }
}
