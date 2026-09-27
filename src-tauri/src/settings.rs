//! Persistent settings (settings.* IPC). Stored as JSON in the app data dir —
//! a single config object doesn't need a DB. Lists (favorites/history/…) get a
//! real store in Phase 2; settings staying JSON is fine and keeps this contained.
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::RwLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url};

/// Process-lifetime cache of the merged settings object, invalidated on every write.
/// Without it, `load()` re-reads + triple-parses `settings.json` on every getter — and
/// `load()` is on the per-navigation (per-subframe) hot path via `https_only` /
/// `webrtc_policy`. Managed per-AppHandle (registered in `lib.rs` setup + `test_support`).
#[derive(Default)]
pub struct SettingsCache {
    /// The cached merged object, or `None` when it must be re-read from disk.
    value: RwLock<Option<Value>>,
    /// Bumped by [`invalidate_cache`] on every write.
    ///
    /// `load()` reads the file *outside* any lock (parsing is the expensive part and must
    /// not serialize the hot per-navigation path), so without a generation two writers can
    /// interleave: reader A misses the cache and starts parsing the pre-write file, then a
    /// write lands and bumps the generation, then reader A publishes its now-stale parse —
    /// and the freshly-written value is gone from the cache with nothing left to invalidate
    /// it. The sync engine's background thread writes settings (`apply_synced`) while the
    /// main thread reads them, so this ordering is reachable, not theoretical. Reader A
    /// therefore captures the generation *before* reading the file and only publishes if it
    /// is unchanged, which makes the worst case "one wasted re-read" instead of "a stale
    /// value pinned for the rest of the process".
    generation: AtomicU64,
}

/// Drop the cached settings so the next `load()` re-reads from disk. Must be called after
/// every write to `settings.json`, or a getter could return a stale value.
fn invalidate_cache<R: Runtime>(app: &AppHandle<R>) {
    if let Some(cache) = app.try_state::<SettingsCache>() {
        // Bump even if we cannot take the value lock: a writer that fails to lock is a
        // writer that did not store anything, and the generation is what `load` checks.
        cache.generation.fetch_add(1, Ordering::Relaxed);
        if let Ok(mut g) = cache.value.write() {
            *g = None;
        }
    }
}

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
        "primaryColor": "#2563eb",
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
        "syncServerUrl": "",
        "syncAllowInsecure": false,
        "backgroundTabTimeout": 30000,
        "aggressiveSweepThreshold": 20,
        "antiFingerprint": "off",
        "syncIntervalSec": 300,
        "proxy": { "mode": "off", "scheme": "http", "host": "", "port": 8080, "bypassHosts": [] }
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
        if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
            eprintln!("[aegis] failed to persist settings: {e}");
        }
    }
    // The file changed — drop the cache so getters re-read the new values.
    invalidate_cache(app);
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
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn https_only(app: &AppHandle) -> bool {
    load(app)
        .get("httpsOnly")
        .and_then(Value::as_bool)
        .unwrap_or(true)
}

/// Whether the user has opted the password vault into E2E sync. **Default false**.
///
/// Separate from `sync.enabled` on purpose: pairing a sync account is a much broader action
/// than consenting to upload a password vault, so the vault never leaves the device until the
/// user says so explicitly. The flag is also synced like any other setting, so a user who turns
/// it on once has it on everywhere — but it is still *not* a substitute for adoption: a device
/// whose vault is still on its own per-device salt cannot sync records regardless of this flag
/// (see `vault::KDF_V_SYNCED` / `sync_vault::try_adopt`).
pub fn sync_vault<R: Runtime>(app: &AppHandle<R>) -> bool {
    load(app)
        .get("syncVault")
        .and_then(Value::as_bool)
        .unwrap_or(false)
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

/// The anti-fingerprint level: `"off"` (default, opt-in) | `"standard"` | `"strict"`.
/// Raw read — callers (e.g. `farble::level`) validate/clamp the value.
pub fn anti_fingerprint<R: Runtime>(app: &AppHandle<R>) -> String {
    load(app)
        .get("antiFingerprint")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string()
}

/// The proxy configuration object. Returns the stored value or a safe `mode:"off"` default.
pub fn proxy_config<R: Runtime>(app: &AppHandle<R>) -> Value {
    load(app)
        .get("proxy")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({ "mode": "off" }))
}

/// The sync server endpoint ("" = sync not configured; data stays local until set).
pub fn sync_server_url<R: Runtime>(app: &AppHandle<R>) -> String {
    load(app)
        .get("syncServerUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// Whether the user has explicitly waived the "https, or loopback only" rule in
/// `sync::validated_base`, allowing a **plaintext `http://` sync server on a non-loopback
/// host**. **Default false** — the waivable case is opt-in, never inferred.
///
/// Read at the point of use (the same place the scheme is validated), so it covers every
/// path that talks to the server: the periodic pass, `syncNow`, device registration, the
/// device list, device removal, and the `/healthz` probe.
pub fn sync_allow_insecure<R: Runtime>(app: &AppHandle<R>) -> bool {
    load(app)
        .get("syncAllowInsecure")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Settings that must NEVER enter the sync projection, and are ignored when a peer's record
/// claims them — they are *this device's* decision and no other device may make it for us.
///
/// `syncAllowInsecure` is the motivating case. `syncServerUrl` is an ordinary synced setting,
/// so a peer that can write it can already point this device at any endpoint it likes. If the
/// waiver synced alongside it, one poisoned pair of records — a `syncServerUrl` of
/// `http://evil.example` and a `syncAllowInsecure` of true — would walk this device onto a
/// plaintext server, turning a remote setting write into a silent transport downgrade.
/// Keeping the waiver local means the downgrade can only ever be the result of a human
/// ticking a box on this device.
///
/// Enforced at all three write/apply points: `record_change` (local edits), the
/// `ensure_sync_projection` migration seed, and `apply_synced` (inbound peer records).
const LOCAL_ONLY_KEYS: &[&str] = &["syncAllowInsecure"];

/// True for keys excluded from the sync projection by [`LOCAL_ONLY_KEYS`].
fn is_local_only(key: &str) -> bool {
    LOCAL_ONLY_KEYS.contains(&key)
}

/// The sync interval in seconds (default 300 = 5 minutes). 0 disables periodic sync.
pub fn sync_interval_sec<R: Runtime>(app: &AppHandle<R>) -> u64 {
    load(app)
        .get("syncIntervalSec")
        .and_then(Value::as_u64)
        .unwrap_or(300)
}

/// Minutes a background tab may idle before discard (0 disables). Default 30.
pub fn tab_idle_timeout_min(app: &AppHandle) -> u64 {
    load(app)
        .get("tabIdleTimeout")
        .and_then(Value::as_u64)
        .unwrap_or(30)
}

/// Milliseconds a background-created, never-activated tab may sit idle before discard.
/// Default 30000 (30 s). 0 disables the background-tab timeout.
pub fn background_tab_timeout_ms(app: &AppHandle) -> u64 {
    load(app)
        .get("backgroundTabTimeout")
        .and_then(Value::as_u64)
        .unwrap_or(30_000)
}

/// When the total tab count exceeds this threshold the idle sweep uses shorter
/// timeouts (halved) to reclaim memory faster. Default 20.
pub fn aggressive_sweep_threshold(app: &AppHandle) -> usize {
    load(app)
        .get("aggressiveSweepThreshold")
        .and_then(Value::as_u64)
        .unwrap_or(20) as usize
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

/// Defaults overlaid with any persisted values. Cached (see `SettingsCache`) so the hot
/// per-navigation getters don't re-read + re-parse the file each call; the cache is
/// invalidated on every write via `invalidate_cache`.
///
/// `pub(crate)` so a module test can read-modify-write the store the way `data::import` and the
/// sync merge do — `dispatch` takes a concrete (non-generic) `&AppHandle`, so it cannot be
/// driven from a `MockRuntime` test.
pub(crate) fn load<R: Runtime>(app: &AppHandle<R>) -> Value {
    let Some(cache) = app.try_state::<SettingsCache>() else {
        return read_from_disk(app);
    };
    if let Some(v) = cache.value.read().ok().and_then(|g| g.clone()) {
        return v;
    }
    // Capture the generation BEFORE reading the file. If a write lands while we parse, the
    // generation moves and we must not publish our pre-write result over the fresh value
    // (see `SettingsCache::generation`). Ordering is Relaxed, which is sufficient: the only
    // requirement is that this load is not reordered *after* the file read, and Relaxed still
    // forbids that within a single thread's program order.
    read_and_cache(app, &cache, || read_from_disk(app))
}

/// Read the settings and publish them into the cache **unless** a write landed while we were
/// reading. Split out of [`load`] so a test can land a write *inside* the read via the `read`
/// closure — that interleaving is the whole defect and it cannot be produced deterministically
/// any other way (two real threads would only hit it intermittently, i.e. a flaky test).
fn read_and_cache<R: Runtime>(
    _app: &AppHandle<R>,
    cache: &SettingsCache,
    read: impl FnOnce() -> Value,
) -> Value {
    let seen = cache.generation.load(Ordering::Relaxed);
    let s = read();
    if cache.generation.load(Ordering::Relaxed) == seen {
        if let Ok(mut g) = cache.value.write() {
            *g = Some(s.clone());
        }
    } // else: a write landed mid-read and already cleared the cache; publishing now would
      // resurrect the value it just replaced.
    s
}

/// The uncached read: defaults overlaid with whatever is on disk.
fn read_from_disk<R: Runtime>(app: &AppHandle<R>) -> Value {
    let mut s = defaults();
    if let Some(p) = store_path(app) {
        // read_value_with_backup recovers from settings.json.bak if the primary is corrupt
        // (instead of resetting every key to its default) and parses it just once.
        if let Some(saved) = crate::jsonstore::read_value_with_backup(&p) {
            merge(&mut s, &saved);
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
            if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
                eprintln!("[aegis] failed to persist sync records: {e}");
            }
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
            if is_local_only(k) {
                continue; // see LOCAL_ONLY_KEYS
            }
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
/// when the value is unchanged. Called per-key from `settings.set`. Generic over `R` so the
/// `LOCAL_ONLY_KEYS` guard below is reachable from the `MockRuntime` unit tests.
fn record_change<R: Runtime>(app: &AppHandle<R>, key: &str, value: &Value) {
    // Local-only settings are written to the flat file by `settings.set` but never become
    // sync records — a waiver one device grants must not grant itself on the others.
    if is_local_only(key) {
        return;
    }
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
            // Defense in depth against `LOCAL_ONLY_KEYS`: even a record that somehow reached
            // the projection (an older build, a hand-edited file) must not decide a local-only
            // setting on this device.
            if is_local_only(key) {
                continue;
            }
            if r.get("deleted").and_then(Value::as_bool).unwrap_or(false) {
                obj.remove(key); // → load() falls back to the default for this key
            } else if let Some(v) = r.get("value") {
                // A sync record is attacker-writable input: the account's sync root is all a
                // peer needs, and the record is replayed verbatim on every device. Without this
                // check a peer could set `homeUrl` to `file:///home/u/.ssh/id_rsa` — which
                // `home_url()` accepts, because it only checks that the string parses as a URL —
                // and the content webview would load that local file on every launch.
                //
                // `settings.set` runs the same validator, so enforcing it here is what makes the
                // allowlist an actual invariant rather than a renderer-only courtesy. A record
                // that fails is skipped (leaving the local value) and logged: skipping is the
                // safe direction, since a rejected delete leaves a setting the user set, never
                // silently resets one.
                match validate_setting(key, v) {
                    Ok(()) => {
                        obj.insert(key.to_string(), v.clone());
                    }
                    Err(e) => {
                        eprintln!("[aegis] refusing synced setting {key:?}: {e}");
                    }
                }
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
    // Android: same pattern for antiFingerprint — the farble level global is read by the
    // NativeFarble JNI getter (no AppHandle available there); re-push on every synced change.
    #[cfg(target_os = "android")]
    crate::farble::note_level(&crate::farble::level(app));
}

/// Handle `settings.*` channels. Returns `None` if not a settings channel.
/// Every key a renderer is allowed to write, with a validator for its value.
///
/// `settings.set` used to `merge()` whatever it was handed, so any key with any value was
/// accepted. That is two problems at once. It meant a key nobody intended to be
/// renderer-writable could be set (anything the module reads, including internal/sync-only
/// fields), and — more seriously — it meant a *value* was never checked, so a poisoned
/// `homeUrl` of `file:///home/u/.ssh/id_rsa` parses fine as a `Url` and is then loaded as the
/// home page on every launch, and an arbitrary `syncServerUrl`/`downloadDir` is followed
/// verbatim. And because `record_change` runs per key, a poisoned value is *synced* to the
/// user's other devices too, making it durable rather than a local accident.
///
/// The allowlist is an ALLOW list (unknown keys are rejected), so adding a setting means
/// adding a validator here — which is the point: a new setting is not silently writable
/// until someone has decided what a valid value is.
///
/// `pub(crate)` so the two *other* inbound-value paths reach the same rules: `apply_synced`
/// (a peer's sync record) and `data::import` (a pasted/imported bundle). Neither goes through
/// `settings.set`, so before they were wired in here the allowlist guarded only the renderer.
pub(crate) fn validate_setting(key: &str, v: &Value) -> Result<(), String> {
    // Helper: require an absolute, non-`file:` URL. `file:` in particular is reachable from the
    // chrome webview and would let a compromised renderer turn the home page into a local file
    // read that re-loads on every launch.
    let http_url = |v: &Value, what: &str| -> Result<String, String> {
        let s = v
            .as_str()
            .ok_or_else(|| format!("{what} must be a string"))?;
        let t = s.trim();
        if t.is_empty() {
            return Err(format!("{what} must not be empty"));
        }
        let u = t
            .parse::<url::Url>()
            .map_err(|_| format!("{what} must be an absolute URL"))?;
        match u.scheme() {
            "http" | "https" => {}
            // about: is the legitimate "clear it" value for homeUrl.
            "about" if what == "homeUrl" => {}
            other => return Err(format!("{what} must be http(s), got {other:?}")),
        }
        Ok(t.to_string())
    };
    let bounded_u32 = |v: &Value, lo: i64, hi: i64, what: &str| -> Result<(), String> {
        let n = v
            .as_i64()
            .ok_or_else(|| format!("{what} must be a number"))?;
        if !(lo..=hi).contains(&n) {
            return Err(format!("{what} must be {lo}..={hi}"));
        }
        Ok(())
    };
    let one_of = |v: &Value, allowed: &[&str], what: &str| -> Result<(), String> {
        let s = v
            .as_str()
            .ok_or_else(|| format!("{what} must be a string"))?;
        if allowed.contains(&s) {
            Ok(())
        } else {
            Err(format!("{what} must be one of {allowed:?}"))
        }
    };
    let boolean = |v: &Value, what: &str| -> Result<(), String> {
        if v.is_boolean() {
            Ok(())
        } else {
            Err(format!("{what} must be a boolean"))
        }
    };

    match key {
        "homeUrl" => {
            http_url(v, "homeUrl")?;
        }
        // A search *template* is interpolated with the query, so it must be an http(s) URL and
        // must contain the placeholder — a template without `%s` sends every query nowhere.
        "defaultSearchTemplate" => {
            let t = http_url(v, "defaultSearchTemplate")?;
            if !t.contains("%s") {
                return Err("defaultSearchTemplate must contain %s".into());
            }
        }
        "syncServerUrl" => {
            // Empty clears it. Non-empty is validated for SHAPE here; the https-unless-loopback
            // rule is enforced at point of use in `sync::validated_base`, because this field is
            // also settable via an imported bundle and a sync record.
            if v.as_str().is_some_and(|s| s.trim().is_empty()) {
                return Ok(());
            }
            http_url(v, "syncServerUrl")?;
        }
        // A download directory is a *path*, not a URL: it must be absolute and must not contain
        // a NUL (which would truncate the path at the syscall boundary on unix).
        "downloadDir" => {
            let s = v
                .as_str()
                .ok_or("downloadDir must be a string")?
                .trim()
                .to_string();
            if !s.is_empty() {
                if s.contains('\0') {
                    return Err("downloadDir must not contain NUL".into());
                }
                let p = std::path::Path::new(&s);
                if !p.is_absolute() {
                    return Err("downloadDir must be an absolute path".into());
                }
            }
        }
        // Free-form but bounded: it is rendered as CSS, so cap the length and require it to
        // look like a CSS colour rather than an arbitrary token stream.
        "primaryColor" => {
            let s = v
                .as_str()
                .ok_or("primaryColor must be a string")?
                .trim()
                .to_string();
            if s.is_empty() {
                return Ok(()); // "use the default"
            }
            if s.len() > 32 {
                return Err("primaryColor is too long".into());
            }
            let hexish = s.strip_prefix('#').unwrap_or(&s);
            if hexish.is_empty()
                || !hexish.chars().all(|c| c.is_ascii_hexdigit())
                || !matches!(hexish.len(), 3 | 4 | 6 | 8)
            {
                return Err("primaryColor must be a #rgb/#rgba/#rrggbb/#rrggbbaa colour".into());
            }
        }
        "themeMode" => one_of(v, &["system", "dark", "light"], "themeMode")?,
        "antiFingerprint" => one_of(v, &["off", "standard", "strict"], "antiFingerprint")?,
        "webrtcPolicy" => one_of(v, &["default", "public-only", "disable"], "webrtcPolicy")?,
        "httpsOnly" => boolean(v, "httpsOnly")?,
        "hideChromeByDefault" => boolean(v, "hideChromeByDefault")?,
        "syncVault" => boolean(v, "syncVault")?,
        "syncAllowInsecure" => boolean(v, "syncAllowInsecure")?,
        "tabIdleTimeout" => bounded_u32(v, 0, 24 * 60, "tabIdleTimeout")?,
        "backgroundTabTimeout" => bounded_u32(v, 0, 24 * 60 * 60, "backgroundTabTimeout")?,
        "aggressiveSweepThreshold" => bounded_u32(v, 1, 10_000, "aggressiveSweepThreshold")?,
        "syncIntervalSec" => bounded_u32(v, 0, 7 * 24 * 60 * 60, "syncIntervalSec")?,
        "searchEngines" => {
            let arr = v.as_array().ok_or("searchEngines must be an array")?;
            if arr.len() > 32 {
                return Err("searchEngines may hold at most 32 entries".into());
            }
            for e in arr {
                // The field is `template`, NOT `url`. This validator used to require a `url`
                // key, which no producer has ever written: `defaults()` seeds
                // `{id, name, template}` (see the `searchEngines` default), `shared/types.ts`
                // declares `SearchEngine {id, name, template}`, and `SearchTab` builds exactly
                // that shape. The effect was that the validator rejected the app's OWN default
                // value, so every Add/Edit/Delete in Settings → Search failed with "each search
                // engine needs a url", a `data.import` bundle's engines were refused (and
                // reported as a refused setting), and — once `apply_synced` began running this
                // validator — a peer's engines could not sync either. The autopilot spec that
                // drives that form only asserts `settings.set` was *called* with the array, so
                // the rejection never showed up as a test failure.
                let field = |k: &str| -> Result<&str, String> {
                    let s = e
                        .get(k)
                        .and_then(Value::as_str)
                        .ok_or_else(|| format!("each search engine needs a {k}"))?;
                    if s.trim().is_empty() {
                        return Err(format!("search engine {k} must not be empty"));
                    }
                    // `id` is slugified into component keys and `name`/`template` are rendered
                    // as text; cap both so a peer cannot use this array as unbounded storage.
                    if s.len() > 200 {
                        return Err(format!("search engine {k} is too long"));
                    }
                    Ok(s)
                };
                field("id")?;
                field("name")?;
                // A template is interpolated with the query, so — exactly like
                // `defaultSearchTemplate` — it must be an http(s) URL and must carry the
                // placeholder. A template without `%s` sends every query nowhere.
                let t = field("template")?;
                let u = t
                    .parse::<url::Url>()
                    .map_err(|_| "search engine template must be an absolute URL")?;
                if !matches!(u.scheme(), "http" | "https") {
                    return Err("search engine template must be http(s)".into());
                }
                if !t.contains("%s") {
                    return Err("search engine template must contain %s".into());
                }
            }
        }
        // `proxy` is an object validated field-by-field in `proxy.rs::set_config` (it has its
        // own, stricter rules incl. the host charset that keeps Windows arg injection out), so
        // only its presence is checked here.
        "proxy" => {
            if !v.is_object() {
                return Err("proxy must be an object".into());
            }
        }
        other => return Err(format!("unknown setting {other:?}")),
    }
    Ok(())
}

/// Test-only shim so the settings allowlist can be exercised directly, without standing up an
/// app and writing a settings file for every case.
#[cfg(test)]
pub(crate) fn validate_setting_for_test(key: &str, v: &Value) -> Result<(), String> {
    validate_setting(key, v)
}

/// Apply a `data.import` bundle's `settings` object.
///
/// Two defects lived at the old call site, which did `write(app, bundle_settings)`:
///
/// 1. **No validation.** The bundle is pasted JSON from the renderer field, so it reaches
///    `home_url()`, `download_dir()` etc. exactly like a peer record does. `homeUrl` set to a
///    `file://` URL loads a local file as the home page on every launch, because `home_url()`
///    only checks that the string parses as a URL.
/// 2. **Wholesale replace.** `write` overwrites the whole file with *only* the bundle's keys,
///    and `load` then overlays the rest from `defaults()`. So a bundle carrying a single key
///    silently reset `homeUrl`, `httpsOnly`, `webrtcPolicy`, `proxy`, `syncServerUrl`,
///    `downloadDir`, `syncVault` and `antiFingerprint` to their defaults. The stores in the
///    same bundle are imported key-by-key ("partial bundles are valid"), so settings behaving
///    differently from every other store was also just inconsistent.
///
/// So: merge over the current values, and run each incoming key through the same allowlist
/// `settings.set` uses. Returns the keys that were refused, so the caller can report them
/// rather than silently dropping a poisoned or misspelled setting.
pub(crate) fn apply_imported<R: Runtime>(app: &AppHandle<R>, incoming: &Value) -> Vec<String> {
    let mut merged = load(app); // start from the CURRENT values, not defaults
    let mut refused = Vec::new();
    if let Some(obj) = incoming.as_object() {
        for (k, v) in obj {
            match validate_setting(k, v) {
                Ok(()) => {
                    if let Some(m) = merged.as_object_mut() {
                        m.insert(k.clone(), v.clone());
                    }
                }
                Err(e) => {
                    eprintln!("[aegis] refusing imported setting {k:?}: {e}");
                    refused.push(k.clone());
                }
            }
        }
    }
    write(app, &merged);
    // Rebuild the per-key sync projection from the post-merge flat settings.
    rebuild_projection_from_current(app);
    refused
}

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
                // Validate BEFORE merging, and reject the whole batch on the first bad entry so
                // a multi-field form write is all-or-nothing rather than half-applied.
                if let Some(obj) = partial.as_object() {
                    for (k, v) in obj {
                        if let Err(e) = validate_setting(k, v) {
                            return Some(Err(e));
                        }
                    }
                } else {
                    return Some(Err("partial must be an object".into()));
                }
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
            // The file changed — drop the cache so getters re-read the new values.
            invalidate_cache(app);
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
            // Android: keep the farble level global in sync — the NativeFarble JNI getter reads
            // it (no AppHandle). New tabs pick up the change; desktop reads settings directly.
            #[cfg(target_os = "android")]
            crate::farble::note_level(
                current
                    .get("antiFingerprint")
                    .and_then(Value::as_str)
                    .unwrap_or("off"),
            );
            Some(Ok(current))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    /// The settings cache must reflect a write: prime it with the defaults, write a new
    /// value, and the next read must see the new value (a stale cache would report the
    /// old one). Guards `invalidate_cache` on the `write()` path (import / sync-merge).
    #[test]
    fn settings_cache_reflects_writes() {
        with_tmp_app(|app| {
            // Prime the cache with the default httpsOnly = true.
            assert_eq!(load(app).get("httpsOnly"), Some(&json!(true)));
            // Write httpsOnly = false through the same path data-import / sync use.
            let mut next = load(app);
            next.as_object_mut()
                .unwrap()
                .insert("httpsOnly".into(), json!(false));
            write(app, &next);
            // Must observe the new value, not the primed-cache default.
            assert_eq!(load(app).get("httpsOnly"), Some(&json!(false)));
        });
    }

    fn rec(key: &str, wall: i64, value: Value) -> Value {
        json!({ "key": key, "uuid": key, "value": value,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "remote" }, "deleted": false })
    }

    /// `syncAllowInsecure` waives the https-or-loopback rule for the sync transport, so it
    /// must be a decision made ON this device — never a synced value. Since `syncServerUrl`
    /// IS synced, a waiver that travelled with it would let one poisoned pair of records
    /// walk a device onto a plaintext server. Assert all three enforcement points:
    /// the write, the outbound projection, and an inbound peer record.
    #[test]
    fn sync_allow_insecure_is_local_only() {
        with_tmp_app(|app| {
            // Default off, and the outbound projection carries no record for it.
            assert!(!sync_allow_insecure(app));
            assert!(!sync_records(app)
                .iter()
                .any(|r| r.get("key").and_then(Value::as_str) == Some("syncAllowInsecure")));

            // The user ticks the box: the allowlist accepts it, and it persists locally.
            // (`settings::dispatch` is bound to the Wry runtime, so this drives the exact
            // write + record_change pair that `settings.set` performs.)
            validate_setting_for_test("syncAllowInsecure", &json!(true)).expect("valid boolean");
            let mut next = load(app);
            next.as_object_mut()
                .unwrap()
                .insert("syncAllowInsecure".into(), json!(true));
            write(app, &next);
            record_change(app, "syncAllowInsecure", &json!(true));
            assert!(sync_allow_insecure(app), "the waiver must persist when set");

            // ...but never becomes a sync record (it would ride out to every other device).
            assert!(
                !sync_records(app)
                    .iter()
                    .any(|r| r.get("key").and_then(Value::as_str) == Some("syncAllowInsecure")),
                "the waiver must not enter the sync projection"
            );

            // A peer record claiming the waiver is ignored on apply, even with a fresh HLC.
            let poisoned = rec("syncAllowInsecure", i64::MAX, json!(false));
            apply_synced(app, &[poisoned]);
            assert!(
                sync_allow_insecure(app),
                "a peer's record must not be able to revoke or grant the waiver"
            );
        });
    }

    /// The validator must accept the app's OWN default value for every key it guards.
    ///
    /// This is not a style preference. The `searchEngines` arm used to require a `url` key
    /// while `defaults()`, `shared/types.ts` (`SearchEngine {id, name, template}`) and
    /// `SearchTab` all use `template` — so the validator rejected the shipped default, which
    /// made every Add/Edit/Delete in Settings → Search fail, made `data.import` refuse a
    /// bundle's engines, and (once `apply_synced` started calling this validator) stopped
    /// engines syncing at all. Nothing caught it: 1169 tests passed, because the autopilot
    /// spec that drives the form only asserts `settings.set` was *called*.
    ///
    /// Walking `defaults()` is the cheap generalisation — a default that the validator
    /// rejects is a latent "this feature is switched off and nobody knows why".
    #[test]
    fn every_default_value_passes_its_own_validator() {
        let d = defaults();
        let obj = d.as_object().expect("defaults() must be an object");
        assert!(!obj.is_empty(), "defaults() must not be empty");
        for (key, value) in obj {
            if let Err(e) = validate_setting_for_test(key, value) {
                panic!("defaults() value for `{key}` is rejected by its own validator: {e}");
            }
        }
    }

    /// A `load()` that started before a write must not overwrite the post-write value.
    ///
    /// `load` parses `settings.json` outside the cache lock (parsing is the expensive part
    /// and must not serialize the per-navigation getters), so without the generation check a
    /// reader that began before a write publishes its pre-write parse *after* the writer
    /// cleared the cache — and the fresh value is then gone with nothing left to invalidate
    /// it, so every later getter in the process returns the stale one. The sync engine's
    /// background thread writes settings while the main thread reads them, so the ordering
    /// is reachable.
    ///
    /// The write is injected through `read_and_cache`'s closure, which is exactly the window
    /// the guard exists for — a two-thread test would only hit it intermittently.
    #[test]
    fn a_load_that_races_a_write_does_not_cache_its_stale_parse() {
        with_tmp_app(|app| {
            let cache = app
                .try_state::<SettingsCache>()
                .expect("test app manages the cache");
            let key = "httpsOnly";
            let p = store_path(app).expect("app data dir");
            std::fs::create_dir_all(p.parent().unwrap()).unwrap();
            let put = |v: bool| {
                let mut d = defaults();
                d[key] = json!(v);
                std::fs::write(&p, serde_json::to_string_pretty(&d).unwrap()).unwrap();
            };

            put(true); // the value a racing reader is about to parse
                       // The read begins, and a write lands WHILE it is in flight.
            let raced = read_and_cache(app, &cache, || {
                put(false); // the writer's value hits disk…
                invalidate_cache(app); // …and it clears the cache
                json!({ "httpsOnly": true }) // the reader is still holding the pre-write parse
            });
            assert_eq!(
                raced["httpsOnly"].as_bool(),
                Some(true),
                "the reader must still RETURN what it read; only caching is refused"
            );
            assert_ne!(
                cache.generation.load(Ordering::Relaxed),
                0,
                "invalidate_cache must move the generation, or this test proves nothing"
            );
            assert!(
                cache.value.read().unwrap().is_none(),
                "a read that raced a write must NOT cache its stale parse — caching it would \
                 pin the pre-write value for the rest of the process"
            );
            // And because the cache was left empty, the next load re-reads the writer's value.
            assert_eq!(load(app)[key].as_bool(), Some(false));
        });
    }

    /// The complement, and the guard against "fixing" the race by never caching: a read with
    /// no intervening write must populate the cache, or every per-navigation getter is back on
    /// the disk path (the reason `SettingsCache` exists at all).
    #[test]
    fn a_load_with_no_intervening_write_still_populates_the_cache() {
        with_tmp_app(|app| {
            let cache = app
                .try_state::<SettingsCache>()
                .expect("test app manages the cache");
            let stored = read_and_cache(app, &cache, defaults);
            assert!(
                cache.value.read().unwrap().as_ref() == Some(&stored),
                "an uncontended read must populate the cache"
            );
        });
    }

    /// `searchEngines` entries are `{id, name, template}` and the template is interpolated
    /// with the query, so it carries the same rules as `defaultSearchTemplate`.
    #[test]
    fn search_engine_entries_are_validated_by_their_real_shape() {
        let ok = json!([{ "id": "my-engine", "name": "Mine", "template": "https://s.test/?q=%s" }]);
        validate_setting_for_test("searchEngines", &ok).expect("the real shape must validate");

        // The field is `template`; an entry carrying only the old `url` spelling is refused
        // rather than half-understood.
        for (what, bad) in [
            (
                "missing template",
                json!([{ "id": "a", "name": "A", "url": "https://s.test/?q=%s" }]),
            ),
            (
                "missing id",
                json!([{ "name": "A", "template": "https://s.test/?q=%s" }]),
            ),
            (
                "missing name",
                json!([{ "id": "a", "template": "https://s.test/?q=%s" }]),
            ),
            (
                "no %s placeholder",
                json!([{ "id": "a", "name": "A", "template": "https://s.test/" }]),
            ),
            (
                "non-http template",
                json!([{ "id": "a", "name": "A", "template": "javascript:alert(1)//%s" }]),
            ),
            (
                "empty name",
                json!([{ "id": "a", "name": "  ", "template": "https://s.test/?q=%s" }]),
            ),
        ] {
            assert!(
                validate_setting_for_test("searchEngines", &bad).is_err(),
                "searchEngines must reject: {what}"
            );
        }
    }

    /// A sync record is attacker-writable input: holding the account's sync root is all a peer
    /// needs, and its records are applied verbatim on every device. So `apply_synced` must run
    /// the same allowlist `settings.set` does — otherwise a peer sets `homeUrl` to a `file:`
    /// URL, which `home_url()` happily parses, and the content webview loads a local file on
    /// every launch. This is the remote-write half of the pair; `data::import`'s tests cover
    /// the pasted-bundle half.
    #[test]
    fn a_peer_record_cannot_write_a_value_the_allowlist_rejects() {
        with_tmp_app(|app| {
            write(app, &json!({ "homeUrl": "https://keepme.test/" }));

            // A `file:` home page: accepted by `Url::parse`, refused by the allowlist.
            apply_synced(app, &[rec("homeUrl", 9, json!("file:///etc/passwd"))]);
            assert_eq!(
                all(app).get("homeUrl").and_then(Value::as_str),
                Some("https://keepme.test/"),
                "a peer's record must not be able to turn the home page into a local file"
            );

            // A download directory the allowlist accepts only if absolute + NUL-free.
            // Asserted against the default (`load` overlays defaults, so the key is present
            // as "" rather than absent) — what matters is that the peer's value didn't land.
            apply_synced(app, &[rec("downloadDir", 9, json!("relative/evil"))]);
            assert_eq!(
                all(app).get("downloadDir").and_then(Value::as_str),
                Some(""),
                "a peer's record must not write a relative downloadDir"
            );

            // An unknown key — the allowlist is an ALLOW list, so this is rejected too.
            apply_synced(app, &[rec("someNewSetting", 9, json!("x"))]);
            assert!(
                all(app).get("someNewSetting").is_none(),
                "a peer's record must not invent a new setting"
            );

            // A legitimate peer write still lands — the guard is not simply refusing everything.
            apply_synced(app, &[rec("homeUrl", 10, json!("https://peer.test/"))]);
            assert_eq!(
                all(app).get("homeUrl").and_then(Value::as_str),
                Some("https://peer.test/"),
                "a valid peer value must still be applied"
            );
        });
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
