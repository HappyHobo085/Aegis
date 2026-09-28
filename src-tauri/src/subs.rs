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

/// Reject a `listId` that is not exactly ONE safe path component, with the reason.
///
/// `list_id` reaches the cache path from two very different places: derived from a URL
/// by `list_id_from_url` (a URL's last non-empty segment, so never a separator — though
/// it CAN be `.` or `..`), and read VERBATIM off a `subs.json` row. A row is
/// attacker-reachable: `data.import` writes `subs` rows with only `hlc`/`savedAt`
/// restamped, so a bundle can plant any `listId` at all. `Path::join` then either walks
/// out of the cache dir (`../../…`) or REPLACES it outright when the id is absolute, and
/// `write_atomic_inner` calls `create_dir_all` on the parent first — so the write lands.
/// `remove_file` reaches the same path, so the traversal also DELETES.
///
/// Containment is therefore enforced on the ID, not on the joined path. A lexical
/// `Path::starts_with` guard would be theatre: it never normalises `..`, and a write
/// target need not exist to be a write target. Requiring a single component makes the
/// join provably a child of `subs_dir`, which `cache_path` then asserts structurally.
fn safe_list_id(list_id: &str) -> Result<(), String> {
    if list_id.is_empty() {
        return Err("the subscription list id is empty".into());
    }
    if list_id == "." || list_id == ".." {
        return Err(format!(
            "{list_id:?} is a directory reference, not a list id"
        ));
    }
    if list_id.contains('/') || list_id.contains('\\') {
        return Err(format!(
            "{list_id:?} contains a path separator, so its cache file would land outside the cache dir"
        ));
    }
    if list_id.contains('\0') {
        return Err(format!("{list_id:?} contains a NUL byte"));
    }
    // Redundant with the separator check on POSIX, but `C:evil` is drive-RELATIVE on
    // Windows and escapes without one. A `:` is illegal in a Windows file name anyway,
    // so banning it everywhere also stops a list that caches on Linux from silently
    // failing to cache on Windows.
    if list_id.contains(':') || std::path::Path::new(list_id).is_absolute() {
        return Err(format!(
            "{list_id:?} is an absolute or drive-qualified path, not a list id"
        ));
    }
    Ok(())
}

/// `<cache>/subs/<listId>.txt`, or `Err` if `list_id` is not a single safe component
/// (see `safe_list_id`). Every cache read, write and unlink goes through here, so there
/// is exactly one place to audit for containment.
fn cache_path<R: Runtime>(app: &AppHandle<R>, list_id: &str) -> Result<std::path::PathBuf, String> {
    safe_list_id(list_id)?;
    let dir = subs_dir(app);
    let p = dir.join(format!("{list_id}.txt"));
    // Independent structural check on the invariant `safe_list_id` is there to buy.
    // If this ever fires the id rule has a hole, so assert rather than silently write.
    debug_assert_eq!(
        p.parent(),
        Some(dir.as_path()),
        "a validated list id must join to a direct child of the cache dir"
    );
    Ok(p)
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
            // A row whose id is not a single component (only reachable through
            // data.import) has no cache file inside the cache dir, so it contributes
            // nothing — and must not be read from wherever the id happens to point.
            if let Ok(p) = cache_path(app, id) {
                if let Ok(text) = std::fs::read_to_string(p) {
                    out.push('\n');
                    out.push_str(&text);
                }
            }
        }
    }
    out
}

/// The built-in default subscriptions seeded on first run — uBlock Origin's
/// default-enabled set. Their rules ALSO ship baked-in via `adblock_lists` (the static
/// bundle still blocks day-one + offline and feeds the Win/macOS cosmetic injector,
/// which is NOT fed subscriptions), so seeding them here just makes them visible and
/// self-refreshing in the Filter Lists UI. The `listId` is FIXED (not derived from the
/// URL) so the cache file is a clean `<listId>.txt` matching the bundled list name —
/// Peter Lowe's has no plain `.txt` URL, hence the explicit id. `abuse-tlds` is NOT here:
/// it is Aegis-curated with no upstream URL, so it stays baked-only.
const DEFAULTS: &[(&str, &str)] = &[
    ("easylist", "https://easylist.to/easylist/easylist.txt"),
    (
        "easyprivacy",
        "https://easylist.to/easylist/easyprivacy.txt",
    ),
    (
        "peter-lowe",
        "https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&mimetype=plaintext",
    ),
];

/// Ensure the built-in default subscriptions exist in the `subs` store (idempotent,
/// tombstone-aware). Returns the `(listId, url)` of rows newly added this call. A
/// default is skipped if a row with its `listId` already exists — INCLUDING a
/// tombstoned one — so a user who removed a default is never overruled. Pure store
/// mutation, triggers no network (`seed_defaults` is the boot wrapper; it does NOT fetch).
fn ensure_default_rows<R: Runtime>(app: &AppHandle<R>) -> Vec<(String, String)> {
    let mut items = jsonstore::load_synced(app, "subs");
    let mut added = Vec::new();
    for (list_id, url) in DEFAULTS {
        let exists = items
            .iter()
            .any(|it| it.get("listId").and_then(Value::as_str) == Some(*list_id));
        if exists {
            continue; // present (live or tombstoned) → respect the existing row
        }
        let mut item = json!({
            "listId": list_id, "url": url, "enabled": true, "builtin": true,
            "lastUpdated": Value::Null, "etag": Value::Null, "hash": Value::Null,
        });
        jsonstore::stamp_new(&mut item, app);
        items.push(item);
        added.push(((*list_id).to_string(), (*url).to_string()));
    }
    if !added.is_empty() {
        let _ = jsonstore::save(app, "subs", &items);
    }
    added
}

/// Seed the built-in default subscriptions on first run. Called once from `lib.rs`
/// setup (alongside `adblock::seed_from_disk`). Seeds the ROWS only — it deliberately
/// does NOT kick off a fetch: the baked-in `adblock_lists` copies already provide these
/// rules, so blocking is unaffected, and an immediate boot fetch would trigger a
/// content-filter reinstall storm — on Linux each completed fetch re-applies the WebKit
/// content filters (`install_adblock`, heavy + disruptive to an in-flight find-in-page
/// or the active page). The defaults refresh on the user's "Update all"
/// (`lists.updateNow`) or when toggled off→on (both already fetch + reinstall, which is
/// expected at that point). No-op once seeded; never resurrects a removed default.
pub fn seed_defaults<R: Runtime>(app: &AppHandle<R>) {
    ensure_default_rows(app);
}

/// Whether enabling a subscription should trigger an immediate background fetch. A list
/// we've never fetched (no cache) normally fetches when first enabled — EXCEPT a built-in
/// default, which is already covered by the baked-in `adblock_lists` copy and refreshes
/// only on explicit "Update all". This keeps toggling a default off→on from surprising the
/// user with a multi-MB download + content-filter reinstall (and keeps the engine reapply
/// off the critical path — the live autopilot's find-in-page check caught exactly that
/// collision when the seeded `easylist` re-fetched on toggle).
fn should_fetch_on_enable(enabled: bool, never_fetched: bool, builtin: bool) -> bool {
    enabled && never_fetched && !builtin
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
            // A rejected list id and a failed write are the same class of event here
            // (this list ends up with no cache), so report both the same way.
            match cache_path(&app, &list_id) {
                Ok(p) => {
                    if let Err(e) = jsonstore::write_atomic_no_backup(&p, text.as_bytes()) {
                        eprintln!("[aegis] failed to cache subscription list {list_id}: {e}");
                    }
                }
                Err(e) => {
                    eprintln!("[aegis] refused to cache subscription list {list_id}: {e}")
                }
            }
            let hash = hash_text(&text);
            // One store lock across the read-modify-write: this runs on a per-subscription
            // thread, so several of them plus the UI's `subs.*` channels race this file.
            // Without the lock a concurrent `subs.add` landing between the load and the save
            // is silently overwritten, and the successful save hides the loss.
            jsonstore::with_store_lock("subs", || {
                let mut items = jsonstore::load_synced(&app, "subs");
                for it in items.iter_mut() {
                    if it.get("listId").and_then(Value::as_str) == Some(list_id.as_str()) {
                        it["lastUpdated"] = json!(jsonstore::now_ms());
                        it["hash"] = json!(hash);
                        jsonstore::touch(it, &app);
                    }
                }
                let _ = jsonstore::save(&app, "subs", &items);
            });
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

/// Kick off a background refresh of every enabled subscription and return immediately. The
/// `ipc` command is synchronous and runs on the UI thread (wry delivers the IPC message
/// there), so doing the up-to-25s network fetch inline would freeze the whole window. The
/// per-source result is delivered to the renderer via the `lists.updateResult` event when the
/// background pass finishes (`run_update` also emits `subs.changed` if anything changed).
pub fn update_now<R: Runtime>(app: &AppHandle<R>) {
    let app = app.clone();
    std::thread::spawn(move || {
        let result = run_update(&app);
        crate::emit_event(&app, "lists.updateResult", result);
    });
}

/// Re-fetch every ENABLED subscription, refresh its cache + stamp, re-install the
/// engine once, and return a `ListUpdateResult` (per-source ok/error + timestamp).
/// Fetches run concurrently so wall-time is the slowest single list. Runs on the
/// `update_now` background thread.
fn run_update<R: Runtime>(app: &AppHandle<R>) -> Value {
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
                    if let Ok(p) = cache_path(&app, &id) {
                        let _ = jsonstore::write_atomic_no_backup(&p, text.as_bytes());
                    }
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
    // Same store lock as the per-subscription refresh above: this bulk path and those
    // threads both rewrite `subs.json`, so the read-modify-write must be serialized.
    jsonstore::with_store_lock("subs", || {
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
    });
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
            // A URL's last segment cannot hold a separator, but it CAN be `.` or `..`.
            // Reject here rather than accept a row whose cache file can never exist.
            if let Err(e) = safe_list_id(&list_id) {
                return Some(Err(format!("subscription url {url} is not usable: {e}")));
            }
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
            // Enabling a row can trigger a cache WRITE, so a row whose id could not name
            // a file inside the cache dir is refused here instead of silently doing
            // nothing. `subs.remove` is the way out of such a row.
            if let Err(e) = safe_list_id(&list_id) {
                return Some(Err(format!("cannot enable that subscription: {e}")));
            }
            let mut items = jsonstore::load_synced(app, "subs");
            let mut need_fetch = false;
            for it in items.iter_mut() {
                if !jsonstore::is_deleted(it)
                    && it.get("listId").and_then(Value::as_str) == Some(list_id.as_str())
                {
                    it["enabled"] = json!(enabled);
                    // Enabling a list we've never fetched → fetch it now (but NOT a built-in
                    // default — it's baked in and refreshes via "Update all"; see
                    // should_fetch_on_enable).
                    let never_fetched = it.get("lastUpdated").map(Value::is_null).unwrap_or(true);
                    let builtin = it.get("builtin").and_then(Value::as_bool).unwrap_or(false);
                    need_fetch = should_fetch_on_enable(enabled, never_fetched, builtin);
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
            // The row is tombstoned either way, so removal always succeeds and a row
            // planted by data.import is always cleanable. Only the regenerable cache
            // file is conditional — and a row whose id is not a single component never
            // had one, so there is nothing to unlink.
            match cache_path(app, &list_id) {
                Ok(p) => {
                    let _ = std::fs::remove_file(p); // cache is regenerable
                }
                Err(e) => eprintln!("[aegis] left a cache file alone for {list_id:?}: {e}"),
            }
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

    #[test]
    fn ensure_default_rows_adds_three_builtin_defaults_to_empty_store() {
        with_tmp_app(|app| {
            let added = ensure_default_rows(app);
            assert_eq!(added.len(), 3, "all three defaults added to an empty store");
            let listed = dispatch(app, "subs.list", &json!({})).unwrap().unwrap();
            let rows = listed.as_array().unwrap();
            let ids: Vec<&str> = rows
                .iter()
                .filter_map(|r| r.get("listId").and_then(Value::as_str))
                .collect();
            for id in ["easylist", "easyprivacy", "peter-lowe"] {
                assert!(ids.contains(&id), "default {id} present");
            }
            for r in rows {
                assert_eq!(
                    r.get("enabled").and_then(Value::as_bool),
                    Some(true),
                    "default seeded enabled"
                );
                assert_eq!(
                    r.get("builtin").and_then(Value::as_bool),
                    Some(true),
                    "default marked builtin"
                );
                assert!(
                    r.get("lastUpdated").map(Value::is_null).unwrap_or(false),
                    "not fetched yet (static bundle covers day-one)"
                );
            }
        });
    }

    #[test]
    fn ensure_default_rows_is_idempotent() {
        with_tmp_app(|app| {
            assert_eq!(ensure_default_rows(app).len(), 3);
            assert!(
                ensure_default_rows(app).is_empty(),
                "re-seeding an already-seeded store adds nothing"
            );
            let listed = dispatch(app, "subs.list", &json!({})).unwrap().unwrap();
            assert_eq!(
                listed.as_array().unwrap().len(),
                3,
                "no duplicate default rows"
            );
        });
    }

    #[test]
    fn ensure_default_rows_does_not_resurrect_a_removed_default() {
        with_tmp_app(|app| {
            ensure_default_rows(app);
            // The user removes a default (tombstones it).
            dispatch(app, "subs.remove", &json!({ "listId": "easylist" }))
                .unwrap()
                .unwrap();
            // Re-seeding must respect that choice and NOT bring it back.
            let added = ensure_default_rows(app);
            assert!(
                !added.iter().any(|(id, _)| id == "easylist"),
                "a removed default is not re-added"
            );
            let listed = dispatch(app, "subs.list", &json!({})).unwrap().unwrap();
            let ids: Vec<&str> = listed
                .as_array()
                .unwrap()
                .iter()
                .filter_map(|r| r.get("listId").and_then(Value::as_str))
                .collect();
            assert!(!ids.contains(&"easylist"), "removed default stays gone");
            assert!(ids.contains(&"easyprivacy"), "other defaults remain");
        });
    }

    #[test]
    fn builtin_default_does_not_fetch_on_enable_but_user_list_does() {
        // A user-added list never fetched yet → fetch when first enabled (existing behavior).
        assert!(should_fetch_on_enable(true, true, false));
        // A built-in default never fetched → do NOT auto-fetch on enable (the baked copy
        // covers it; refresh is via "Update all" only — no surprise multi-MB download).
        assert!(!should_fetch_on_enable(true, true, true));
        // Disabling never fetches.
        assert!(!should_fetch_on_enable(false, true, false));
        assert!(!should_fetch_on_enable(false, true, true));
        // An already-fetched list (lastUpdated set) never re-fetches on enable.
        assert!(!should_fetch_on_enable(true, false, false));
    }

    #[test]
    fn builtin_flag_survives_set_enabled() {
        with_tmp_app(|app| {
            ensure_default_rows(app);
            let after = dispatch(
                app,
                "subs.setEnabled",
                &json!({ "listId": "easyprivacy", "enabled": false }),
            )
            .unwrap()
            .unwrap();
            let row = after
                .as_array()
                .unwrap()
                .iter()
                .find(|r| r.get("listId").and_then(Value::as_str) == Some("easyprivacy"))
                .unwrap();
            assert_eq!(
                row.get("enabled").and_then(Value::as_bool),
                Some(false),
                "toggled off"
            );
            assert_eq!(
                row.get("builtin").and_then(Value::as_bool),
                Some(true),
                "still flagged builtin after a toggle"
            );
        });
    }

    // ---------------------------------------------------------------------
    // Cache-path containment. `subs.json` rows are attacker-reachable through
    // data.import (it writes `subs` rows verbatim), and every cache read,
    // write and unlink derives its path from the row's `listId`, so the id is
    // the one thing standing between a pasted bundle and the rest of the disk.
    // ---------------------------------------------------------------------

    #[test]
    fn a_list_id_that_is_not_a_single_component_is_refused() {
        // Refused: anything that could walk out of the cache dir, replace it, or is
        // not a name at all. `..` and `.` are refused even though `format!("{id}.txt")`
        // would make them harmless single components — the id itself is the thing the
        // rest of the module compares against, so a directory reference is a bug
        // everywhere else, not just here.
        for bad in [
            "",
            ".",
            "..",
            "../escape",
            "..\\escape",
            "a/b",
            "a\\b",
            "/etc/cron.d/pwn",
            "C:evil",
            "C:\\evil",
            "has:colon",
            "has\0nul",
        ] {
            assert!(
                safe_list_id(bad).is_err(),
                "{bad:?} must be refused as a list id, not joined onto the cache dir"
            );
        }
        // Accepted: everything `list_id_from_url` legitimately produces from a URL
        // path segment, including the odd ones — a real list id is a URL's last
        // segment, so it may legally carry punctuation, a query string, or nothing
        // that looks like a path at all.
        for ok in [
            "easyprivacy",
            "de_AT",
            "list(1)",
            "a+b",
            "a=b",
            "a,b",
            "a;b",
            "a!b",
            "a$b",
            "a&b",
            "a'b",
            "a@b",
            "a%20b",
            "a*b",
            "a~b",
            "a=b.txt?x=1",
            ".hidden",
            "..leading-dots",
        ] {
            assert!(
                safe_list_id(ok).is_ok(),
                "{ok:?} is a legal URL path segment and must stay usable"
            );
        }
    }

    #[test]
    fn a_valid_list_id_joins_to_a_direct_child_of_the_cache_dir() {
        with_tmp_app(|app| {
            let p = cache_path(app, "easyprivacy").expect("a normal list id is accepted");
            assert_eq!(
                p,
                subs_dir(app).join("easyprivacy.txt"),
                "the cache file is <cache>/subs/<listId>.txt"
            );
            assert_eq!(p.parent(), Some(subs_dir(app).as_path()));
        });
    }

    #[test]
    fn an_imported_row_cannot_read_a_cache_file_from_outside_the_cache_dir() {
        with_tmp_app(|app| {
            // The escape target sits one level ABOVE the subs cache dir, so a joined
            // `../outside` reaches it. Plant a file with a marker in its text.
            let outside = subs_dir(app)
                .parent()
                .expect("the cache dir has a parent")
                .join("outside.txt");
            std::fs::write(&outside, "||marker-from-outside-the-cache-dir^\n").unwrap();

            // Plant the row the way a pasted backup does: through the real import.
            let bundle = json!({ "subs": [{
                "listId": "../outside",
                "url": "https://x.test/outside.txt",
                "enabled": true,
            }]});
            let res =
                crate::data::dispatch(app, "data.import", &json!({ "text": bundle.to_string() }))
                    .expect("data.import is handled")
                    .expect("a refused import is Ok(json), not Err");
            assert_eq!(
                res.get("ok").and_then(Value::as_bool),
                Some(true),
                "the import itself succeeds — a poisoned row is inert, not fatal: {res}"
            );

            let text = enabled_text(app);
            assert!(
                !text.contains("marker-from-outside-the-cache-dir"),
                "an enabled row must not pull filter text in from outside the cache dir \
                 (read the file at {outside:?})"
            );
            assert!(
                outside.exists(),
                "and the planted file must still be there — the import is a read, not a write"
            );
        });
    }

    #[test]
    fn removing_a_subscription_cannot_unlink_a_file_outside_the_cache_dir() {
        with_tmp_app(|app| {
            let victim = subs_dir(app)
                .parent()
                .expect("the cache dir has a parent")
                .join("victim.txt");
            std::fs::write(&victim, "not a filter list").unwrap();

            // A row so the removal has something to tombstone, plus the hostile id.
            jsonstore::save(
                app,
                "subs",
                &[json!({ "listId": "../victim", "url": "https://x/victim.txt", "enabled": true })],
            )
            .unwrap();
            let listed = dispatch(app, "subs.remove", &json!({ "listId": "../victim" }))
                .expect("subs.remove is handled")
                .expect("a bad list id is a refusal, not a crash");
            assert!(
                listed.get("ok").is_none() && listed.as_array().is_some(),
                "removal still succeeds so a planted row stays cleanable: {listed}"
            );
            assert!(
                victim.exists(),
                "subs.remove must not unlink a file outside the cache dir (looked at {victim:?})"
            );
            // A well-formed id in the same breath still unlinks its own cache file.
            std::fs::write(subs_dir(app).join("ep.txt"), "||x^").unwrap();
            jsonstore::save(
                app,
                "subs",
                &[json!({ "listId": "ep", "url": "https://x/ep.txt", "enabled": true })],
            )
            .unwrap();
            dispatch(app, "subs.remove", &json!({ "listId": "ep" }))
                .unwrap()
                .unwrap();
            assert!(
                !subs_dir(app).join("ep.txt").exists(),
                "a real list's own cache file is still removed"
            );
        });
    }

    #[test]
    fn adding_a_url_whose_last_segment_is_a_directory_reference_is_refused() {
        with_tmp_app(|app| {
            // `list_id_from_url` takes the last non-empty path segment, which for this
            // URL is `..` — no separator, so the derived id cannot traverse, but it is
            // still not a name. Refuse it at the door rather than accept a row whose
            // cache file can never exist.
            let res = dispatch(app, "subs.add", &json!({ "url": "https://x.test/.." }))
                .expect("subs.add is handled");
            let msg = res
                .expect_err("`https://x.test/..` must be refused")
                .to_string();
            assert!(
                msg.contains("not usable") || msg.contains("directory reference"),
                "the refusal must say why, got: {msg}"
            );
            let rows = jsonstore::load_synced(app, "subs");
            assert!(
                !rows
                    .iter()
                    .any(|r| r.get("listId").and_then(Value::as_str) == Some("..")),
                "and no row is created for it"
            );
        });
    }

    #[test]
    fn enabling_a_row_whose_id_cannot_name_a_cache_file_is_refused() {
        with_tmp_app(|app| {
            jsonstore::save(
                app,
                "subs",
                &[json!({
                    "listId": "../escape", "url": "https://x.test/escape.txt", "enabled": false,
                })],
            )
            .unwrap();
            // Enabling a never-fetched list triggers a cache write, so this is the arm
            // that would have written outside the cache dir.
            let res = dispatch(
                app,
                "subs.setEnabled",
                &json!({ "listId": "../escape", "enabled": true }),
            )
            .expect("subs.setEnabled is handled");
            let msg = res
                .expect_err("a hostile list id must be refused")
                .to_string();
            assert!(
                msg.contains("path separator"),
                "the refusal must name the reason, got: {msg}"
            );
            let row = jsonstore::load_synced(app, "subs")
                .into_iter()
                .find(|r| r.get("listId").and_then(Value::as_str) == Some("../escape"))
                .expect("the row is still there to be inspected");
            assert_eq!(
                row.get("enabled").and_then(Value::as_bool),
                Some(false),
                "and it was not flipped either"
            );
        });
    }
}
