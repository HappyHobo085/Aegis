// src-tauri/src/testament.rs
//! Crate-wide test harness for AppHandle-backed unit tests.
//!
//! The data stores resolve their paths from `app.path().app_data_dir()`, which on
//! Linux comes from `$XDG_DATA_HOME` (and the cache dir from `$XDG_CACHE_HOME`).
//! A `tauri::test::mock_app()` has an EMPTY bundle identifier, so `app_data_dir()`
//! resolves directly to `$XDG_DATA_HOME`. The heaps point those env
//! vars at a fresh temp dir per test so store IO never touches real user data.
//!
//! Env vars are process-global and cargo runs tests on many threads, so EVERY
//! AppHandle test must hold `LOCK` for its whole body — `with_tmp_app` does this.
#![cfg(test)]

use std::cell::RefCell;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{AppHandle, Manager};

/// Serializes all AppHandle tests: they share process env vars + process-global
/// statics (e.g. `sync_identity::NODE_ID`, the adblock counters), so they must not
/// run concurrently. A poisoned lock from a panicking test is recovered (we only
/// guard the env, not invariants), so one failing test doesn't cascade-fail the rest.
///
/// `pub` because process-global state is not confined to AppHandle tests: `vault`'s
/// unlock-rate-limiter statics (`FAILED_ATTEMPTS` / `LAST_FAILURE_MS`) and
/// `adblock_engine`'s policy statics are mutated by tests that need this lock too. While
/// this was private those tests raced the AppHandle ones under `cargo test`'s parallel
/// execution, because they could not reach it.
pub fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
}

/// Put a rustls crypto provider in the process-global slot, so tests can make real HTTP calls.
///
/// The app does this in `run()` (see `lib.rs`) because reqwest is built with
/// `rustls-no-provider` (via the updater plugin) and every TLS client panics with "No rustls
/// crypto provider is configured" if it builds before the slot is filled. `run()` is not part
/// of a unit test, so a test that drives a real request — the vault salt handshake speaks HTTP
/// to a loopback server — hits that panic and reports it as the feature being broken. Idempotent:
/// `install_default` is internally guarded and reports "already installed" as an `Err` we
/// deliberately ignore.
pub fn ensure_crypto_provider() {
    static ONCE: OnceLock<()> = OnceLock::new();
    ONCE.get_or_init(|| {
        let _ = rustls::crypto::aws_lc_rs::default_provider().install_default();
    });
}

/// Run `f` on a worker thread and require it to return within `secs`, or fail the test.
///
/// A self-deadlock on a non-reentrant mutex has exactly ONE symptom: the call does not come
/// back. Asserted inline, that symptom is a hung test binary — a bad way to find a bug and a
/// much worse way to stop one returning. Bounding the wait turns the regression into an
/// ordinary failure whose message names the cause, and the leaked worker thread is harmless:
/// it is already wedged, and it holds none of the locks `with_tmp_app` guards.
///
/// `f` returns `Result<(), String>` so the caller can report which precondition or assertion
/// it reached; `Err` is surfaced as the failure message rather than being swallowed.
pub fn assert_returns_within(secs: u64, f: impl FnOnce() -> Result<(), String> + Send + 'static) {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(Ok(())) => {}
        Ok(Err(why)) => panic!("{why}"),
        Err(_) => {
            panic!("the call never returned — it is deadlocked on its own lock (waited {secs}s)")
        }
    }
}

/// `dispatch`'s `Option<Result<..>>` flattened, so a closure that wants to propagate either
/// layer can do it as a `String` instead of unwrapping.
pub fn ran(
    r: Option<Result<serde_json::Value, String>>,
    what: &str,
) -> Result<serde_json::Value, String> {
    r.ok_or_else(|| format!("no dispatch arm for {what}"))?
        .map_err(|e| format!("{what}: {e}"))
}

/// Put a NON-EMPTY DIRECTORY where the named store's file must go, so writing that store
/// really fails, and return the path that was blocked.
///
/// Every store writes atomically: `jsonstore::write_atomic_inner` creates the parent
/// directory, writes a temp file, then `fs::rename`s it over the target. Renaming a file ONTO
/// a non-empty directory fails with ENOTEMPTY/EISDIR — for EVERY user, root included, which is
/// what makes this usable in a container that runs tests as root. `chmod 0500` is a no-op
/// there, so the obvious alternative silently produces a VACUOUS test.
///
/// Callers should still assert the write failed after calling this (as the data-store tests
/// do), so the test breaks loudly rather than passing for the wrong reason if `write_atomic`
/// ever changes shape.
pub fn block_store_file<R: tauri::Runtime>(app: &AppHandle<R>, name: &str) -> PathBuf {
    let p = app.path().app_data_dir().expect("app data dir").join(name);
    // The store file usually already exists (a previous write in the same test), and
    // `create_dir_all` over an existing FILE fails with EEXIST. Remove it first so the
    // directory lands in its place; the test is about the write failing, not about preserving
    // the bytes, and every caller asserts the failure it cares about.
    if p.is_file() {
        std::fs::remove_file(&p).expect("clear the real store file");
    }
    std::fs::create_dir_all(&p).expect("dir in place of the store file");
    std::fs::write(p.join("occupied"), b"x").expect("make it non-empty");
    p
}

/// Undo [`block_store_file`]: remove the blocking directory so the real file can land again.
pub fn unblock_store_file(p: &std::path::Path) {
    std::fs::remove_dir_all(p).expect("remove the blocking directory");
}

fn fresh_tmp() -> PathBuf {
    let d = std::env::temp_dir().join(format!(
        "aegis-test-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0)
    ));
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// Run `f` with a mock `AppHandle` whose data/cache/config dirs are a fresh temp dir
/// and whose managed state matches what the dispatchers expect. Serialized + cleaned.
///
/// ## Managed state registered (mirrors lib.rs builder + setup):
/// - `view::ContentInset`
/// - `update::UpdateState`
/// - `adblock::AdblockState`
/// - `safety::SafetyState`
/// - `sync::SyncState`
/// - `redirect_guard::PendingNavs`
/// - `redirect_guard::NavActions`
/// - `redirect_guard::Chains`
/// - `zoom::ZoomStore`
/// - `tabs::Tabs` (from a fresh single-tab Registry with `"about:blank"` as home)
/// - `linux_layout::LayoutInsets` (Linux only, `#[cfg(target_os = "linux")]`)
///
/// Note: `tabs::Tabs` wraps a `tab_registry::Registry` with an "about:blank" home URL.
// The mock never spawns real webviews, so dispatchers that call `spawn_tab` or touch
// native webview handles will skip or no-op in tests — that is expected and safe.
pub fn with_tmp_app<T>(f: impl FnOnce(&AppHandle<MockRuntime>) -> T) -> T {
    let _guard = lock();
    ensure_crypto_provider();
    let tmp = fresh_tmp();
    // Clear process-global jsonstore caches so each test starts clean.
    // (CACHE and NEXT_ID_CACHE are statics that survive across with_tmp_app calls.)
    crate::jsonstore::clear_caches();
    // Must be set BEFORE the app is built — app_data_dir() reads them on each call,
    // but setting up front keeps every store under `tmp` for the whole test.
    std::env::set_var("XDG_DATA_HOME", &tmp);
    std::env::set_var("XDG_CACHE_HOME", &tmp);
    std::env::set_var("XDG_CONFIG_HOME", &tmp);

    // Build the mock app with all managed state that lib.rs registers (builder + setup).
    // #[cfg] attributes cannot appear mid-chain, so the Linux-only LayoutInsets is added
    // after build() via app.manage() — Tauri allows manage() on the built App too.
    let app = mock_builder()
        // --- builder-time managed state (mirrors lib.rs .manage() calls) ---
        .manage(crate::view::ContentInset::default())
        .manage(crate::update::UpdateState::default())
        .manage(crate::adblock::AdblockState::default())
        .manage(crate::safety::SafetyState::default())
        .manage(crate::sync::SyncState::default())
        .manage(crate::redirect_guard::PendingNavs::default())
        .manage(crate::redirect_guard::NavActions::default())
        .manage(crate::redirect_guard::Chains::default())
        .manage(crate::zoom::ZoomStore::default())
        .manage(crate::vault::VaultState::default())
        .manage(crate::farble::FarbleState::default())
        .manage(crate::proxy::ProxyState::default())
        .manage(crate::settings::SettingsCache::default())
        .manage(crate::history::HistoryStore::default())
        .manage(crate::downloads::DownloadsStore::default())
        // --- setup()-time managed state ---
        // tabs::Tabs: lib.rs adds this in setup() after loading/restoring the session.
        // In tests we construct a minimal single-tab registry (home = "about:blank") so
        // dispatchers calling .state::<Tabs>() don't panic. No real webview is spawned.
        .manage(crate::tabs::Tabs::from_registry(
            crate::tab_registry::Registry::new("about:blank".to_string()),
        ))
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    // linux_layout::LayoutInsets: lib.rs adds this in setup() under #[cfg(target_os="linux")].
    // Registered separately after build so the cfg gate doesn't break the method chain.
    #[cfg(target_os = "linux")]
    app.manage(crate::linux_layout::LayoutInsets::default());

    // The OS keychain has no per-app namespace — one entry (service "com.aegis.browser",
    // user "sync-root") is shared by the whole machine. Point this app at a private entry
    // so a test that stores a seed neither reads nor clobbers the developer's REAL sync
    // seed, and so two tests can never collide on it.
    static SLOT_ID: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
    crate::sync_keystore::manage_test_slot(
        app.handle(),
        SLOT_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed),
    );

    let out = f(app.handle());

    drop(app);
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

// --- import/flush interleave hook -------------------------------------------------
//
// `data.import` overwrites the `history` and `downloads` FILES while those two stores keep
// their rows in an in-memory cache, and a background thread flushes that cache to disk every
// three seconds. Whether a flush can land between the file write and the cache being dropped
// is a genuine race, and it is not observable from outside the import — a flush that runs
// *after* `data.import` returns is a no-op both before and after the fix, so a test that
// only calls the importer and then flushes proves nothing.
//
// `import_tick` is the seam: `data.import` calls it (under `#[cfg(test)]`) after every store
// write, so a test can run a REAL `history::flush`/`downloads::flush` — the same functions
// the background thread calls — at the exact point where the race lives, and assert on the
// file afterwards. It does not exist in a release build, and it is a no-op in any test that
// has not registered a hook.
thread_local! {
    static IMPORT_HOOK: RefCell<Option<Box<dyn Fn()>>> = RefCell::new(None);
}

/// Register `f` to run after each store write inside `data.import`. Replaces any previous
/// hook. The returned guard clears the hook when dropped, so a panicking test cannot leave a
/// stale closure installed for the next one on this thread.
pub fn set_import_hook(f: impl Fn() + 'static) -> ImportHookGuard {
    IMPORT_HOOK.with(|h| *h.borrow_mut() = Some(Box::new(f)));
    ImportHookGuard
}

/// Clears the hook on drop — see [`set_import_hook`].
pub struct ImportHookGuard;

impl Drop for ImportHookGuard {
    fn drop(&mut self) {
        IMPORT_HOOK.with(|h| *h.borrow_mut() = None);
    }
}

/// Run the registered hook, if any. Thread-local, so the hook needs no `Send`/`'static`
/// AppHandle dance — and `with_tmp_app` serialises every AppHandle test on one lock, so the
/// import that triggers the tick and the test that installed the hook are the same thread.
pub fn import_tick() {
    IMPORT_HOOK.with(|h| {
        if let Some(f) = h.borrow().as_ref() {
            f();
        }
    });
}

/// Read one of the Android sources in `gen/android` as text, for the drift pins the
/// crate keeps on the Kotlin half.
///
/// There is NO Kotlin test source set in this project, so a `.kt` change is
/// compile-verified (by the Gradle build) and nothing else. A Rust test that reads the
/// Kotlin SOURCE and asserts on it is therefore the only thing that can catch a future
/// Kotlin edit silently reverting a fix the Rust suite already proves. These helpers
/// live here, not in one module's test block, because that is a crate-wide concern:
/// `nav` pins the navigation policy and `permissions` pins the permission prompt, and
/// neither should own a private copy of the brace-counting loop.
pub fn kotlin_source(file: &str) -> String {
    let path = format!(
        "{}/gen/android/app/src/main/java/com/aegis/browser/{file}",
        env!("CARGO_MANIFEST_DIR")
    );
    std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
}

/// The body of the Kotlin `fun` whose declaration starts with `signature`, sliced from
/// its opening brace to the MATCHING closing one and stripped of comment lines.
///
/// Brace counting rather than a byte or line range, so inserting a line inside the
/// function cannot silently narrow what a pin looks at. Comment stripping because the
/// Kotlin comments this repo writes QUOTE the code they replaced, so a negative assert
/// against raw text matches the documentation of a bug instead of the bug.
pub fn kotlin_fn_body(src: &str, signature: &str) -> String {
    let start = src
        .find(signature)
        .unwrap_or_else(|| panic!("the Kotlin source no longer declares {signature:?}"));
    let open = src[start..]
        .find('{')
        .map(|i| start + i)
        .unwrap_or_else(|| panic!("{signature:?} has no opening brace"));
    let mut depth = 0i32;
    let mut end = None;
    for (i, c) in src[open..].char_indices() {
        match c {
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + i);
                    break;
                }
            }
            _ => {}
        }
    }
    let end = end.unwrap_or_else(|| panic!("{signature:?} has no matching closing brace"));
    src[open..=end]
        .lines()
        .filter(|l| !l.trim_start().starts_with("//"))
        .collect::<Vec<_>>()
        .join("\n")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn tmp_app_data_dir_is_under_the_temp_dir() {
        with_tmp_app(|app| {
            let dir = app.path().app_data_dir().expect("data dir resolves");
            // The redirected XDG_DATA_HOME root (empty identifier => no subfolder).
            assert!(
                dir.starts_with(std::env::temp_dir()),
                "data dir {dir:?} must be under the OS temp dir, not real user data"
            );
        });
    }

    #[test]
    fn required_state_is_managed() {
        with_tmp_app(|app| {
            assert!(app.try_state::<crate::view::ContentInset>().is_some());
            assert!(app.try_state::<crate::update::UpdateState>().is_some());
            assert!(app.try_state::<crate::adblock::AdblockState>().is_some());
            assert!(app.try_state::<crate::safety::SafetyState>().is_some());
            assert!(app.try_state::<crate::sync::SyncState>().is_some());
            assert!(app
                .try_state::<crate::redirect_guard::PendingNavs>()
                .is_some());
            assert!(app
                .try_state::<crate::redirect_guard::NavActions>()
                .is_some());
            assert!(app.try_state::<crate::redirect_guard::Chains>().is_some());
            assert!(app.try_state::<crate::zoom::ZoomStore>().is_some());
            assert!(app.try_state::<crate::tabs::Tabs>().is_some());
            assert!(app.try_state::<crate::farble::FarbleState>().is_some());
            assert!(app.try_state::<crate::proxy::ProxyState>().is_some());
            assert!(app.try_state::<crate::settings::SettingsCache>().is_some());
            assert!(app.try_state::<crate::vault::VaultState>().is_some());
            assert!(app
                .try_state::<crate::downloads::DownloadsStore>()
                .is_some());
            assert!(app.try_state::<crate::history::HistoryStore>().is_some());
            #[cfg(target_os = "linux")]
            assert!(app
                .try_state::<crate::linux_layout::LayoutInsets>()
                .is_some());
        });
    }

    /// jsonstore round-trip: save then load must return the same value, and the file
    /// must land UNDER the temp dir (not the user profile).
    #[test]
    fn jsonstore_roundtrip_stays_under_tmp() {
        with_tmp_app(|app| {
            let items = vec![json!({"id": 1, "title": "smoke test"})];
            crate::jsonstore::save(app, "smoke", &items).expect("save must not fail");

            let loaded = crate::jsonstore::load(app, "smoke");
            assert_eq!(loaded, items, "loaded value must match what was saved");

            // The file must be under the temp dir, not the user profile.
            let data_dir = app.path().app_data_dir().expect("data dir resolves");
            let store_path = data_dir.join("smoke.json");
            assert!(
                store_path.exists(),
                "smoke.json must exist at {store_path:?}"
            );
            assert!(
                store_path.starts_with(std::env::temp_dir()),
                "store file {store_path:?} must be under the OS temp dir, not real user data"
            );
        });
    }
}
