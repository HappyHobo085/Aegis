//! Tiny JSON-array store in the app data dir, backing the data repos (favorites,
//! saved, …). For personal-use data volumes a JSON file per collection is simpler
//! than a DB and good enough; each repo loads, mutates, and saves the whole array.
//!
//! Performance improvements:
//! - Simple cache for recent store accesses to reduce disk I/O
//! - Cached next_id calculation to avoid O(n) scans when data hasn't changed recently
//! - Batch operation support for multiple stores
//! - Optimized cleanup of temporary files
use std::collections::{HashMap, HashSet};
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;
use std::time::{SystemTime, UNIX_EPOCH};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use std::sync::LazyLock;

// Cache entry for storing recently accessed data
#[derive(Clone)]
struct CacheEntry {
    data: Vec<Value>,
    timestamp: Instant,
    // Used to hold a cached next-id. That field is gone with `next_id_optimized` (see
    // `next_id`): the cache answered from here while ignoring the items it was given, which
    // handed out the same id repeatedly and wiped the user's saved pages.
}

// Global cache for recent store accesses
static CACHE: LazyLock<::parking_lot::RwLock<HashMap<String, CacheEntry>>> =
    LazyLock::new(|| ::parking_lot::RwLock::new(HashMap::new()));
const CACHE_TTL_SEC: u64 = 30; // seconds
const MAX_CACHE_SIZE: usize = 5;

/// Clear all process-global caches. Called from `test_support::with_tmp_app`
/// so each test starts with a clean slate (the `CACHE` static survives across
/// `with_tmp_app` calls because it lives in a static, not per-app state).
#[cfg(test)]
pub fn clear_caches() {
    CACHE.write().clear();
}

fn path<R: Runtime>(app: &AppHandle<R>, name: &str) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join(format!("{name}.json")))
}

/// The recovery-copy path for `path` (e.g. `favorites.json` → `favorites.json.bak`).
fn bak_path(path: &Path) -> PathBuf {
    path.with_extension(format!(
        "{}bak",
        path.extension()
            .and_then(|e| e.to_str())
            .map(|e| format!("{e}."))
            .unwrap_or_default()
    ))
}

/// Process-global monotonic counter making every temp-file name unique within this
/// process, even for two threads writing the same store in the same nanosecond.
static TMP_SEQ: AtomicU64 = AtomicU64::new(0);

/// Durably write `bytes` to `path`: temp file (a sibling in the same dir) → fsync →
/// rename over the target → fsync the parent dir. When `backup` is set, the prior good
/// copy is kept at `<name>.bak` for corrupt-recovery. Temp-then-rename in the same
/// directory replaces an existing file and is the standard durable-write idiom —
/// strictly better than truncate-then-write (a crash mid-write can't leave a partial
/// target). `std::fs::rename` does not itself promise atomic replacement, so we don't
/// claim that — only that an interrupted write never corrupts the live file.
fn write_atomic_inner(path: &Path, bytes: &[u8], backup: bool) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    if backup && path.exists() {
        let _ = fs::copy(path, bak_path(path));
    }
    // The temp file must be unique per write so two concurrent writers (e.g. the sync
    // thread and the IPC thread in later phases) can never share one — a shared temp
    // would let one writer's rename pull the file out from under the other, silently
    // dropping a write. pid+nanos alone is NOT enough: two threads in THIS process share
    // the pid and can read the same nanosecond, so we add a process-global monotonic
    // counter (guarantees distinct names within the process) and create the file with
    // O_EXCL (`create_new`) so a stale leftover temp from a prior run can never be reused
    // — retrying with a fresh name if one ever exists.
    let (mut f, tmp) = {
        let mut attempt = 0;
        loop {
            let tmp = path.with_extension(format!(
                "{}.{}.{}.tmp",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .map(|d| d.as_nanos())
                    .unwrap_or(0),
                TMP_SEQ.fetch_add(1, Ordering::Relaxed)
            ));
            let mut opts = File::options();
            opts.write(true).create_new(true);
            // 0600, not the default. These stores hold the vault (sealed records +
            // the Argon2id salt), the Argon2id-wrapped sync root, the per-device
            // salt, settings and full browsing history. `File::options` creates with
            // 0666 & ~umask, which under the near-universal umask 022 lands at 0644 —
            // world-readable. Because we rename the temp over the target, setting the
            // mode here also repairs any pre-existing store that an older build left
            // at 0644, on its next write.
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                opts.mode(0o600);
            }
            match opts.open(&tmp) {
                Ok(f) => break (f, tmp),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists && attempt < 16 => {
                    attempt += 1;
                    continue;
                }
                Err(e) => return Err(e),
            }
        }
    };
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    fs::rename(&tmp, path)?;
    // Best-effort dir fsync so the rename is durable. Opening a directory as a File
    // fails on Windows — swallow the error there.
    if let Some(dir) = path.parent() {
        if let Ok(d) = File::open(dir) {
            let _ = d.sync_all();
        }
    }
    Ok(())
}

/// Durable write that keeps the prior good copy at `<name>.bak` for recovery.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic_inner(path, bytes, true)
}

/// Durable write with NO `.bak` left behind — for user-facing artifacts (e.g. a data
/// export in the Downloads dir) where a stray sidecar file would be confusing.
pub fn write_atomic_no_backup(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    write_atomic_inner(path, bytes, false)
}

/// JSON-validated read with `.bak` fallback (works for arrays AND objects). Returns
/// `None` only if neither the primary nor the backup is present and valid JSON.
pub fn read_with_backup(path: &Path) -> Option<String> {
    let primary = fs::read_to_string(path).ok();
    if let Some(ref t) = primary {
        if serde_json::from_str::<Value>(t).is_ok() {
            return primary;
        }
    }
    fs::read_to_string(bak_path(path))
        .ok()
        .filter(|t| serde_json::from_str::<Value>(t).is_ok())
}

/// Like `read_with_backup` but returns the PARSED JSON — one parse, not two — for callers
/// that immediately deserialize (the `load` paths). Same `.bak`-on-invalid fallback.
pub fn read_value_with_backup(path: &Path) -> Option<Value> {
    if let Ok(t) = fs::read_to_string(path) {
        if let Ok(v) = serde_json::from_str::<Value>(&t) {
            return Some(v);
        }
    }
    fs::read_to_string(bak_path(path))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// Non-JSON (plain text, e.g. filter rules) read with `.bak` fallback — no structural
/// validation. An EXISTING file (even empty) is authoritative; we fall back to the
/// backup ONLY when the primary can't be read (missing/unreadable). An empty file is a
/// legitimate value — e.g. the user clearing their custom-filter list — so treating
/// empty as "recover from .bak" would silently resurrect deleted rules.
pub fn read_text_with_backup(path: &Path) -> Option<String> {
    match fs::read_to_string(path) {
        Ok(t) => Some(t),
        Err(_) => fs::read_to_string(bak_path(path)).ok(),
    }
}

/// Load a collection (empty if missing/corrupt). A corrupt primary recovers from the
/// `.bak` written on the last good save instead of silently zeroing the store.
pub fn load<R: Runtime>(app: &AppHandle<R>, name: &str) -> Vec<Value> {
    // Check cache first
    let cached_entry = {
        let cache = CACHE.read();
        cache.get(name).cloned()
    };
    if let Some(entry) = cached_entry {
        if elapsed_secs(&entry.timestamp) < CACHE_TTL_SEC {
            // We have a fresh cache entry
            return entry.data;
        }
    }
    // If we get here, either cache miss or expired

    // Parse once (read_value_with_backup) and move the array out, instead of validating as
    // a Value then re-parsing the same text into Vec<Value>.
    let data = match path(app, name).and_then(|p| read_value_with_backup(&p)) {
        Some(Value::Array(arr)) => arr,
        _ => Vec::new(),
    };

    // Update the cache with the data we just read
    cache_data(name, data.clone());

    data
}

/// One `Mutex` per store name, created on demand. Per-name (not a single global lock) so
/// unrelated stores never block each other, and lazily allocated so a store nobody touches
/// costs nothing.
static STORE_LOCKS: LazyLock<parking_lot::Mutex<HashMap<String, Arc<parking_lot::Mutex<()>>>>> =
    LazyLock::new(|| parking_lot::Mutex::new(HashMap::new()));

/// Get (creating if needed) the write lock for one store. Public so a caller that does its
/// own load/persist (rather than the `load`+`save` pair `mutate` assumes) can still hold
/// the lock across its whole read-modify-write — e.g. `places::dispatch`, whose arms use
/// `load_synced` + a `persist` helper, and `sync_stores::merge_into`, which is the
/// background sync thread that races it. Bind the `Arc` before locking so the guard's
/// borrow does not dangle:
///
/// ```ignore
/// let arc = jsonstore::store_lock("favorites");
/// let _guard = arc.lock();   // …load, modify, save…
/// ```
pub fn store_lock(name: &str) -> Arc<parking_lot::Mutex<()>> {
    let mut locks = STORE_LOCKS.lock();
    locks
        .entry(name.to_string())
        .or_insert_with(|| Arc::new(parking_lot::Mutex::new(())))
        .clone()
}

/// Run `f` holding the write lock for `name`. See [`store_lock`] for when to use this
/// directly instead of [`mutate`].
pub fn with_store_lock<T>(name: &str, f: impl FnOnce() -> T) -> T {
    let lock = store_lock(name);
    let _guard = lock.lock();
    f()
}

/// Persist a collection durably (atomic temp→rename, keeps a `.bak`). These stores are
/// machine-only (never hand-edited; `data.export` re-serializes its own pretty bundle),
/// so use compact JSON — ~30-40% fewer bytes to serialize + fsync on every write, which
/// matters most for the largest/most-frequently-written stores (e.g. history at its cap).
pub fn save<R: Runtime>(app: &AppHandle<R>, name: &str, items: &[Value]) -> Result<(), String> {
    let Some(p) = path(app, name) else {
        return Err("no app data dir".into());
    };
    let txt = serde_json::to_string(items).map_err(|e| e.to_string())?;
    write_atomic(&p, txt.as_bytes()).map_err(|e| e.to_string())?;

    // Update cache
    cache_data(name, Vec::from(items));

    Ok(())
}

/// Next monotonic id = max existing id + 1.
///
/// O(n) scan over the items array (capped at MAX_ENTRIES per store — trivially fast).
///
/// **This used to have a cached twin, `next_id_optimized`, and that cost the user their saved
/// pages.** It returned a process-global cached answer on a cache HIT and ignored its `items`
/// argument entirely, so: the first `saved.add` on an empty store computed `max([]) = None`
/// ⇒ `0` and cached it; every subsequent add inside the 5 s TTL got `0` again. A user saving a
/// page per second ended up with 104 rows ALL carrying `id: 0` — and since every mutation in
/// `places.rs` addresses rows by id, one `saved.remove { id: 0 }` tombstoned the entire store.
/// The cache bought one array scan (irrelevant at MAX_ENTRIES) in exchange for silent
/// data loss, so it and its two helpers are deleted rather than left as a trap. Use this.
pub fn next_id(items: &[Value]) -> i64 {
    items
        .iter()
        .filter_map(|i| i.get("id").and_then(Value::as_i64))
        .max()
        .map(|max_id| max_id.checked_add(1).unwrap_or(0))
        .unwrap_or(0)
}

/// Re-assign a fresh unique `id` to every record that duplicates an earlier one, in place.
/// Returns how many rows were re-keyed.
///
/// The first holder of each id KEEPS it — re-keying a later duplicate is the least destructive
/// choice, because a client holding a reference to the first row stays valid. Re-keyed rows get
/// ids above the current maximum, so they cannot collide with each other or with anything
/// `next_id` hands out next.
///
/// Records with no integer `id` are left alone. `allowlist` and `fp-allowlist` are host-keyed
/// by design and have no `id` at all; inventing one for them would be noise, and skipping them
/// keeps this safe to run over any store.
///
/// Why this exists: the deleted `next_id_optimized` cache could leave a store with 104 rows all
/// carrying `id: 0`, and because every `places.rs` mutation addresses rows by id, a single
/// `remove { id: 0 }` then tombstoned all of them. Stopping new duplicates is the fix; this is
/// how a store that already has them heals.
pub fn rekey_duplicate_ids(items: &mut [Value]) -> usize {
    let mut seen: HashSet<i64> = HashSet::new();
    let mut next = next_id(items);
    let mut rekeyed = 0usize;
    for it in items.iter_mut() {
        let Some(id) = it.get("id").and_then(Value::as_i64) else {
            continue;
        };
        if seen.insert(id) {
            continue;
        }
        if let Some(o) = it.as_object_mut() {
            o.insert("id".into(), Value::from(next));
        }
        next += 1;
        rekeyed += 1;
    }
    rekeyed
}

/// Current time, epoch milliseconds.
pub fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

// ---------------------------------------------------------------------------
// Syncable-record layer (F2a). Every syncable store record carries three extra
// fields — `uuid` (stable id), `hlc` (Hybrid Logical Clock timestamp), `deleted`
// (tombstone). Renderer-facing reads filter tombstones via `live()`; deletes set
// `deleted=true` (kept on disk) so the removal propagates to peers. The pure helpers
// take `node: &str` so they're AppHandle-free unit-testable; the thin wrappers fetch
// the node + clock. See sync_envelope.rs (the HLC) and sync_stores.rs (the merge).
// ---------------------------------------------------------------------------

/// A record's stable sync id, if assigned.
pub fn uuid_of(item: &Value) -> Option<&str> {
    item.get("uuid").and_then(Value::as_str)
}

/// Whether a record is tombstoned.
pub fn is_deleted(item: &Value) -> bool {
    item.get("deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false)
}

/// Serialize a fresh HLC (ticked off the global clock) as a JSON value for storage.
fn fresh_hlc(node: &str) -> Value {
    serde_json::to_value(crate::sync_envelope::tick(node, now_ms())).unwrap_or(Value::Null)
}

/// Assign sync metadata (`uuid`, `hlc`, `deleted=false`) to a record IF absent — the lazy
/// on-disk migration for pre-sync data. Idempotent: a record that already has all three is
/// untouched (so a uuid/hlc is never regenerated). Returns whether anything was assigned.
/// The migration HLC comes from the global clock so a later `touch()` strictly dominates it.
/// AppHandle-free (takes `node`) for unit testing.
pub fn ensure_sync_meta(item: &mut Value, node: &str, _now_ms: i64) -> bool {
    let Some(obj) = item.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if !obj.contains_key("uuid") {
        obj.insert("uuid".into(), json!(uuid::Uuid::new_v4().to_string()));
        changed = true;
    }
    if !obj.contains_key("hlc") {
        obj.insert("hlc".into(), fresh_hlc(node));
        changed = true;
    }
    if !obj.contains_key("deleted") {
        obj.insert("deleted".into(), json!(false));
        changed = true;
    }
    changed
}

/// Filter out tombstoned records for renderer-facing reads.
pub fn live(items: Vec<Value>) -> Vec<Value> {
    items.into_iter().filter(|it| !is_deleted(it)).collect()
}

/// Stamp a brand-new record: fresh uuid + ticked hlc + `deleted=false`.
pub fn stamp_new<R: Runtime>(item: &mut Value, app: &AppHandle<R>) {
    let node = crate::sync_identity::node_id(app);
    if let Some(obj) = item.as_object_mut() {
        obj.insert("uuid".into(), json!(uuid::Uuid::new_v4().to_string()));
        obj.insert("hlc".into(), fresh_hlc(&node));
        obj.insert("deleted".into(), json!(false));
    }
}

/// Bump a live record's hlc after a local edit (so peers see the newer version).
pub fn touch<R: Runtime>(item: &mut Value, app: &AppHandle<R>) {
    let node = crate::sync_identity::node_id(app);
    if let Some(obj) = item.as_object_mut() {
        obj.insert("hlc".into(), fresh_hlc(&node));
    }
}

/// Re-stamp an imported record so the import counts as a modification **made now**.
///
/// # Why this exists
/// `ensure_sync_meta` (used by the import path until 2026-09-27) only fills in what is
/// *absent*, which is right for the lazy pre-sync migration but wrong for an import. A bundle
/// written by another machine carries that machine's `hlc`, and last-writer-wins is decided
/// purely by `hlc`. So a restore inherited the bundle's timestamps and then **lost every
/// conflict to whatever the server already held** — which is precisely how the 2026-09-26
/// recovery failed: the server still carried 104 `saved` tombstones stamped
/// `wall_ms: 1790457549251`, and a bundle written at 12:38 the same day is older than them, so
/// re-importing it would have re-deleted the very rows it was restoring.
///
/// An import is an explicit human act ("make this what my data is now"), so the records it
/// brings in must be *newer* than the state being replaced. Hence a fresh `hlc` here.
///
/// # Tombstones are deliberately NOT re-stamped
/// Re-stamping a tombstone would turn a stale "deleted" into a fresh one and mass-delete on
/// every other device the moment the bundle synced. Leaving tombstones at their original
/// timestamp is the conservative direction: a stale delete stays weak and loses to a live
/// record, so a restore can never become an accidental wipe. (The reverse hazard — an old
/// tombstone being *resurrected* — is pre-existing and is handled by the retention window.)
///
/// # What is preserved
/// The `uuid` is never regenerated: it is the record's identity for dedup and for
/// `remove {uuid}` on the server. Re-stamping only the clock is what "the same record, just
/// modified" means. Rows already carrying a `uuid`/`deleted` keep them.
///
/// AppHandle-free (takes `node`) so it is unit-testable, like `ensure_sync_meta`.
/// Returns whether anything was changed.
pub fn restamp_after_import(item: &mut Value, node: &str) -> bool {
    let Some(obj) = item.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    if !obj.contains_key("uuid") {
        obj.insert("uuid".into(), json!(uuid::Uuid::new_v4().to_string()));
        changed = true;
    }
    if !obj.contains_key("deleted") {
        obj.insert("deleted".into(), json!(false));
        changed = true;
    }
    // Read the flag back out of the object we just mutated: a row that arrived *without* a
    // `deleted` key is live (the default we just inserted), and a row that arrived with
    // `deleted: true` must be left alone.
    if obj.get("deleted").and_then(Value::as_bool) != Some(true) {
        obj.insert("hlc".into(), fresh_hlc(node));
        changed = true;
    }
    changed
}

/// Tombstone (set `deleted=true` + bump hlc) every record matching `pred`. The records
/// stay in the array so the delete propagates to peers. Returns whether any matched.
pub fn tombstone<R: Runtime>(
    items: &mut [Value],
    pred: impl Fn(&Value) -> bool,
    app: &AppHandle<R>,
) -> bool {
    let node = crate::sync_identity::node_id(app);
    let mut any = false;
    for it in items.iter_mut() {
        if pred(it) {
            let hlc = fresh_hlc(&node);
            if let Some(obj) = it.as_object_mut() {
                obj.insert("deleted".into(), json!(true));
                obj.insert("hlc".into(), hlc);
                any = true;
            }
        }
    }
    any
}

/// Load a collection AND lazily migrate every record to carry sync metadata, persisting
/// back only if something was assigned. Returns the FULL array (incl. tombstones) — use
/// `live()` for renderer-facing reads.
pub fn load_synced<R: Runtime>(app: &AppHandle<R>, name: &str) -> Vec<Value> {
    let node = crate::sync_identity::node_id(app);
    let mut items = load(app, name);
    let mut changed = false;
    for it in items.iter_mut() {
        if ensure_sync_meta(it, &node, now_ms()) {
            changed = true;
        }
    }
    if changed {
        // A failed migration write is logged, not propagated: the in-memory `items` still
        // carry the assigned sync metadata, so the sync path is correct for this session and
        // the next read retries the migration. Unlike the mutators above there is no user
        // action to report against here — nothing was "rejected", so an `eprintln!` is the
        // honest signal rather than turning every read into a potential error.
        if let Err(e) = save(app, name, &items) {
            eprintln!("[aegis] failed to persist {name} sync-metadata migration: {e}");
        }
    }
    items
}

// --- Host-keyed allowlist stores (ad-block `allowlist`, farble `fp-allowlist`) ---
// Both are arrays of `{ host, uuid, hlc, deleted }` and their CRUD is identical save for
// the store NAME, so it lives here once rather than duplicated per owning module. The
// in-memory cache reseed stays in each module (it touches a different managed state).

/// The live (non-tombstoned) `host` strings in a host-keyed store.
pub fn live_hosts<R: Runtime>(app: &AppHandle<R>, name: &str) -> Vec<String> {
    live(load_synced(app, name))
        .iter()
        .filter_map(|it| it.get("host").and_then(Value::as_str).map(String::from))
        .collect()
}

/// Add `host` to a host-keyed store: revive a tombstone in place, or stamp a new record.
///
/// Returns the `save` error rather than swallowing it. These three mutators used to be
/// `-> ()` with `let _ = save(..)`, which made a failed write **invisible**: the IPC caller got
/// `Ok`, the UI re-rendered as if the change took, but `cache_data` only runs after a
/// successful `write_atomic`, so neither disk nor the in-memory cache moved and the change was
/// simply gone by the next launch. An allowlist the user just cleared could silently come back.
/// The per-store lock spans the whole `load` -> mutate -> `save` (see [`with_host_store_lock`]).
pub fn add_host<R: Runtime>(app: &AppHandle<R>, name: &str, host: &str) -> Result<(), String> {
    with_host_store_lock(name, || {
        let mut items = load_synced(app, name);
        match items
            .iter_mut()
            .find(|it| it.get("host").and_then(Value::as_str) == Some(host))
        {
            Some(it) => {
                if is_deleted(it) {
                    if let Some(o) = it.as_object_mut() {
                        o.insert("deleted".into(), json!(false));
                    }
                    touch(it, app);
                }
            }
            None => {
                let mut item = json!({ "host": host });
                stamp_new(&mut item, app);
                items.push(item);
            }
        }
        save(app, name, &items)
    })
}

/// Tombstone `host` in a host-keyed store. Propagates a save failure — see [`add_host`].
pub fn remove_host<R: Runtime>(app: &AppHandle<R>, name: &str, host: &str) -> Result<(), String> {
    with_host_store_lock(name, || {
        let mut items = load_synced(app, name);
        tombstone(
            &mut items,
            |it| it.get("host").and_then(Value::as_str) == Some(host),
            app,
        );
        save(app, name, &items)
    })
}

/// Tombstone every live host in a host-keyed store (clear all). Propagates a save failure —
/// this is the one that matters most, since a silently-failed "clear" resurrects every host.
pub fn clear_hosts<R: Runtime>(app: &AppHandle<R>, name: &str) -> Result<(), String> {
    with_host_store_lock(name, || {
        let mut items = load_synced(app, name);
        tombstone(&mut items, |it| !is_deleted(it), app);
        save(app, name, &items)
    })
}

/// Run `f` holding `name`'s per-store write lock, for the host-keyed mutators above.
///
/// ## Why these three needed it when `mutate` and the sync merge already had it
///
/// Each is a `load_synced` -> mutate -> `save` read-modify-write, and
/// `jsonstore::write_atomic` only guarantees that no individual WRITE is lost — never that a
/// read-modify-write is atomic. Two callers that both read version N and both save leave
/// whichever wrote last as the WHOLE file, and because both saves SUCCEED the file looks
/// perfectly healthy, so nothing reports the loss.
/// `a_concurrent_host_keyed_add_loses_nothing` is the proof.
///
/// This is reachable, not theoretical: `allowlist` is one of the three names in
/// `crate::sync_stores::SYNCABLE`, so the background sync thread merges it via `merge_into`
/// (already locked) WHILE the UI's `adblock.toggleAllowlist` / `removeAllowlist` /
/// `clearAllowlist` calls one of these. A host the user allowlisted while a peer record landed
/// simply disappeared, with no error anywhere. `fp-allowlist` and the WebRTC exempt store ride
/// the same path through `add_host` and friends.
///
/// ## Non-reentrant, so the lock is taken at exactly ONE level
///
/// `with_store_lock` is a `parking_lot::Mutex`, so taking it twice on one thread DEADLOCKS
/// rather than recursing. It is therefore taken HERE, in the lowest-level mutators, and NOT in
/// any of their callers. Audited: every caller is an `adblock` / `farble` / `webrtc_exempt`
/// dispatch arm, none of which holds a store lock; and the one path that does hold one
/// (`crate::sync_stores::merge_into`) uses its own `merge_into_locked` body, never these.
fn with_host_store_lock<T>(name: &str, f: impl FnOnce() -> T) -> T {
    with_store_lock(name, f)
}

// Cache management functions

fn cache_data(name: &str, data: Vec<Value>) {
    let mut cache = CACHE.write();

    // Remove expired entries
    cache.retain(|_, entry| elapsed_secs(&entry.timestamp) < CACHE_TTL_SEC);

    // Enforce size limit
    if cache.len() >= MAX_CACHE_SIZE {
        // Remove oldest entry (simple approach - not true LRU but good enough)
        let oldest_key = cache
            .iter()
            .min_by_key(|(_, entry)| entry.timestamp)
            .map(|(key, _)| key.clone());
        if let Some(key) = oldest_key {
            cache.remove(&key);
        }
    }

    cache.insert(
        name.to_string(),
        CacheEntry {
            data: data.clone(),
            timestamp: Instant::now(),
        },
    );
}

fn elapsed_secs(instant: &Instant) -> u64 {
    instant.elapsed().as_secs()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A unique, fresh temp directory (no `tempfile` dep in the tree).
    fn tmp_dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!(
            "aegis-jsonstore-{}-{}-{}",
            tag,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0)
        ));
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_atomic_roundtrips_and_creates_missing_dirs() {
        let dir = tmp_dir("roundtrip");
        // A nested, not-yet-existing subdir exercises create_dir_all.
        let p = dir.join("nested").join("store.json");
        write_atomic(&p, b"[1,2,3]").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "[1,2,3]");
        // No tmp file is left behind in the target dir.
        let leftover: Vec<_> = fs::read_dir(p.parent().unwrap())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "no .tmp should remain");
    }

    #[test]
    fn write_atomic_keeps_prior_copy_as_bak() {
        let dir = tmp_dir("bak");
        let p = dir.join("store.json");
        write_atomic(&p, b"[\"first\"]").unwrap();
        write_atomic(&p, b"[\"second\"]").unwrap();
        assert_eq!(fs::read_to_string(&p).unwrap(), "[\"second\"]");
        // The .bak holds the value from BEFORE the most recent write.
        assert_eq!(fs::read_to_string(bak_path(&p)).unwrap(), "[\"first\"]");
    }

    #[test]
    fn write_atomic_no_backup_leaves_no_sidecar() {
        let dir = tmp_dir("nobak");
        let p = dir.join("export.json");
        write_atomic_no_backup(&p, b"{}").unwrap();
        write_atomic_no_backup(&p, b"{}").unwrap();
        assert!(!bak_path(&p).exists(), "no .bak for the no-backup variant");
    }

    #[test]
    fn read_with_backup_recovers_from_corrupt_primary() {
        let dir = tmp_dir("recover");
        let p = dir.join("store.json");
        write_atomic(&p, b"[\"good\"]").unwrap(); // creates store.json
        write_atomic(&p, b"[\"newer\"]").unwrap(); // store.json.bak = ["good"]
                                                   // Corrupt the primary as a crash-mid-write would.
        fs::write(&p, b"{ this is not valid json").unwrap();
        let recovered = read_with_backup(&p).expect("should recover from .bak");
        assert_eq!(recovered, "[\"good\"]");
    }

    #[test]
    fn read_value_with_backup_parses_once_and_recovers_from_bak() {
        let dir = std::env::temp_dir().join(format!("aegis-rvb-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let p = dir.join("v.json");
        // Corrupt primary + valid .bak → recovers the PARSED value from the backup.
        std::fs::write(&p, b"{ not json").unwrap();
        std::fs::write(bak_path(&p), br#"[{"id":7}]"#).unwrap();
        let v = read_value_with_backup(&p).expect("recovers parsed value from .bak");
        assert_eq!(v[0]["id"], serde_json::json!(7));
        // Both invalid → None.
        std::fs::write(bak_path(&p), b"also broken").unwrap();
        assert!(read_value_with_backup(&p).is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn read_with_backup_returns_none_when_both_invalid() {
        let dir = tmp_dir("none");
        let p = dir.join("store.json");
        // Nothing written at all.
        assert!(read_with_backup(&p).is_none());
        // Primary corrupt, no .bak.
        fs::write(&p, b"garbage").unwrap();
        assert!(read_with_backup(&p).is_none());
    }

    #[test]
    fn read_text_with_backup_keeps_empty_and_recovers_only_when_missing() {
        let dir = tmp_dir("text");
        let p = dir.join("custom-filters.txt");
        // No JSON validation: plain filter text round-trips.
        write_atomic(&p, b"||ads.example^\n").unwrap();
        write_atomic(&p, b"||trackers.example^\n").unwrap();
        assert_eq!(read_text_with_backup(&p).unwrap(), "||trackers.example^\n");
        // Clearing to empty must STICK — an existing empty file is the real value, NOT a
        // trigger to resurrect deleted rules from .bak (regression guard for clearing
        // the custom-filter list). Note write_atomic stashed the prior text in .bak.
        write_atomic(&p, b"").unwrap();
        assert_eq!(read_text_with_backup(&p).unwrap(), "");
        // ONLY a missing/unreadable primary falls back to the backup.
        fs::remove_file(&p).unwrap();
        assert_eq!(read_text_with_backup(&p).unwrap(), "||trackers.example^\n");
    }

    #[test]
    fn write_atomic_survives_concurrent_same_path_writers() {
        use std::sync::Arc;
        // Many threads writing the SAME path must never silently drop a write: with a
        // shared/colliding temp name, a losing writer's rename fails NotFound. The
        // process-global counter + O_EXCL create guarantees unique temps, so every
        // write succeeds and the final file is always a complete, valid array.
        let dir = Arc::new(tmp_dir("concurrent"));
        let p = Arc::new(dir.join("store.json"));
        let mut handles = Vec::new();
        for t in 0..8 {
            let p = Arc::clone(&p);
            handles.push(std::thread::spawn(move || {
                for i in 0..200 {
                    let body = format!("[{t},{i}]");
                    write_atomic(&p, body.as_bytes())
                        .expect("no concurrent writer should drop a write");
                }
            }));
        }
        for h in handles {
            h.join().unwrap();
        }
        let txt = fs::read_to_string(&*p).unwrap();
        assert!(
            serde_json::from_str::<Vec<i64>>(&txt).is_ok(),
            "final file is a complete, valid array: {txt:?}"
        );
        let leftover: Vec<_> = fs::read_dir(&*dir)
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftover.is_empty(), "no .tmp left after concurrent writes");
    }

    /// A store lock must cover the whole read-modify-write, not just the write.
    ///
    /// The existing concurrency test above only proves no individual WRITE is lost — two
    /// threads can each read version N, each append, and the second save silently drops
    /// the first's append while the file still looks perfectly valid. This is a live race
    /// in this crate (a UI `favorites.add` vs the sync thread's `merge_into`). `mutate`
    /// holds a per-store lock across load→mutate→save, so N appends must all survive.
    #[test]
    fn a_locked_read_modify_write_does_not_lose_concurrent_appends() {
        use crate::test_support::with_tmp_app;
        const THREADS: i64 = 8;
        const PER_THREAD: i64 = 25;

        with_tmp_app(|app| {
            let mut handles = Vec::new();
            for t in 0..THREADS {
                let app = app.clone();
                handles.push(std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        with_store_lock("mutate_race", || {
                            let mut items = load(&app, "mutate_race");
                            items.push(json!({ "t": t, "i": i }));
                            save(&app, "mutate_race", &items).expect("save must not fail");
                        });
                    }
                }));
            }
            for h in handles {
                h.join().unwrap();
            }
            let final_items = load(app, "mutate_race");
            assert_eq!(
                final_items.len(),
                (THREADS * PER_THREAD) as usize,
                "every append must survive: a lost update means two callers read the same \
                 version and the second save overwrote the first"
            );
        });
    }

    /// The host-keyed mutators must hold the per-store lock across their whole
    /// `load` -> mutate -> `save`, or two allowlist clicks lose one of the two hosts.
    ///
    /// `allowlist` is SYNCABLE, so the background sync thread merges this very file through
    /// `sync_stores::merge_into` (which does hold the lock) while the UI's
    /// `adblock.toggleAllowlist` calls `add_host`, which used to run completely unlocked.
    /// Each `save` still SUCCEEDED, so the file stayed valid and nothing reported the loss —
    /// the host the user just allowlisted simply was not there afterwards. Asserted on the
    /// hosts that SURVIVE, not on any internal lock: the observable is "no host is lost".
    #[test]
    fn a_concurrent_host_keyed_add_loses_nothing() {
        use crate::test_support::with_tmp_app;
        const THREADS: i64 = 8;
        const PER_THREAD: i64 = 25;
        let name = "host_race";

        with_tmp_app(|app| {
            let mut handles = Vec::new();
            for t in 0..THREADS {
                let app = app.clone();
                handles.push(std::thread::spawn(move || {
                    for i in 0..PER_THREAD {
                        add_host(&app, name, &format!("h{t}-{i}")).expect("add_host must not fail");
                    }
                }));
            }
            for h in handles {
                h.join().unwrap();
            }

            let mut want: Vec<String> = (0..THREADS)
                .flat_map(|t| (0..PER_THREAD).map(move |i| format!("h{t}-{i}")))
                .collect();
            let got = live_hosts(app, name);
            want.sort();
            let mut got_sorted = got.clone();
            got_sorted.sort();
            assert_eq!(
                got_sorted, want,
                "every host must survive: a lost update means two callers read the same \
                 version of the file and the second save overwrote the first"
            );
        });
    }

    /// A caller that returns `Err` mid-update must leave the store byte-identical — the
    /// lock is about atomicity, not about letting a failed update through.
    #[test]
    fn a_rejected_update_leaves_the_store_as_it_was() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            // A caller that bails out mid-update must leave the store as it found it, so a
            // rejected update is not silently half-applied.
            let err: Result<(), String> = with_store_lock("mutate_reject", || {
                let mut items = load(app, "mutate_reject");
                items.push(json!({ "id": 1 }));
                save(app, "mutate_reject", &items)?;
                Err("nope".to_string())
            });
            assert_eq!(err.unwrap_err(), "nope");
            let items = load(app, "mutate_reject");
            assert_eq!(items.len(), 1, "the rejected append must not be saved");
            assert_eq!(items[0]["id"], 1);
        });
    }

    /// Different store names must not block each other. If this regressed (e.g. someone
    /// swapped the per-name map for one global mutex), the sleeps below would serialize
    /// and the elapsed time would blow past the bound.
    #[test]
    fn mutate_locks_are_per_store_not_global() {
        let a = store_lock("mutate_a");
        let b = store_lock("mutate_b");
        assert!(
            !Arc::ptr_eq(&a, &b),
            "two store names must get two different locks"
        );
        let a2 = store_lock("mutate_a");
        assert!(Arc::ptr_eq(&a, &a2), "the same name must reuse its lock");
    }

    #[test]
    fn ensure_sync_meta_assigns_all_three_when_absent_and_is_idempotent() {
        let mut item = json!({ "id": 1, "url": "https://x" });
        assert!(
            ensure_sync_meta(&mut item, "node-a", 1000),
            "should assign on first pass"
        );
        let uuid1 = uuid_of(&item).unwrap().to_string();
        assert!(!uuid1.is_empty());
        assert!(item.get("hlc").is_some());
        assert!(!is_deleted(&item));
        // Idempotent: a second pass changes nothing and keeps the SAME uuid.
        assert!(
            !ensure_sync_meta(&mut item, "node-a", 2000),
            "second pass must be a no-op"
        );
        assert_eq!(uuid_of(&item).unwrap(), uuid1);
    }

    #[test]
    fn ensure_sync_meta_only_fills_missing_fields() {
        // A record that already has a uuid keeps it; only hlc/deleted are added.
        let mut item = json!({ "id": 1, "uuid": "fixed-uuid" });
        assert!(ensure_sync_meta(&mut item, "n", 1));
        assert_eq!(uuid_of(&item).unwrap(), "fixed-uuid");
        assert!(item.get("hlc").is_some());
        // A non-object value can't be migrated.
        let mut scalar = json!(42);
        assert!(!ensure_sync_meta(&mut scalar, "n", 1));
    }

    #[test]
    fn live_filters_tombstones_keeps_undecorated() {
        let items = vec![
            json!({ "id": 1, "deleted": false }),
            json!({ "id": 2, "deleted": true }),
            json!({ "id": 3 }), // no deleted field → treated as live
        ];
        let out = live(items);
        let ids: Vec<i64> = out
            .iter()
            .filter_map(|i| i.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids, vec![1, 3]);
    }

    #[test]
    fn next_id_skips_over_tombstoned_ids() {
        // A deleted record's id must never be reused (next_id scans the full array).
        let items = vec![
            json!({ "id": 1, "deleted": true }),
            json!({ "id": 2, "deleted": false }),
        ];
        assert_eq!(next_id(&items), 3);
    }

    #[test]
    fn load_recovers_a_corrupt_array_store_from_bak() {
        // Mirrors read_with_backup at the typed-array layer load() uses.
        let dir = tmp_dir("load");
        let p = dir.join("favorites.json");
        write_atomic(&p, b"[{\"id\":1}]").unwrap();
        write_atomic(&p, b"[{\"id\":1},{\"id\":2}]").unwrap();
        fs::write(&p, b"<corrupt>").unwrap();
        let recovered = read_with_backup(&p)
            .and_then(|t| serde_json::from_str::<Vec<Value>>(&t).ok())
            .unwrap_or_default();
        assert_eq!(recovered.len(), 1, "recovered the pre-corruption array");
    }

    /// The host mutators must REPORT a failed write instead of returning `Ok` while nothing
    /// changed. Before this, all three were `-> ()` with `let _ = save(..)`, so a failed write
    /// was completely invisible: the IPC caller got `Ok`, the UI re-rendered as if the change
    /// took, and because `cache_data` only runs after a successful `write_atomic`, neither disk
    /// nor the in-memory cache moved — so an allowlist the user had just cleared came back on
    /// the next launch.
    ///
    /// Forces a genuine write failure by putting a **directory** where the store file must be:
    /// `write_atomic` is temp-file + rename, and a rename onto a directory fails — the same
    /// class of failure as a full disk or a read-only home directory.
    #[test]
    fn host_mutators_surface_a_write_failure() {
        crate::test_support::with_tmp_app(|app| {
            let p = path(app, "allowlist").expect("store path");
            // A well-formed store first, so the load side is happy and only the WRITE fails.
            write_atomic(&p, b"[]").unwrap();
            fs::remove_file(&p).unwrap();
            fs::create_dir(&p).unwrap(); // now the store path is a directory => rename fails

            assert!(add_host(app, "allowlist", "a.test").is_err(), "add_host");
            assert!(
                remove_host(app, "allowlist", "a.test").is_err(),
                "remove_host"
            );
            assert!(clear_hosts(app, "allowlist").is_err(), "clear_hosts");
        });
    }
}
