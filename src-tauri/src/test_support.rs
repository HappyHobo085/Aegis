// src-tauri/src/test_support.rs
//! Crate-wide test harness for AppHandle-backed unit tests.
//!
//! The data stores resolve their paths from `app.path().app_data_dir()`, which on
//! Linux comes from `$XDG_DATA_HOME` (and the cache dir from `$XDG_CACHE_HOME`) —
//! see `dirs`/`dirs-sys`. A `tauri::test::mock_app()` has an EMPTY bundle identifier,
//! so `app_data_dir()` resolves to `$XDG_DATA_HOME` directly. We point those env
//! vars at a fresh temp dir per test so store IO never touches real user data.
//!
//! Env vars are process-global and cargo runs tests on many threads, so EVERY
//! AppHandle test must hold `LOCK` for its whole body — `with_tmp_app` does this.
#![cfg(test)]

use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
use tauri::{AppHandle, Manager};

/// Serializes all AppHandle tests: they share process env vars + process-global
/// statics (e.g. `sync_identity::NODE_ID`, the adblock counters), so they must not
/// run concurrently. A poisoned lock from a panicking test is recovered (we only
/// guard the env, not invariants), so one failing test doesn't cascade-fail the rest.
fn lock() -> std::sync::MutexGuard<'static, ()> {
    static LOCK: OnceLock<Mutex<()>> = OnceLock::new();
    LOCK.get_or_init(|| Mutex::new(()))
        .lock()
        .unwrap_or_else(|p| p.into_inner())
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
pub fn with_tmp_app<T>(f: impl FnOnce(&AppHandle<MockRuntime>) -> T) -> T {
    let _guard = lock();
    let tmp = fresh_tmp();
    // Must be set BEFORE the app is built — app_data_dir() reads them on each call,
    // but setting up front keeps every store under `tmp` for the whole test.
    std::env::set_var("XDG_DATA_HOME", &tmp);
    std::env::set_var("XDG_CACHE_HOME", &tmp);
    std::env::set_var("XDG_CONFIG_HOME", &tmp);

    let app = mock_builder()
        .manage(crate::adblock::AdblockState::default())
        .manage(crate::safety::SafetyState::default())
        .manage(crate::sync::SyncState::default())
        .build(mock_context(noop_assets()))
        .expect("mock app builds");

    let out = f(app.handle());

    drop(app);
    let _ = std::fs::remove_dir_all(&tmp);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
            assert!(app.try_state::<crate::adblock::AdblockState>().is_some());
            assert!(app.try_state::<crate::safety::SafetyState>().is_some());
            assert!(app.try_state::<crate::sync::SyncState>().is_some());
        });
    }
}
