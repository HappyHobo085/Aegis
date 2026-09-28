//! Persistent settings (settings.* IPC). Stored as JSON in the app data dir —
//! a single config object doesn't need a DB. Lists (favorites/history/…) get a
//! real store in Phase 2; settings staying JSON is fine and keeps this contained.
use std::path::PathBuf;
// `AtomicBool` is only used by the Android mirror, so it carries the SAME cfg the global does.
// Gated rather than `allow(dead_code)`d because the absence of a reader off Android is the
// truth, and because CI injects `-D warnings` from outside the repo.
#[cfg(any(target_os = "android", test))]
use std::sync::atomic::AtomicBool;
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

/// Android-only: the HTTPS-Only policy the JNI getter reads. Mirrors the stored
/// `httpsOnly` setting so `MainActivity.secureUrl` (which has no `AppHandle`) can honour
/// the user's choice instead of hardcoding the upgrade.
///
/// **`true` is the fail-safe default, deliberately.** The desktop reader
/// ([`https_only`]) also defaults to `true` when the key is absent, and this global has a
/// strictly worse failure mode: a missed or failed boot push, or a JNI call that cannot
/// ask, would leave Android either upgrading plain-HTTP intranet hosts the user explicitly
/// asked it not to (if `false`) or — far worse — silently downgrading the HTTPS-Only
/// protection the user relies on (if the default were `false`). A policy check that
/// cannot be evaluated must keep enforcing.
///
/// An `AtomicBool` rather than farble's `RwLock<Vec<String>>`: there is no collection to
/// guard and no lock to take on a per-navigation path.
/// The value [`ANDROID_HTTPS_ONLY`] starts at, and the value a failed JNI call falls back to.
///
/// Named so it can be ASSERTED rather than being a bare literal twice: a future edit that
/// flips one and not the other is exactly the kind of drift that quietly turns a
/// protection off. The test asserts this constant, because a shared-process test binary
/// cannot observe the live global's initial value — a sibling test may already have pushed
/// to it.
#[cfg(any(target_os = "android", test))]
const HTTPS_ONLY_FAIL_SAFE: bool = true;

#[cfg(any(target_os = "android", test))]
static ANDROID_HTTPS_ONLY: AtomicBool = AtomicBool::new(HTTPS_ONLY_FAIL_SAFE);

/// Push the stored HTTPS-Only policy into the Android JNI global.
///
/// Called from [`write`] — the single low-level writer, which every path funnels through
/// (`settings.set`, an imported `data.import` bundle, and the synced-apply path) — and once
/// at boot from `lib.rs` next to `webrtc_shim::note_policy`, because the value can already
/// be on disk before any process starts.
#[cfg(any(target_os = "android", test))]
pub fn note_https_only(on: bool) {
    ANDROID_HTTPS_ONLY.store(on, Ordering::Relaxed);
}

/// Whether Android should upgrade `http:` navigations to `https:`, for the JNI getter.
#[cfg(any(target_os = "android", test))]
pub fn android_https_only() -> bool {
    ANDROID_HTTPS_ONLY.load(Ordering::Relaxed)
}

/// Overwrite the settings file (for data import). Durable (atomic temp→rename + .bak).
///
/// The single low-level writer, so it deliberately does NOT take the store lock: its two
/// production callers ([`apply_synced`], [`apply_imported`]) already hold it and the lock is
/// not reentrant.
///
/// Returns whether the file now holds `value`. It USED to return nothing and only
/// `eprintln!` a failure, and both callers carried on as if it had landed: each one then
/// ADVANCES the per-key sync projection past a write that never happened. Since
/// [`merge_projection`] only re-applies a record whose HLC beats the local one, the peer's
/// value is never re-applied on this device again — permanently, silently, with the only
/// trace a line on stderr nobody reads. The projection has to be able to see the truth, so
/// the writer has to report it.
pub fn write<R: Runtime>(app: &AppHandle<R>, value: &Value) -> Result<(), String> {
    let Some(p) = store_path(app) else {
        return Err("no app data dir".to_string());
    };
    // `unwrap_or_default()` here meant a serialization failure wrote an EMPTY settings file
    // and reported success. `Value` always serializes, so this cannot happen in practice —
    // which is exactly why the old shape was free to lie.
    let txt = serde_json::to_string_pretty(value).map_err(|e| e.to_string())?;
    crate::jsonstore::write_atomic(&p, txt.as_bytes()).map_err(|e| {
        eprintln!("[aegis] failed to persist settings: {e}");
        e.to_string()
    })?;
    // Mirror the policy into the Android JNI global on every write. See the type's doc for
    // why this is the ONE place to hook: `write` is the single low-level writer, so a
    // local edit, an imported bundle and a synced record all refresh the getter.
    #[cfg(any(target_os = "android", test))]
    note_https_only(https_only(app));
    // The file changed — drop the cache so getters re-read the new values. Only on success:
    // nothing changed on disk, so the cache is still correct.
    invalidate_cache(app);
    Ok(())
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
///
/// Generic over `R` so the Android mirror in [`write`] can read it on any runtime. It was
/// concrete-`&AppHandle` before, which is why it carried a cfg-scoped `allow(dead_code)` for
/// Android while the policy was in fact read on every platform — just never from a test.
pub fn https_only<R: Runtime>(app: &AppHandle<R>) -> bool {
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

/// Every accepted `webrtcPolicy` value, in one place.
///
/// Shared by the `settings.set` validator and by [`webrtc_policy`]'s clamp. Two
/// lists is how `file:` reached `tabs.json` in the first place, and it is why
/// `LOCAL_ONLY_KEYS` needs a test that asserts its exact membership.
pub const WEBRTC_POLICIES: &[&str] = &["default", "public-only", "disable"];

/// The WebRTC IP-leak policy: "default" | "public-only" | "disable" (default
/// "public-only"). Single source for the shim builder + the native backstops.
///
/// **Clamped, deliberately, in the fail-safe direction.** `validate_setting`
/// rejects an unknown value for a local `settings.set`, but a value can also
/// arrive through an imported `data.import` bundle or a SYNCED settings record,
/// and either writes the store directly. Every consumer of this function fails
/// OPEN on a value it does not recognise:
///
/// * `webrtc_shim::shim_for_inner` returns `""` — no shim at all, so the page
///   learns the real local IPs;
/// * the Windows Chromium `--force-webrtc-ip-handling-policy` arg is omitted,
///   leaving Chromium's default policy, which also leaks;
/// * the WebKitGTK backstop only enforces `disable`, so anything else leaves
///   WebKit's own WebRTC on.
///
/// So an unrecognised stored value silently switched the IP-leak defence OFF on
/// every platform, and a single record on any device holding the account data
/// key was enough to do it on all of them. `"public-only"` is the clamp target
/// because it is the app's own default AND the protective tier; `"default"` is a
/// documented deliberate opt-out, so it must stay distinguishable from "corrupt"
/// — hence the membership test against [`WEBRTC_POLICIES`] rather than a blanket
/// "anything not public-only or disable is public-only".
pub fn webrtc_policy<R: Runtime>(app: &AppHandle<R>) -> String {
    let stored = load(app);
    let raw = stored
        .get("webrtcPolicy")
        .and_then(Value::as_str)
        .unwrap_or("public-only");
    if WEBRTC_POLICIES.contains(&raw) {
        raw.to_string()
    } else {
        eprintln!("[aegis-settings] unrecognised webrtcPolicy {raw:?}; using \"public-only\"");
        "public-only".to_string()
    }
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
/// Every synced setting is writable by any device holding the account's data key, so "a peer
/// record could set this" is not a hypothetical: it is exactly what the sync contract grants.
/// Both keys here are therefore switches whose flipped state moves data OFF this machine or
/// makes it less private, and neither has any UI that would report a sync event as the cause.
///
/// `syncAllowInsecure` waives the https-or-loopback rule for the sync transport.
/// `syncServerUrl` is an ordinary synced setting, so a peer that can write it can already
/// point this device at any endpoint it likes. If the waiver synced alongside it, one poisoned
/// pair of records — a `syncServerUrl` of `http://evil.example` and a `syncAllowInsecure` of
/// true — would walk this device onto a plaintext server, turning a remote setting write into a
/// silent transport downgrade. Keeping the waiver local means the downgrade can only ever be
/// the result of a human ticking a box on this device.
///
/// `syncVault` decides whether the user's PASSWORDS leave this machine at all, and shares the
/// mechanism: one record on one paired device would turn on credential upload for every device
/// the user owns, silently. Its per-device cost is already paid elsewhere and documented —
/// `shared/types.ts` states that the flag is not sufficient on its own, because a vault created
/// with its own per-device salt cannot sync until it adopts the account's shared salt, and
/// until then `VaultState.syncEnabled` is false. A local opt-in is what the design already
/// required in substance; this makes the switch itself match.
///
/// Enforced at all three write/apply points: `record_change` (local edits), the
/// `ensure_sync_projection` migration seed, and `apply_synced` (inbound peer records). A key
/// filtered at only some of them still leaks through the others, so all three are asserted.
const LOCAL_ONLY_KEYS: &[&str] = &["syncAllowInsecure", "syncVault"];

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

// Depth of the settings store lock held by THIS thread.
//
// A `//` comment, not `///`: this sits on a `thread_local!` macro invocation, and rustdoc
// does not document macro invocations, so `///` here is an `unused_doc_comments` warning —
// i.e. a build failure under the `-D warnings` CI injects from outside the repo.
//
// `jsonstore::with_store_lock` is a `parking_lot::Mutex`, so taking it twice on one thread
// DEADLOCKS rather than erroring. The locked regions below call each other by design
// (`merge_remote` -> `apply_synced`, `apply_local` -> `record_change`), so the invariant is
// "one level only" — and it is a hand-maintained one, because adding a store lock is a
// routine-looking edit. This counter turns a violation into a clear panic in `cargo test`
// instead of a suite that hangs and reads like a slow build.
#[cfg(test)]
thread_local! {
    static SETTINGS_LOCK_DEPTH: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

/// Fail if a settings inner worker is called WITHOUT the lock held.
///
/// Every function documented as "MUST be called under [`with_settings_store_lock`]" calls
/// this. Those are unlocked on purpose — they are the inner workers of a locked region, and
/// the mutex is not reentrant — so the risk is not a hang here but the reverse: a future
/// caller reaching one of them directly, silently running an unprotected read-modify-write.
/// That is exactly how this defect existed in the first place, so the invariant is checked
/// rather than trusted.
///
/// `debug_assert` is the right gate (this is about correctness, not memory safety) and every
/// locked region is exercised by `cargo test`, so a violation is caught in CI.
#[inline]
fn assert_holding_settings_lock(what: &str) {
    #[cfg(test)]
    SETTINGS_LOCK_DEPTH.with(|d| {
        debug_assert!(
            d.get() >= 1,
            "{what} is an inner worker: it MUST be called INSIDE with_settings_store_lock, or \
             its read-modify-write runs unprotected. Only {what}'s locked caller may call it."
        );
    });
    #[cfg(not(test))]
    let _ = what;
}

/// Run `f` holding the per-store lock for the settings file and the projection file.
///
/// Two files are read-modify-written here — `settings.json` (via [`store_path`]) and
/// `settings-sync.json` (via [`sync_path`]) — and `settings.set` on the main thread, the sync
/// worker's [`merge_remote`], and a `data.import` can all be in flight at once. Without this,
/// two writers both read the old state and the second write silently discards the first:
/// a setting the user just ticked reverts with nothing logged.
///
/// The lock name is `"settings"`, which is deliberately NOT one of
/// `sync_stores::SYNCABLE` (`favorites`, `saved`, `allowlist`) — the settings namespace is
/// merged by its own closure in `sync.rs`, not by `sync_stores::merge_into`, so the two
/// never contend on the same name by accident.
fn with_settings_store_lock<T>(f: impl FnOnce() -> T) -> T {
    #[cfg(test)]
    SETTINGS_LOCK_DEPTH.with(|d| {
        debug_assert_eq!(d.get(), 0, "with_settings_store_lock is not reentrant");
        d.set(d.get() + 1);
    });
    let out = crate::jsonstore::with_store_lock("settings", f);
    #[cfg(test)]
    SETTINGS_LOCK_DEPTH.with(|d| d.set(d.get() - 1));
    out
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

/// The per-key projection, read WITHOUT the lazy-migration side effect.
///
/// [`sync_records`] calls `ensure_sync_projection`, which WRITES `settings-sync.json` on first
/// use. That is right for the sync path but wrong for the boot-time HLC-clock seed
/// (`sync_stores::seed_hlc_clock`): a reader that persists would make "read the highest stamp
/// this device has" depend on — and perturb — the very state it is trying to read. A projection
/// file that does not exist yet simply contributes no stamps, which is correct: a key that has
/// never been synced cannot hold a stamp that beats a local edit.
pub fn sync_records_readonly<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    load_sync_records(app)
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
///
/// MUST be called under [`with_settings_store_lock`]: it WRITES on the first-use path, so it
/// is a read-modify-write. Every caller ([`merge_remote`], [`apply_local`] via
/// [`record_change`], [`rebuild_projection_from_current`]) already holds the lock. Do NOT add
/// a lock here. [`sync_records_readonly`] is the deliberately unwrapped reader.
fn ensure_sync_projection<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    assert_holding_settings_lock("ensure_sync_projection");
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
///
/// MUST be called under [`with_settings_store_lock`]: the UNLOCKED inner worker of
/// [`apply_local`], which holds the lock. Do NOT add a lock here — see
/// [`assert_holding_settings_lock`].
fn record_change<R: Runtime>(app: &AppHandle<R>, key: &str, value: &Value) {
    assert_holding_settings_lock("record_change");
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
///
/// The whole body runs under the store lock, because the projection it reads
/// ([`ensure_sync_projection`]) and the flat file [`apply_synced`] writes are the same two
/// files `settings.set` is mid-way through rewriting. `apply_synced` is therefore the
/// UNLOCKED inner worker called from here — never lock it as well.
pub fn merge_remote<R: Runtime>(app: &AppHandle<R>, remote: &[Value]) -> Vec<String> {
    with_settings_store_lock(|| {
        let node = crate::sync_identity::node_id(app);
        for r in remote {
            if let Some(h) = crate::sync_envelope::from_value(r) {
                crate::sync_envelope::observe(&node, crate::jsonstore::now_ms(), &h);
            }
        }
        let (merged, changed) = merge_projection(ensure_sync_projection(app), remote);
        if changed.is_empty() {
            return Vec::new();
        }
        if !apply_synced(app, &merged) {
            // The flat write failed, so the projection was deliberately NOT advanced (see
            // `apply_synced`). Two consequences, both wanted: these keys genuinely did not
            // change, so no `sync.changed` event is owed; and the peer's record still wins the
            // next merge, so a transient failure (a full disk, a read-only mount) heals on the
            // next pass instead of being lost for good.
            return Vec::new();
        }
        changed
    })
}

/// The per-key sync records (for the merge seam / export). Migrates lazily on first call.
///
/// Locked despite the name: this looks like a reader, but `ensure_sync_projection` PERSISTS
/// `settings-sync.json` on first use, so it is a read-modify-write like every other region.
/// The sync engine calls it on the PULL side (`sync.rs`) as a closure, on the same thread
/// that later calls `merge_remote` — sequential, never nested.
pub fn sync_records<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    with_settings_store_lock(|| {
        assert_holding_settings_lock("ensure_sync_projection");
        ensure_sync_projection(app)
    })
}

/// Wipe + rebuild the per-key projection from the current flat settings — used after a
/// data import replaces the flat file, so the projection reflects the imported values
/// (with fresh HLCs) rather than the pre-import keys.
pub fn rebuild_projection_from_current<R: Runtime>(app: &AppHandle<R>) {
    assert_holding_settings_lock("rebuild_projection_from_current");
    save_sync_records(app, &[]);
    let _ = ensure_sync_projection(app);
}

/// Apply merged per-key records back into the flat settings file: write each live key's
/// value, or REMOVE a tombstoned key so `load()` falls to its default (= "reset to
/// default"). Consumed by F2b's merge. (Also rebuilds the projection from `records`.)
///
/// MUST be called under [`with_settings_store_lock`]: it is the UNLOCKED inner worker of
/// [`merge_remote`], which holds the lock. Do NOT add a lock here — the store lock is not
/// reentrant and that would deadlock every sync pass. (`merge_remote` is its only caller;
/// the `#[should_panic]` test below proves the guard rather than the lock.)
///
/// Returns whether the flat settings file actually changed. The `write` → `save_sync_records`
/// order is the whole point: `save_sync_records` is what records "this peer's HLC has been
/// applied here", so running it after a FAILED write tells the next merge that the value is
/// already present when it is not, and the value is then never re-applied on this device.
/// Leaving the projection where it was makes the same record win again next pass, which is
/// the only self-healing direction available.
pub fn apply_synced<R: Runtime>(app: &AppHandle<R>, records: &[Value]) -> bool {
    assert_holding_settings_lock("apply_synced");
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
    if let Err(e) = write(app, &flat) {
        eprintln!("[aegis] settings did not land, leaving the sync projection untouched: {e}");
        return false;
    }
    // Only now is "this peer's record has been applied here" true.
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
    true
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
        // Refuse `user:password@host`. This is the one URL shape that makes a user read a
        // trusted name and be somewhere else: every browser strips userinfo from the address
        // bar, so `https://bank.example@evil.example/` displays as `evil.example/` and the
        // part the user should be reading is the part they never see. It is not cosmetic
        // here — `homeUrl` re-loads on every launch, and `syncServerUrl` is a request the
        // sync client makes, one that `syncAllowInsecure` may send in CLEARTEXT, so the
        // userinfo is a credential going to a host the setting never named. The authoritative
        // host is always `u.host_str()` regardless, which is why nothing downstream has to
        // know this was checked; the check is here so the CONFIGURATION can never hold one.
        //
        // Checked against the PARSED url rather than the raw string, so an `@` in a query or
        // a path (`?to=a@b.com`) is not a false positive — `Url` puts userinfo before the host
        // and nowhere else.
        if u.username() != "" || u.password().is_some() {
            return Err(format!(
                "{what} must not carry userinfo (`user:password@`) — it makes the address bar \
                 hide which host you are really going to"
            ));
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
        "webrtcPolicy" => one_of(v, WEBRTC_POLICIES, "webrtcPolicy")?,
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

/// Android JNI: `NativeSettings.httpsOnly()` — the HTTPS-Only policy for the navigation
/// chokepoint.
///
/// `MainActivity.secureUrl` is the single place every Android navigation decision passes
/// through, and it has no `AppHandle`, so it reads the [`ANDROID_HTTPS_ONLY`] global rather
/// than the settings file. Returns `true` (keep upgrading) if anything at all goes wrong:
/// a JNI getter that cannot answer must not be the reason a plain-HTTP page loads where the
/// user's policy said it should not.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol name
// means two libraries could export the same symbol, which the linker leaves undefined. That
// is inherent to every JNI entry point (Kotlin resolves the symbol by name), so it is allowed
// here explicitly rather than by the module scope — `deny(unsafe_code)` in lib.rs would
// otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeSettings_httpsOnly(
    _env: jni::JNIEnv<'_>,
    _this: jni::objects::JObject<'_>,
) -> jni::sys::jboolean {
    // Defensive guard: a panic must not unwind across the FFI boundary into Java, which is UB.
    // The body reads one atomic, so this cannot panic in practice — the guard is here because
    // "it cannot panic today" is exactly the claim that stops being true after the next edit,
    // and an FFI abort is not a recoverable failure mode. Uses the crate's shared `ffi_guard`,
    // the same one every other JNI export uses.
    //
    // On a panic the fallback is the PROTECTIVE value, not `false`: a getter that cannot read
    // policy must keep upgrading, or it silently drops HTTPS-Only protection for every later
    // navigation. (The ad-block JNI getters fail OPEN instead — there the protective direction
    // is to not block. Deliberately opposite, because the two defences protect against
    // different things.)
    match crate::ffi_guard(android_https_only) {
        Some(on) => on as jni::sys::jboolean,
        None => {
            eprintln!("[aegis-settings] httpsOnly getter panicked; keeping HTTPS-Only on");
            HTTPS_ONLY_FAIL_SAFE as jni::sys::jboolean
        }
    }
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
///
/// Locked for the whole body: a `data.import` rewriting `settings.json` while the main thread
/// is inside `settings.set`, or while the sync worker is merging, loses whichever write is not
/// last — with no error anywhere. `write` and `rebuild_projection_from_current` stay UNLOCKED
/// inner workers, because they are also called from `apply_synced` under a held lock.
///
/// `Err` means `settings.json` could not be written, and the projection was then left alone
/// deliberately: `rebuild_projection_from_current` wipes the projection and re-seeds it from
/// the CURRENT FILE, so running it after a failed write would not merely skip the import — it
/// would stamp the PRE-import values with FRESH, locally-invented HLCs, and a peer's newer
/// record would then lose to a stamp this device made up in its own failure path. The caller
/// (`data.import`) reports the `Err` through the same `failed` list the store writes use.
pub(crate) fn apply_imported<R: Runtime>(
    app: &AppHandle<R>,
    incoming: &Value,
) -> Result<Vec<String>, String> {
    with_settings_store_lock(|| {
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
        write(app, &merged)?;
        // Rebuild the per-key sync projection from the post-merge flat settings.
        rebuild_projection_from_current(app);
        Ok(refused)
    })
}

/// Apply a renderer `settings.set` payload: the local-edit read-modify-write region.
///
/// Extracted from the `dispatch` arm so the region is testable against a `MockRuntime` app
/// (`dispatch` is bound to the Wry runtime, so the arm could only be reached through a real
/// webview — which is why the lock this function needs had no direct test at all).
///
/// Holds the store lock for the whole region: it reads the projection, rewrites `settings.json`
/// and then upserts a record per key. The main thread reaches it on every settings form save
/// while the sync worker can be inside `merge_remote` and a `data.import` inside
/// [`apply_imported`], and all three rewrite the same two files.
pub(crate) fn apply_local<R: Runtime>(
    app: &AppHandle<R>,
    payload: &Value,
) -> Result<Value, String> {
    with_settings_store_lock(|| {
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
                    validate_setting(k, v)?;
                }
            } else {
                return Err("partial must be an object".into());
            }
            merge(&mut current, partial);
        }
        if let Some(p) = store_path(app) {
            match serde_json::to_string_pretty(&current) {
                Ok(txt) => {
                    if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
                        return Err(format!("write settings: {e}"));
                    }
                }
                Err(e) => return Err(e.to_string()),
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
        Ok(current)
    })
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "settings.get" => Some(Ok(load(app))),
        "settings.set" => Some(apply_local(app, payload)),
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
            write(app, &next).expect("filter/settings fixture write");
            // Must observe the new value, not the primed-cache default.
            assert_eq!(load(app).get("httpsOnly"), Some(&json!(false)));
        });
    }

    fn rec(key: &str, wall: i64, value: Value) -> Value {
        json!({ "key": key, "uuid": key, "value": value,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "remote" }, "deleted": false })
    }

    /// A URL carrying `user:password@` is the textbook way to make a user read a
    /// trusted name and be somewhere else. Browsers strip userinfo from the
    /// address bar, so `https://bank.example@evil.example/login` DISPLAYS as
    /// `evil.example/login` and every hover, every screenshot and every
    /// "the padlock is there" check points the other way — the trick only works
    /// because the user never sees the part they should be reading.
    ///
    /// Two concrete harms, both reachable here:
    ///
    /// * `homeUrl` re-loads on every launch, so the disguised host is the FIRST
    ///   page the user ever sees for that session.
    /// * `syncServerUrl` is a request the sync client makes, and
    ///   `syncAllowInsecure` may waive the https rule for it — so the userinfo
    ///   is a credential the user is sending in CLEARTEXT, to a host the setting
    ///   never named.
    #[test]
    fn a_url_carrying_userinfo_is_refused() {
        for key in ["homeUrl", "syncServerUrl", "defaultSearchTemplate"] {
            let mut with_user = json!("https://bank.example@evil.example/login");
            if key == "defaultSearchTemplate" {
                with_user = json!("https://bank.example@evil.example/s?q=%s");
            }
            let err = validate_setting_for_test(key, &with_user)
                .expect_err("a URL carrying userinfo must be refused");
            assert!(
                err.contains("userinfo"),
                "{key} must say WHY, so the user is not left guessing: {err}"
            );
            // A username with no password is still userinfo, and still a disguise.
            assert!(
                validate_setting_for_test(key, &with_user).is_err(),
                "{key} must not accept a bare username either"
            );
            // …and the same URL without the userinfo is fine, so the rule is
            // userinfo and not "URLs with an @" (a query string may contain one).
            let clean = json!("https://evil.example/s?q=%s@example.com");
            if key == "homeUrl" {
                validate_setting_for_test(key, &clean)
                    .unwrap_or_else(|e| panic!("an @ inside the query is not userinfo: {e}"));
            }
        }
        // A password with no username is the same shape and must be refused too.
        assert!(validate_setting_for_test("homeUrl", &json!("https://:pw@evil.example/")).is_err());
    }

    /// `syncVault` is the second local-only key, and the reason is the same one as
    /// `syncAllowInsecure` but with a worse outcome.
    ///
    /// Every synced setting is writable by any device holding the account's data key, so
    /// "a peer record could set this" is not a hypothetical — it is what the sync contract
    /// grants. `syncVault` is the switch that decides whether the user's PASSWORDS leave
    /// this machine. Letting it ride along would mean a single record on a single paired
    /// device turns on credential upload for every device the user owns, with nothing on
    /// screen to say so, and there is no UI anywhere that reports "your vault is being
    /// uploaded" as a consequence of a sync event.
    ///
    /// The per-device cost is already paid elsewhere and honestly: `shared/types.ts` documents
    /// that enabling this is not sufficient on its own, because a vault created with its own
    /// per-device salt cannot sync until it ADOPTS the account's shared salt, and until then
    /// `VaultState.syncEnabled` is false. So a local opt-in is what the design already
    /// required in substance; this makes the switch itself match.
    ///
    /// All three enforcement points are asserted, exactly as for the waiver above — a key
    /// filtered at only one of them would still leak through the other two.
    #[test]
    fn sync_vault_is_local_only() {
        with_tmp_app(|app| {
            // Default off, and the outbound projection carries no record for it.
            assert!(!sync_records(app)
                .iter()
                .any(|r| r.get("key").and_then(Value::as_str) == Some("syncVault")));

            // The user opts in locally: accepted, persisted, and still not a sync record.
            apply_local(app, &json!({ "partial": { "syncVault": true } }))
                .expect("a boolean is a valid syncVault");
            assert_eq!(
                load(app).get("syncVault"),
                Some(&json!(true)),
                "the local opt-in must persist when set"
            );
            assert!(
                !sync_records(app)
                    .iter()
                    .any(|r| r.get("key").and_then(Value::as_str) == Some("syncVault")),
                "the opt-in must not enter the sync projection"
            );

            // A peer record claiming it is ignored on apply, even with a fresh HLC.
            let poisoned = rec("syncVault", i64::MAX, json!(true));
            merge_remote(app, &[poisoned]);
            assert_eq!(
                load(app).get("syncVault"),
                Some(&json!(true)),
                "a peer's record must not be able to grant or revoke the opt-in"
            );
        });
    }

    /// The list itself, asserted directly. `sync_allow_insecure_is_local_only` and
    /// `sync_vault_is_local_only` each prove their own key end-to-end, but neither fails if
    /// someone adds a THIRD key to the list and forgets to write a test for it — and a new
    /// key with no test is exactly the shape of bug this list exists to prevent. An empty or
    /// filtered list must not pass either.
    #[test]
    fn the_local_only_list_is_exactly_the_two_credential_and_transport_waivers() {
        assert_eq!(
            LOCAL_ONLY_KEYS,
            &["syncAllowInsecure", "syncVault"],
            "a new LOCAL_ONLY_KEYS entry needs a test of its own here, and any key added \
             must be a device-local waiver — never a value the user expects to follow them"
        );
        assert!(!LOCAL_ONLY_KEYS.is_empty(), "a filtered list must not pass");
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
            // This drives the REAL `settings.set` region — the same `write` + `record_change`
            // pair the arm performs, under the store lock, via `apply_local`.
            apply_local(app, &json!({ "partial": { "syncAllowInsecure": true } }))
                .expect("a boolean is a valid syncAllowInsecure");
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
            merge_remote(app, &[poisoned]);
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
            write(app, &json!({ "homeUrl": "https://keepme.test/" }))
                .expect("filter/settings fixture write");

            // A `file:` home page: accepted by `Url::parse`, refused by the allowlist.
            merge_remote(app, &[rec("homeUrl", 9, json!("file:///etc/passwd"))]);
            assert_eq!(
                all(app).get("homeUrl").and_then(Value::as_str),
                Some("https://keepme.test/"),
                "a peer's record must not be able to turn the home page into a local file"
            );

            // A download directory the allowlist accepts only if absolute + NUL-free.
            // Asserted against the default (`load` overlays defaults, so the key is present
            // as "" rather than absent) — what matters is that the peer's value didn't land.
            merge_remote(app, &[rec("downloadDir", 9, json!("relative/evil"))]);
            assert_eq!(
                all(app).get("downloadDir").and_then(Value::as_str),
                Some(""),
                "a peer's record must not write a relative downloadDir"
            );

            // An unknown key — the allowlist is an ALLOW list, so this is rejected too.
            merge_remote(app, &[rec("someNewSetting", 9, json!("x"))]);
            assert!(
                all(app).get("someNewSetting").is_none(),
                "a peer's record must not invent a new setting"
            );

            // A legitimate peer write still lands — the guard is not simply refusing everything.
            merge_remote(app, &[rec("homeUrl", 10, json!("https://peer.test/"))]);
            assert_eq!(
                all(app).get("homeUrl").and_then(Value::as_str),
                Some("https://peer.test/"),
                "a valid peer value must still be applied"
            );
        });
    }

    /// A stored `webrtcPolicy` the validator would REJECT can still reach the reader: an
    /// imported `data.import` bundle and a synced settings record both write the store
    /// directly, and the synced path is reachable by any device holding the account's data
    /// key. `webrtc_shim::shim_for_inner` answers `""` — no shim at all — for any policy it
    /// does not recognise, so an unrecognised value silently switches the WebRTC IP-leak
    /// defence OFF. Asserted on the SHIM rather than on the reader's return value, because
    /// the shim is the thing the whole defence rests on and the reader is only a means.
    #[test]
    fn a_corrupt_webrtc_policy_must_still_produce_a_shim() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            for corrupt in [
                "Public-Only", // case-mangled
                "PUBLIC-ONLY",
                "public_only",
                "strict", // a REAL farble level, not a WebRTC one
                "none",
                " off",
                "", // empty, which is also what a non-string reads as
            ] {
                super::write(app, &json!({ "webrtcPolicy": corrupt }))
                    .expect("settings fixture write");
                let policy = super::webrtc_policy(app);
                let shim = crate::webrtc_shim::shim_for(&policy, false);
                assert!(
                    !shim.is_empty(),
                    "a stored webrtcPolicy of {corrupt:?} must not switch the WebRTC \
                     IP-leak defence off: the reader clamped it to {policy:?} and the shim \
                     builder returned nothing, so a page would learn the real local IPs"
                );
            }
        });
    }

    /// The clamp must not flatten a legitimate choice: both protective policies keep their own
    /// distinct artifact, and a valid stored value reaches the reader verbatim.
    #[test]
    fn a_valid_webrtc_policy_still_reaches_the_shim_unchanged() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            for (stored, expect_differs_from) in
                [("public-only", "disable"), ("disable", "public-only")]
            {
                super::write(app, &json!({ "webrtcPolicy": stored }))
                    .expect("settings fixture write");
                let policy = super::webrtc_policy(app);
                assert_eq!(policy, stored, "a valid policy must not be rewritten");
                let a = crate::webrtc_shim::shim_for(&policy, false);
                assert!(!a.is_empty(), "{stored} must produce its shim");
                let b = crate::webrtc_shim::shim_for(expect_differs_from, false);
                assert_ne!(
                    a, b,
                    "{stored} and {expect_differs_from} must stay distinct"
                );
            }
        });
    }

    /// `"default"` is a documented, deliberate opt-out ("do not interfere"), and the shim
    /// builder deliberately answers `""` for it. The clamp must keep that meaning: a clamp
    /// that mapped everything unrecognised to `"public-only"` would be correct, but one that
    /// simply forced every value to a protection level would quietly remove the user's only
    /// way to opt out. This is the test that stops the fix from over-reaching.
    #[test]
    fn the_default_webrtc_policy_still_means_do_not_interfere() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            super::write(app, &json!({ "webrtcPolicy": "default" }))
                .expect("settings fixture write");
            assert_eq!(
                super::webrtc_policy(app),
                "default",
                "the explicit opt-out must survive the clamp"
            );
            assert!(
                crate::webrtc_shim::shim_for("default", false).is_empty(),
                "\"default\" means Aegic does not touch WebRTC, so no shim is correct — and \
                 this must stay true, or the clamp has quietly removed the opt-out"
            );
        });
    }

    /// 8(7): the Rust half of the Android `httpsOnly` parity fix.
    ///
    /// `MainActivity.secureUrl` has no `AppHandle`, so the policy is mirrored into
    /// `ANDROID_HTTPS_ONLY` and read by a JNI getter. The observable property that matters is
    /// the FAIL-SAFE one: if the mirror is never seeded, or a JNI call cannot ask, HTTPS-Only
    /// must still be ON. Before the fix the Android upgrade was unconditional
    /// (`if (uri.scheme == "http" && !localhost)`), so a user who turned the setting OFF
    /// because they have a plain-HTTP intranet host had that host rewritten to https and the
    /// site simply broke.
    #[test]
    fn the_android_mirror_follows_the_stored_setting_in_both_directions() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            // Off must reach the mirror: this is the case the fix exists for.
            super::write(app, &json!({ "httpsOnly": false })).expect("settings fixture write");
            assert!(
                !android_https_only(),
                "a user who turned HTTPS-Only OFF must have that reach the Android mirror, or \
                 their plain-HTTP intranet host is rewritten to https and the site breaks"
            );
            // And back on: a one-way latch would be a different bug.
            super::write(app, &json!({ "httpsOnly": true })).expect("settings fixture write");
            assert!(
                android_https_only(),
                "turning HTTPS-Only back on must reach the mirror too"
            );
        });
    }

    /// The fail-safe default is asserted as a CONSTANT, not as the live global, and that is a
    /// deliberate limitation rather than laziness: a test binary shares one process, so any
    /// sibling test that has already pushed to the global makes the live initial value
    /// unobservable. Asserting the named initialiser is what the JNI getter's failure path
    /// reads, so it is the value that is actually load-bearing.
    #[test]
    fn a_lost_push_or_a_failed_jni_call_leaves_https_only_on() {
        assert!(
            std::hint::black_box(HTTPS_ONLY_FAIL_SAFE),
            "the fail-safe must be ON: a missed boot push or a JNI call that cannot ask must \
             never silently drop HTTPS-Only protection"
        );
        // The same default is what `note_https_only`/`android_https_only` round-trip, so a
        // push of the fail-safe value is observably the fail-safe value.
        note_https_only(HTTPS_ONLY_FAIL_SAFE);
        assert!(android_https_only());
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

    /// Eight renderer keys, one per thread, must ALL survive. The keys are deliberately
    /// distinct and none of them is in `LOCAL_ONLY_KEYS`, so every call does the full region:
    /// read the projection, rewrite `settings.json`, then upsert a sync record. A lost update
    /// is the whole failure mode here, and it is SILENT — both writers succeed, the second one
    /// just wrote a version of the file that never saw the first one's key.
    #[test]
    fn concurrent_settings_writes_lose_no_key() {
        const ROUNDS: usize = 3;
        // (key, value) pairs, all accepted by `validate_setting` and none local-only.
        let keys: [(&str, Value); 8] = [
            ("httpsOnly", json!(false)),
            ("hideChromeByDefault", json!(true)),
            ("tabIdleTimeout", json!(11)),
            ("backgroundTabTimeout", json!(22_222)),
            ("aggressiveSweepThreshold", json!(7)),
            ("syncIntervalSec", json!(600)),
            ("themeMode", json!("dark")),
            ("antiFingerprint", json!("standard")),
        ];

        with_tmp_app(|app| {
            let mut handles = Vec::new();
            for (key, value) in &keys {
                let app = app.clone();
                let (key, value) = (*key, value.clone());
                handles.push(std::thread::spawn(move || {
                    for _ in 0..ROUNDS {
                        let mut partial = serde_json::Map::new();
                        partial.insert(key.to_string(), value.clone());
                        apply_local(&app, &json!({ "partial": partial }))
                            .expect("every key in this table is a valid setting");
                    }
                }));
            }
            for h in handles {
                h.join().unwrap();
            }

            let after = load(app);
            for (key, value) in &keys {
                assert_eq!(
                    after.get(*key),
                    Some(value),
                    "{key} was lost: two callers read the same settings.json and the second \
                     write silently discarded the first"
                );
            }
        });
    }

    /// The settings store lock is a plain non-reentrant `parking_lot` mutex, and the locked
    /// regions call their inner workers by design. This pins the guard that makes a future
    /// double-take a clear panic instead of a hung suite — a hung `cargo test` is
    /// indistinguishable from a slow build, and CI would burn its whole budget on it.
    ///
    /// `test_support::lock()` recovers from poisoning (`unwrap_or_else(|p| p.into_inner())`),
    /// so the unwind through `with_tmp_app` does not cascade-fail the rest of the suite.
    #[test]
    #[should_panic(expected = "is an inner worker: it MUST be called INSIDE")]
    fn an_inner_worker_refuses_to_run_without_the_settings_lock() {
        with_tmp_app(|app| {
            // Reachable today only from a test — which is the point: if a future caller reaches
            // `record_change` (or `apply_synced`, `ensure_sync_projection`,
            // `rebuild_projection_from_current`) directly again, it would do an unprotected
            // read-modify-write of the same two files. That is the defect this commit removes.
            record_change(app, "themeMode", &json!("dark"));
        });
    }

    // ── a write that did not land must not be recorded as having landed ──

    /// The bug this pins: `apply_synced` used to call `save_sync_records` unconditionally, so a
    /// failed `settings.json` write still recorded the peer's HLC as "applied here".
    /// `merge_projection` then only re-applies a record whose HLC BEATS the local one, so that
    /// setting was never re-applied on this device again — permanently, silently, and across
    /// every later sync pass. `eprintln!` was the only trace.
    #[test]
    fn a_settings_write_that_fails_does_not_advance_the_sync_projection() {
        with_tmp_app(|app| {
            // A local edit, so the projection is materialized and httpsOnly differs from the
            // default — a merge that changes nothing would prove nothing.
            apply_local(app, &json!({ "partial": { "httpsOnly": false } })).expect("local edit");
            let before = load_sync_records(app);
            assert!(
                !before.is_empty(),
                "precondition: the projection must exist"
            );

            let blocked = crate::test_support::block_store_file(app, "settings.json");
            assert!(
                write(app, &json!({ "httpsOnly": true })).is_err(),
                "precondition: the flat write must actually fail for this test to test anything"
            );

            // A peer record that WINS the merge, so `apply_synced` is definitely reached.
            // Relative to the LOCAL record's own HLC, not an absolute constant: an absolute
            // wall clock loses to `now_ms()` (~1.8e12) the moment the seed starts ticking, and
            // the peer would silently stop winning — which would make every assertion below
            // pass for the wrong reason.
            let local_hlc = before
                .iter()
                .find(|r| r.get("key").and_then(Value::as_str) == Some("httpsOnly"))
                .and_then(crate::sync_envelope::from_value)
                .expect("the local edit must have a projection record for httpsOnly");
            let peer = vec![rec("httpsOnly", local_hlc.wall_ms + 10_000, json!(true))];
            let changed = merge_remote(app, &peer);
            assert!(
                changed.is_empty(),
                "nothing was written, so no key changed and no sync.changed event is owed — got {changed:?}"
            );
            assert_eq!(
                load_sync_records(app),
                before,
                "the projection must NOT record an HLC whose value never reached the file"
            );

            // The load-bearing consequence: with the projection untouched, the SAME peer record
            // wins again once the file can be written. Under the old shape it lost forever,
            // because the local projection claimed a value that was not on disk.
            crate::test_support::unblock_store_file(&blocked);
            assert_eq!(
                merge_remote(app, &peer),
                vec!["httpsOnly".to_string()],
                "the same record must still win after a transient write failure"
            );
            assert_eq!(
                load(app).get("httpsOnly"),
                Some(&json!(true)),
                "and the peer's value must actually be on disk this time"
            );
        });
    }

    /// `apply_imported` is the same defect with a nastier failure mode, and it is the reason
    /// `write` had to report at all: it runs `rebuild_projection_from_current` AFTER the write,
    /// and that wipes the projection and re-seeds it from the CURRENT FILE. Run after a failed
    /// write it would not merely skip the import — it would stamp the PRE-import values with
    /// FRESH, locally-invented HLCs, and a peer's genuinely newer record would then lose to a
    /// stamp this device made up inside its own failure path.
    #[test]
    fn a_settings_import_that_fails_leaves_the_projection_on_the_values_that_are_on_disk() {
        with_tmp_app(|app| {
            apply_local(app, &json!({ "partial": { "httpsOnly": false } })).expect("local edit");
            let before = load_sync_records(app);

            let blocked = crate::test_support::block_store_file(app, "settings.json");
            let outcome = apply_imported(app, &json!({ "httpsOnly": true }));
            assert!(
                outcome.is_err(),
                "a write that did not land must be reported, not returned as a clean import"
            );
            assert_eq!(
                load_sync_records(app),
                before,
                "the projection must not be re-seeded with fresh HLCs for values that never landed"
            );

            crate::test_support::unblock_store_file(&blocked);
            assert_eq!(
                apply_imported(app, &json!({ "httpsOnly": true })).expect("now it can land"),
                Vec::<String>::new(),
                "no key was refused, so the refusal list is empty"
            );
            assert_eq!(load(app).get("httpsOnly"), Some(&json!(true)));
        });
    }
}
