//! Cross-platform re-apply of the ad-block configuration after a filter / subscription /
//! custom-filter / import change.
//!
//! Before this, only Linux re-applied (`install_adblock` rebuilds the declarative WebKit
//! content filters); Windows/macOS/Android never re-read subscriptions or custom filters
//! after boot, so a filter change silently didn't take effect there. `refresh` unifies all
//! platforms:
//!   - Linux: rebuild + reapply the WebKit content filters (`install_adblock`, hash-cached).
//!   - all targets: re-mirror the on/off + allowlist policy into the engine (`set_policy`).
//!   - all targets: rebuild the engine's `FilterSet` from the bundled lists + enabled
//!     subscriptions + the user's custom filters (`reload_lists`), so the change blocks
//!     everywhere (incl. the pop-under check on every desktop, and Android's interceptor).
//!
//! Toggle/allowlist-only changes (`adblock.rs`) don't change the LISTS, so they call
//! `set_policy` directly and skip the (~20 MB) FilterSet reload this does.
use tauri::{AppHandle, Manager, Runtime};

/// Re-apply the full ad-block config across every platform after a filter-list change.
pub fn refresh<R: Runtime>(app: &AppHandle<R>) {
    // Linux: the declarative WebKit content filters (cached by hash → fast on a no-op).
    #[cfg(target_os = "linux")]
    crate::install_adblock(app.clone());

    // The Chromium-side matching engine (pop-under check on desktop, request interception
    // on Android/Windows). Compiled on every desktop + Android.
    #[cfg(any(desktop, target_os = "android", test))]
    {
        // Re-mirror the live on/off + allowlist policy.
        if let Some(s) = app.try_state::<crate::adblock::AdblockState>() {
            let g = s.0.lock().unwrap();
            crate::adblock_engine::set_policy(g.enabled, &g.allowlist);
        }
        // Rebuild the engine FilterSet = bundled lists + enabled subs + custom filters.
        let extra = vec![
            crate::subs::enabled_text(app),
            crate::customfilters::load(app),
        ];
        crate::adblock_engine::reload_lists(extra);
    }
}
