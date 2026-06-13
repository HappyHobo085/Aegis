//! Filter-list subscriptions (subs.* IPC). Each subscription is a remote filter
//! list (EasyPrivacy, regional/language lists, …) fetched over HTTPS, cached to
//! disk, and folded into the ad-block engine alongside EasyList + custom rules.
//!
//! Fetching runs on a background thread so the IPC call returns immediately (no
//! UI stall): `subs.add` inserts the row optimistically, then the fetch fills the
//! cache, stamps `lastUpdated`/`hash`, and re-installs the engine. `enabled_text`
//! concatenates the cached text of every enabled subscription for install_adblock.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::jsonstore;

/// Stable list id from a URL: the last path segment without a `.txt` suffix
/// (matches the Electron app's `listIdFromUrl`).
fn list_id_from_url(url: &str) -> String {
    let last = url.rsplit('/').find(|s| !s.is_empty()).unwrap_or(url);
    last.strip_suffix(".txt").unwrap_or(last).to_string()
}

fn subs_dir(app: &AppHandle) -> std::path::PathBuf {
    let dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/aegis"))
        .join("subs");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn cache_path(app: &AppHandle, list_id: &str) -> std::path::PathBuf {
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
pub fn enabled_text(app: &AppHandle) -> String {
    let mut out = String::new();
    for row in jsonstore::load(app, "subs") {
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

/// Rebuild + reapply the ad-block engine (folds in the current enabled subs).
/// No-op off Linux until the Chromium-side engine lands.
fn reinstall_adblock(app: &AppHandle) {
    #[cfg(target_os = "linux")]
    crate::install_adblock(app.clone());
    #[cfg(not(target_os = "linux"))]
    let _ = app;
}

/// Fetch a subscription in the background, cache it, stamp `lastUpdated`/`hash` on
/// its row, re-install the engine, and notify the renderer. On failure the row
/// keeps `lastUpdated: null` (shows as "never updated") and contributes no rules.
fn fetch_in_background(app: AppHandle, list_id: String, url: String) {
    std::thread::spawn(move || match fetch_text(url) {
        Ok(text) => {
            let _ = std::fs::write(cache_path(&app, &list_id), &text);
            let hash = hash_text(&text);
            let mut items = jsonstore::load(&app, "subs");
            for it in items.iter_mut() {
                if it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()) {
                    it["lastUpdated"] = json!(jsonstore::now_ms());
                    it["hash"] = json!(hash);
                }
            }
            let _ = jsonstore::save(&app, "subs", &items);
            reinstall_adblock(&app);
            let _ = app.emit("subs.changed", Value::Null);
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
pub fn update_all(app: &AppHandle) -> Value {
    let now = jsonstore::now_ms();
    let enabled: Vec<(String, String)> = jsonstore::load(app, "subs")
        .iter()
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
                    let _ = std::fs::write(cache_path(&app, &id), &text);
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
    let mut items = jsonstore::load(app, "subs");
    for it in items.iter_mut() {
        let id = it.get("listId").and_then(Value::as_str).map(str::to_string);
        if let Some(hash) = id.and_then(|id| hashes.get(&id)) {
            it["lastUpdated"] = json!(now);
            it["hash"] = json!(hash);
        }
    }
    let _ = jsonstore::save(app, "subs", &items);
    if !hashes.is_empty() {
        reinstall_adblock(app);
        let _ = app.emit("subs.changed", Value::Null);
    }
    json!({ "perSource": per_source, "lastUpdated": now })
}

/// Handle `subs.*`. Returns `None` if not a subs channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "subs.list" => Some(Ok(json!(jsonstore::load(app, "subs")))),

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
            let mut items = jsonstore::load(app, "subs");
            // Upsert by listId; insert optimistically (lastUpdated=null until the
            // background fetch completes) so the IPC returns without a network wait.
            items.retain(|it| it.get("listId").and_then(Value::as_str) != Some(list_id.as_str()));
            items.push(json!({
                "listId": list_id, "url": url, "enabled": true,
                "lastUpdated": Value::Null, "etag": Value::Null, "hash": Value::Null,
            }));
            let _ = jsonstore::save(app, "subs", &items);
            fetch_in_background(app.clone(), list_id, url);
            Some(Ok(json!(items)))
        }

        "subs.setEnabled" => {
            let list_id = payload.get("listId").and_then(Value::as_str).unwrap_or("").to_string();
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(false);
            let mut items = jsonstore::load(app, "subs");
            let mut need_fetch = false;
            for it in items.iter_mut() {
                if it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()) {
                    it["enabled"] = json!(enabled);
                    // Enabling a list we've never fetched → fetch it now.
                    need_fetch =
                        enabled && it.get("lastUpdated").map(Value::is_null).unwrap_or(true);
                }
            }
            let _ = jsonstore::save(app, "subs", &items);
            match (need_fetch, url_of(&items, &list_id)) {
                (true, Some(url)) => fetch_in_background(app.clone(), list_id, url),
                _ => reinstall_adblock(app),
            }
            Some(Ok(json!(items)))
        }

        "subs.remove" => {
            let list_id = payload.get("listId").and_then(Value::as_str).unwrap_or("").to_string();
            let mut items = jsonstore::load(app, "subs");
            items.retain(|it| it.get("listId").and_then(Value::as_str) != Some(list_id.as_str()));
            let _ = jsonstore::save(app, "subs", &items);
            let _ = std::fs::remove_file(cache_path(app, &list_id));
            reinstall_adblock(app);
            Some(Ok(json!(items)))
        }

        _ => None,
    }
}
