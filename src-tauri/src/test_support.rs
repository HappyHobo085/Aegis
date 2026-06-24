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
/// The mock never spawns real webviews, so dispatchers that call `spawn_tab` or touch
/// native webview handles will skip or no-op in tests — that is expected and safe.
pub fn with_tmp_app<T>(f: impl FnOnce(&AppHandle<MockRuntime>) -> T) -> T {
    let _guard = lock();
    let tmp = fresh_tmp();
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

    let out = f(app.handle());

    drop(app);
    let _ = std::fs::remove_dir_all(&tmp);
    out
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
            #[cfg(target_os = "linux")]
            assert!(app
                .try_state::<crate::linux_layout::LayoutInsets>()
                .is_some());
        });
    }

    /// jsonstore round-trip: save then load must return the same value, and the file
    /// must land UNDER the temp dir (not the real user profile).
    #[test]
    fn jsonstore_roundtrip_stays_under_tmp() {
        with_tmp_app(|app| {
            let items = vec![json!({"id": 1, "title": "smoke test"})];
            crate::jsonstore::save(app, "smoke", &items).expect("save must not fail");

            let loaded = crate::jsonstore::load(app, "smoke");
            assert_eq!(loaded, items, "loaded value must match what was saved");

            // The file must be under the temp dir, not the real user profile.
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
