//! Persistent settings (settings.* IPC). Stored as JSON in the app data dir —
//! a single config object doesn't need a DB. Lists (favorites/history/…) get a
//! real store in Phase 2; settings staying JSON is fine and keeps this contained.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url};

fn store_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings.json"))
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
        "tabIdleTimeout": 30,
        "webrtcPolicy": "public-only",
        "themeMode": "system",
        "syncServerUrl": ""
    })
}

/// The full settings object (for data export).
pub fn all<R: Runtime>(app: &AppHandle<R>) -> Value {
    load(app)
}

/// Overwrite the settings file (for data import). Durable (atomic temp→rename + .bak).
pub fn write<R: Runtime>(app: &AppHandle<R>, value: &Value) {
    if let Some(p) = store_path(app) {
        let txt = serde_json::to_string_pretty(value).unwrap_or_default();
        let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
    }
}

/// Configured download directory ("" = use the OS Downloads dir).
pub fn download_dir<R: Runtime>(app: &AppHandle<R>) -> String {
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

/// The WebRTC IP-leak policy: "default" | "public-only" | "disable" (default
/// "public-only"). Single source for the shim builder + the native backstops.
pub fn webrtc_policy<R: Runtime>(app: &AppHandle<R>) -> String {
    load(app)
        .get("webrtcPolicy")
        .and_then(Value::as_str)
        .unwrap_or("public-only")
        .to_string()
}

/// The sync server endpoint ("" = sync not configured; data stays local until set).
pub fn sync_server_url<R: Runtime>(app: &AppHandle<R>) -> String {
    load(app)
        .get("syncServerUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Minutes a background tab may idle before discard (0 disables). Default 30.
pub fn tab_idle_timeout_min(app: &AppHandle) -> u64 {
    load(app)
        .get("tabIdleTimeout")
        .and_then(Value::as_u64)
        .unwrap_or(30)
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
fn load<R: Runtime>(app: &AppHandle<R>) -> Value {
    let mut s = defaults();
    if let Some(p) = store_path(app) {
        // read_with_backup recovers from settings.json.bak if the primary is corrupt,
        // instead of resetting every key to its default.
        if let Some(txt) = crate::jsonstore::read_with_backup(&p) {
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

// ---------------------------------------------------------------------------
// Per-key sync projection (F2a). settings.json stays FLAT + untouched (all getters and
// the heavily-tested load/merge path are unchanged), so a deleted key still resurrects to
// its default via the defaults overlay — which is exactly the "reset to default" semantic
// we want. The SYNCABLE state lives in a parallel `settings-sync.json`: one record per key
// `{key, value, uuid, hlc, deleted}`. F2b merges per-key (LWW) and calls `apply_synced` to
// write the result back into the flat file (or remove a key → it falls to default).
// ---------------------------------------------------------------------------

fn sync_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("settings-sync.json"))
}

fn load_sync_records<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    sync_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
        .unwrap_or_default()
}

fn save_sync_records<R: Runtime>(app: &AppHandle<R>, recs: &[Value]) {
    if let Some(p) = sync_path(app) {
        if let Ok(txt) = serde_json::to_string_pretty(recs) {
            let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
        }
    }
}

/// Build the projection on first use (no file yet) so existing installs migrate lazily.
///
/// CRITICAL for cross-device correctness: seed ONLY from keys actually present in the
/// on-disk `settings.json` (the user's REAL, non-default state) — NOT the defaults-overlaid
/// `load()`. A key the user never touched gets NO record, so on first sync it can't push
/// the default value over a peer's deliberate older change (settings merge by key). And
/// each migration HLC is the FLOOR (`Hlc::zero`): the real edit time is unknown, so any
/// genuine post-migration edit on ANY device must strictly dominate the migration seed.
fn ensure_sync_projection<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    let mut recs = load_sync_records(app);
    if !recs.is_empty() {
        return recs;
    }
    let node = crate::sync_identity::node_id(app);
    let on_disk = store_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok());
    if let Some(obj) = on_disk.as_ref().and_then(|v| v.as_object()) {
        for (k, v) in obj {
            let hlc = crate::sync_envelope::Hlc::zero(&node);
            recs.push(json!({
                // uuid == the key: deterministic so every device's record for a key shares
                // one server identity (HLC-LWW dedups; no per-device orphan records).
                "key": k, "value": v.clone(), "uuid": k,
                "hlc": serde_json::to_value(&hlc).unwrap_or(Value::Null),
                "deleted": false,
            }));
        }
    }
    save_sync_records(app, &recs);
    recs
}

/// Record a per-key change in the projection (upsert + tick HLC), skipping a no-op write
/// when the value is unchanged. Called per-key from `settings.set`.
fn record_change(app: &AppHandle, key: &str, value: &Value) {
    let mut recs = ensure_sync_projection(app);
    let node = crate::sync_identity::node_id(app);
    if let Some(r) = recs
        .iter_mut()
        .find(|r| r.get("key").and_then(Value::as_str) == Some(key))
    {
        // No HLC churn if the value didn't actually change (and it isn't a revive).
        if r.get("value") == Some(value)
            && !r.get("deleted").and_then(Value::as_bool).unwrap_or(false)
        {
            return;
        }
        let hlc = crate::sync_envelope::tick(&node, crate::jsonstore::now_ms());
        if let Some(o) = r.as_object_mut() {
            o.insert("value".into(), value.clone());
            o.insert(
                "hlc".into(),
                serde_json::to_value(&hlc).unwrap_or(Value::Null),
            );
            o.insert("deleted".into(), json!(false));
        }
    } else {
        let hlc = crate::sync_envelope::tick(&node, crate::jsonstore::now_ms());
        recs.push(json!({
            "key": key, "value": value.clone(), "uuid": key, // deterministic id (see ensure_sync_projection)
            "hlc": serde_json::to_value(&hlc).unwrap_or(Value::Null),
            "deleted": false,
        }));
    }
    save_sync_records(app, &recs);
}

/// Pure per-KEY HLC last-writer-wins fold of `remote` into `local`. Returns the merged
/// records + the changed keys. AppHandle-free so the merge rules are deterministically
/// testable (mirrors sync_stores::merge_records, but the identity is `key`, not `uuid`).
fn merge_projection(mut local: Vec<Value>, remote: &[Value]) -> (Vec<Value>, Vec<String>) {
    let mut changed = Vec::new();
    for r in remote {
        let Some(key) = r.get("key").and_then(Value::as_str) else {
            continue;
        };
        let Some(rhlc) = crate::sync_envelope::from_value(r) else {
            continue;
        };
        match local
            .iter_mut()
            .find(|l| l.get("key").and_then(Value::as_str) == Some(key))
        {
            Some(l) => {
                if crate::sync_envelope::from_value(l)
                    .map(|lh| rhlc > lh)
                    .unwrap_or(true)
                {
                    *l = r.clone();
                    changed.push(key.to_string());
                }
            }
            None => {
                local.push(r.clone());
                changed.push(key.to_string());
            }
        }
    }
    (local, changed)
}

/// Merge remote per-key records into the local projection (per-KEY HLC-LWW) and apply the
/// result to the flat settings. Returns the keys that changed. The sync engine calls this
/// for the `settings` namespace.
pub fn merge_remote<R: Runtime>(app: &AppHandle<R>, remote: &[Value]) -> Vec<String> {
    let node = crate::sync_identity::node_id(app);
    for r in remote {
        if let Some(h) = crate::sync_envelope::from_value(r) {
            crate::sync_envelope::observe(&node, crate::jsonstore::now_ms(), &h);
        }
    }
    let (merged, changed) = merge_projection(ensure_sync_projection(app), remote);
    if !changed.is_empty() {
        apply_synced(app, &merged); // writes the flat settings + saves the merged projection
    }
    changed
}

/// The per-key sync records (for the merge seam / export). Migrates lazily on first call.
#[allow(dead_code)] // consumed by the F2b sync merge — dead on the Android cdylib until then
pub fn sync_records<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    ensure_sync_projection(app)
}

/// Wipe + rebuild the per-key projection from the current flat settings — used after a
/// data import replaces the flat file, so the projection reflects the imported values
/// (with fresh HLCs) rather than the pre-import keys.
pub fn rebuild_projection_from_current<R: Runtime>(app: &AppHandle<R>) {
    save_sync_records(app, &[]);
    let _ = ensure_sync_projection(app);
}

/// Apply merged per-key records back into the flat settings file: write each live key's
/// value, or REMOVE a tombstoned key so `load()` falls to its default (= "reset to
/// default"). Consumed by F2b's merge. (Also rebuilds the projection from `records`.)
#[allow(dead_code)] // consumed by the F2b sync merge
pub fn apply_synced<R: Runtime>(app: &AppHandle<R>, records: &[Value]) {
    // Start from the saved flat file (NOT defaults overlay) so we only touch synced keys.
    let mut flat = store_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .unwrap_or_else(|| json!({}));
    if let Some(obj) = flat.as_object_mut() {
        for r in records {
            let Some(key) = r.get("key").and_then(Value::as_str) else {
                continue;
            };
            if r.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
                obj.remove(key); // → load() falls back to the default for this key
            } else if let Some(v) = r.get("value") {
                obj.insert(key.to_string(), v.clone());
            }
        }
    }
    write(app, &flat);
    save_sync_records(app, records);
    // Android: a synced webrtcPolicy change must update the document-start shim's policy
    // global too (its JNI getter reads the global, not the file) — mirror settings.set so
    // a peer-synced change is honored on new tabs without a restart. Cheap; re-push always.
    #[cfg(target_os = "android")]
    crate::webrtc_shim::note_policy(&webrtc_policy(app));
}

/// Handle `settings.*` channels. Returns `None` if not a settings channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "settings.get" => Some(Ok(load(app))),
        "settings.set" => {
            // Materialize the projection from the PRE-change on-disk settings FIRST, so a
            // key's first edit is recorded as a real (ticked) change — not folded into the
            // migration seed (whose floor HLC would lose to a peer's later default).
            let _ = ensure_sync_projection(app);
            let mut current = load(app);
            if let Some(partial) = payload.get("partial") {
                merge(&mut current, partial);
            }
            if let Some(p) = store_path(app) {
                match serde_json::to_string_pretty(&current) {
                    Ok(txt) => {
                        if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
                            return Some(Err(format!("write settings: {e}")));
                        }
                    }
                    Err(e) => return Some(Err(e.to_string())),
                }
            }
            // Update the per-key sync projection for each key the renderer set.
            if let Some(partial) = payload.get("partial").and_then(Value::as_object) {
                for (k, v) in partial {
                    record_change(app, k, v);
                }
            }
            // Android: keep the WebRTC document-start shim's policy in sync (its JNI getter
            // has no AppHandle). New tabs pick up the change; desktop reads settings directly.
            #[cfg(target_os = "android")]
            crate::webrtc_shim::note_policy(
                current
                    .get("webrtcPolicy")
                    .and_then(Value::as_str)
                    .unwrap_or("public-only"),
            );
            Some(Ok(current))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rec(key: &str, wall: i64, value: Value) -> Value {
        json!({ "key": key, "uuid": key, "value": value,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "remote" }, "deleted": false })
    }

    #[test]
    fn merge_projection_is_per_key_lww() {
        let local = vec![
            rec("httpsOnly", 5, json!(false)),
            rec("primaryColor", 1, json!("#000")),
        ];
        let remote = vec![
            rec("httpsOnly", 2, json!(true)), // older → ignored (keep local false)
            rec("primaryColor", 9, json!("#fff")), // newer → wins
            rec("homeUrl", 1, json!("https://x")), // new key → inserted
        ];
        let (merged, mut changed) = merge_projection(local, &remote);
        changed.sort();
        assert_eq!(
            changed,
            vec!["homeUrl".to_string(), "primaryColor".to_string()]
        );
        let by_key = |k: &str| {
            merged
                .iter()
                .find(|r| r.get("key").and_then(Value::as_str) == Some(k))
                .cloned()
                .unwrap()
        };
        assert_eq!(by_key("httpsOnly").get("value"), Some(&json!(false))); // unchanged
        assert_eq!(by_key("primaryColor").get("value"), Some(&json!("#fff"))); // updated
        assert_eq!(by_key("homeUrl").get("value"), Some(&json!("https://x"))); // inserted
    }
}
