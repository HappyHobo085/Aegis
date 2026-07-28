//! Ad-block on/off + allowlist state, and the `adblock.*` IPC. On Linux,
//! enabling re-installs the WebKit content filters (cached → fast) and disabling
//! removes them. Per-host allowlisting on the declarative WebKit tier requires
//! rebuilding filters with ignore-previous-rules exceptions — for now the host is
//! recorded in state (a follow-up applies it to the filters).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

// --- Blocked-resource counters (the shield badge) ---
// The actual blocking is platform-specific (Linux WebKit content filters, etc.), so
// counting hooks into the per-platform request path: on Linux, the resource-load-started
// signal runs each subresource through the engine and calls `note_blocked` on a match.
static SESSION_BLOCKED: AtomicU32 = AtomicU32::new(0);
static PAGE_BLOCKED: OnceLock<Mutex<HashMap<u32, u32>>> = OnceLock::new();
fn page_map() -> &'static Mutex<HashMap<u32, u32>> {
    PAGE_BLOCKED.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Monotonic session total of ad/tracker requests blocked (for the badge + `getState`).
pub fn session_blocked() -> u32 {
    SESSION_BLOCKED.load(Ordering::Relaxed)
}

/// The active tab's current-page blocked count. `getState` returns this so the chrome
/// recovers the count on mount / tab-switch — live `adblock.blockedCount` events emitted
/// before the chrome subscribed (e.g. the restored boot page) would otherwise be lost.
fn active_page_blocked<R: Runtime>(app: &AppHandle<R>) -> u32 {
    let id = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
        .unwrap_or(1);
    page_map().lock().unwrap_or_else(|e| e.into_inner()).get(&id).copied().unwrap_or(0)
}

/// Pure counter update for one blocked subresource on tab `id`: bumps the monotonic
/// session total and the tab's per-page count, returning `(session, page)`. Split out
/// from `note_blocked` so the accumulation logic is unit-testable without a Tauri
/// `AppHandle` (the emit half needs the app; this half does not).
#[cfg_attr(target_os = "android", allow(dead_code))]
fn bump_blocked(id: u32) -> (u32, u32) {
    let session = SESSION_BLOCKED.fetch_add(1, Ordering::Relaxed) + 1;
    let page = {
        let mut m = page_map().lock().unwrap_or_else(|e| e.into_inner());
        let c = m.entry(id).or_insert(0);
        *c += 1;
        *c
    };
    (session, page)
}

/// Pure per-page reset for tab `id` (zero its page count), returning the unchanged
/// session total. Split out from `reset_page` for the same testability reason.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn zero_page(id: u32) -> u32 {
    page_map().lock().unwrap_or_else(|e| e.into_inner()).insert(id, 0);
    session_blocked()
}

/// Count one blocked subresource on tab `id` and push the running totals to the chrome
/// badge via `adblock.blockedCount`. Called from each platform's request path: Linux's
/// `resource-load-started` hook (`linux_layout::connect_block_counter`) and Windows'
/// WebView2 `WebResourceRequested` handler (`adblock_win`). (Android keeps an equivalent
/// counter in Kotlin — it has no `AppHandle` and no Tauri event bus on the content side —
/// and pushes `window.__aegisBlockedCount` directly; see `MainActivity.kt`.)
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn note_blocked<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let (session, page) = bump_blocked(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": page, "session": session }),
    );
}

/// Reset a tab's per-page blocked count on a new top-frame navigation, and refresh the
/// badge (page → 0, session unchanged). Called from the desktop nav path (`nav.rs`).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn reset_page<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let session = zero_page(id);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": 0, "session": session }),
    );
}

pub struct AdblockState(pub Mutex<Inner>);

pub struct Inner {
    pub enabled: bool,
    pub allowlist: Vec<String>,
}

impl Default for AdblockState {
    fn default() -> Self {
        AdblockState(Mutex::new(Inner {
            enabled: true,
            allowlist: Vec::new(),
        }))
    }
}

/// Whether `host` is covered by the ad-block allowlist — an exact match or a subdomain
/// of an allowlisted host (allowlisting `example.com` also covers `www.example.com`).
/// Reused as the WebRTC per-site escape hatch: an allowlisted site is "trusted", so its
/// WebRTC isn't filtered by the shim / native backstops.
#[cfg_attr(target_os = "android", allow(dead_code))] // desktop-only escape hatch in v1
pub fn host_allowlisted<R: Runtime>(app: &AppHandle<R>, host: &str) -> bool {
    if host.is_empty() {
        return false;
    }
    match app.try_state::<AdblockState>() {
        Some(s) => {
            let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
            g.allowlist
                .iter()
                .any(|h| host == h || host.ends_with(&format!(".{h}")))
        }
        None => false,
    }
}

// --- Persisted allowlist (allowlist.json, a syncable store of {host, uuid, hlc, deleted}) ---
// Before this the allowlist was in-memory only (lost on restart). It's now a syncable
// store; the in-memory Inner.allowlist is a fast cache reseeded from it after every change
// and at boot.

/// The live allowlisted hosts from the persisted store.
pub fn load_allowlist_hosts<R: Runtime>(app: &AppHandle<R>) -> Vec<String> {
    jsonstore::live_hosts(app, "allowlist")
}

/// Add a host (revive a tombstone in place, or stamp a new record).
fn add_host<R: Runtime>(app: &AppHandle<R>, host: &str) {
    jsonstore::add_host(app, "allowlist", host);
}

/// Tombstone a host.
fn remove_host<R: Runtime>(app: &AppHandle<R>, host: &str) {
    jsonstore::remove_host(app, "allowlist", host);
}

/// Tombstone every live host (clear).
fn clear_hosts<R: Runtime>(app: &AppHandle<R>) {
    jsonstore::clear_hosts(app, "allowlist");
}

/// Refresh the in-memory Inner.allowlist cache from the persisted store.
fn reseed_inner<R: Runtime>(app: &AppHandle<R>) {
    let hosts = load_allowlist_hosts(app);
    if let Some(s) = app.try_state::<AdblockState>() {
        s.0.lock().unwrap_or_else(|e| e.into_inner()).allowlist = hosts;
    }
}

/// Seed the (already `.manage()`'d) AdblockState from disk at boot — MUTATE the managed
/// state (it's managed before `setup()` runs, so it can't be constructed with data) — then
/// mirror the policy into the engine. Fixes the restart-loses-allowlist bug on all platforms.
pub fn seed_from_disk<R: Runtime>(app: &AppHandle<R>) {
    reseed_inner(app);
    sync_engine(app);
}

fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    match app.try_state::<AdblockState>() {
        Some(s) => {
            let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
            json!({ "enabled": g.enabled, "allowlistedHosts": g.allowlist, "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) })
        }
        None => {
            json!({ "enabled": true, "allowlistedHosts": [], "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) })
        }
    }
}

/// Mirror the ad-block policy (on/off + allowlist) into the matching engine. Android
/// honors it in `shouldInterceptRequest`; Windows in its WebView2 interceptor; all
/// desktops in `nav::on_new_window` (pop-under blocking). On Linux the page-resource
/// blocking is the WebKit content filters (reconfigured directly above) — the engine
/// is consulted only for pop-unders, but it still must honor the toggle + allowlist.
fn sync_engine<R: Runtime>(app: &AppHandle<R>) {
    #[cfg(any(desktop, target_os = "android", test))]
    if let Some(s) = app.try_state::<AdblockState>() {
        let g = s.0.lock().unwrap_or_else(|e| e.into_inner());
        crate::adblock_engine::set_policy(g.enabled, &g.allowlist);
    }
    #[cfg(not(any(desktop, target_os = "android", test)))]
    let _ = app;
}

/// Handle `adblock.*` channels. Returns `None` if not an adblock channel.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "adblock.getState" => Some(Ok(state_json(app))),

        "adblock.setEnabled" => {
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .unwrap_or(true);
            if let Some(s) = app.try_state::<AdblockState>() {
                s.0.lock().unwrap_or_else(|e| e.into_inner()).enabled = enabled;
            }
            #[cfg(target_os = "linux")]
            {
                if enabled {
                    crate::install_adblock(app.clone());
                } else {
                    crate::adblock_webkit::remove_all(app);
                }
            }
            sync_engine(app);
            Some(Ok(state_json(app)))
        }

        "adblock.toggleAllowlist" | "adblock.removeAllowlist" => {
            let host = payload
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            if !host.is_empty() {
                if channel == "adblock.removeAllowlist" {
                    remove_host(app, &host);
                } else if load_allowlist_hosts(app).iter().any(|h| h == &host) {
                    remove_host(app, &host); // toggle off
                } else {
                    add_host(app, &host); // toggle on
                }
            }
            reseed_inner(app); // refresh the in-memory cache from the persisted store
            sync_engine(app);
            crate::sync::nudge(app); // allowlist is SYNCABLE (no-op when sync is disabled)
            Some(Ok(state_json(app)))
        }

        "adblock.clearAllowlist" => {
            clear_hosts(app);
            reseed_inner(app);
            sync_engine(app);
            crate::sync::nudge(app);
            Some(Ok(state_json(app)))
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use serde_json::Value;

    // ── AppHandle-backed state-machine tests (use the mock harness) ──────────────

    #[test]
    fn default_state_is_enabled_with_empty_allowlist() {
        with_tmp_app(|app| {
            let s = dispatch(app, "adblock.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(s.get("enabled").and_then(Value::as_bool), Some(true));
            assert!(s
                .get("allowlistedHosts")
                .and_then(Value::as_array)
                .unwrap()
                .is_empty());
        });
    }

    #[test]
    fn set_enabled_flips_the_flag() {
        with_tmp_app(|app| {
            let off = dispatch(app, "adblock.setEnabled", &json!({ "enabled": false }))
                .unwrap()
                .unwrap();
            assert_eq!(
                off.get("enabled").and_then(Value::as_bool),
                Some(false),
                "flag is false after setEnabled(false)"
            );
            let on = dispatch(app, "adblock.setEnabled", &json!({ "enabled": true }))
                .unwrap()
                .unwrap();
            assert_eq!(
                on.get("enabled").and_then(Value::as_bool),
                Some(true),
                "flag is true after setEnabled(true)"
            );
        });
    }

    #[test]
    fn toggle_allowlist_adds_then_removes_and_persists() {
        with_tmp_app(|app| {
            // toggle on
            let on = dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "ads.example.com" }),
            )
            .unwrap()
            .unwrap();
            let hosts: Vec<&str> = on
                .get("allowlistedHosts")
                .and_then(Value::as_array)
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(
                hosts.contains(&"ads.example.com"),
                "host appears in allowlistedHosts after toggle-on"
            );
            assert_eq!(
                load_allowlist_hosts(app),
                vec!["ads.example.com".to_string()],
                "persisted store reflects the added host"
            );
            // toggle off
            let off = dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "ads.example.com" }),
            )
            .unwrap()
            .unwrap();
            assert!(
                off.get("allowlistedHosts")
                    .and_then(Value::as_array)
                    .unwrap()
                    .is_empty(),
                "allowlistedHosts is empty after toggle-off"
            );
            assert!(
                load_allowlist_hosts(app).is_empty(),
                "persisted store is empty after toggle-off"
            );
        });
    }

    #[test]
    fn host_allowlisted_covers_subdomains() {
        with_tmp_app(|app| {
            dispatch(
                app,
                "adblock.toggleAllowlist",
                &json!({ "host": "example.com" }),
            )
            .unwrap()
            .unwrap();
            assert!(
                host_allowlisted(app, "example.com"),
                "exact host is allowlisted"
            );
            assert!(
                host_allowlisted(app, "www.example.com"),
                "subdomain is covered by the allowlist entry"
            );
            assert!(
                !host_allowlisted(app, "notexample.com"),
                "unrelated host is not allowlisted"
            );
            assert!(!host_allowlisted(app, ""), "empty string never matches");
        });
    }

    #[test]
    fn clear_allowlist_tombstones_everything() {
        with_tmp_app(|app| {
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "a.test" }))
                .unwrap()
                .unwrap();
            dispatch(app, "adblock.toggleAllowlist", &json!({ "host": "b.test" }))
                .unwrap()
                .unwrap();
            let cleared = dispatch(app, "adblock.clearAllowlist", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                cleared
                    .get("allowlistedHosts")
                    .and_then(Value::as_array)
                    .unwrap()
                    .is_empty(),
                "getState returns empty allowlistedHosts after clearAllowlist"
            );
            assert!(
                load_allowlist_hosts(app).is_empty(),
                "persisted store is empty after clearAllowlist"
            );
        });
    }

    #[test]
    fn note_blocked_increments_session_and_page_counters() {
        with_tmp_app(|app| {
            let tab_id = 9201u32; // disjoint from Plan G's tab ids
            zero_page(tab_id);
            let before = session_blocked();
            note_blocked(app, tab_id);
            note_blocked(app, tab_id);
            assert_eq!(
                session_blocked(),
                before + 2,
                "session total increments by 2 after two note_blocked calls"
            );
            // reset_page zeroes per-page count; session total is unchanged.
            let session_after = session_blocked();
            reset_page(app, tab_id);
            assert_eq!(
                session_blocked(),
                session_after,
                "session total is unchanged after reset_page"
            );
            assert_eq!(
                page_map().lock().unwrap().get(&tab_id).copied(),
                Some(0),
                "per-page count is zero after reset_page"
            );
        });
    }

    // ── Pure counter tests (no AppHandle needed — Plan G) ────────────────────────

    // SESSION_BLOCKED is process-global; these tests reset it and use disjoint tab ids
    // so they don't interfere. They run single-threaded relative to each other only by
    // not sharing tab ids — the session counter assertions read deltas, not absolutes.
    #[test]
    fn page_count_accumulates_per_tab_and_resets() {
        let id = 9001; // a tab id no other test uses
        zero_page(id);
        let (_s1, p1) = bump_blocked(id);
        let (_s2, p2) = bump_blocked(id);
        assert_eq!(p1, 1);
        assert_eq!(p2, 2, "page count accumulates within a tab");
        let s = zero_page(id);
        assert_eq!(page_map().lock().unwrap().get(&id).copied(), Some(0));
        // zero_page returns the *session* total, which is monotonic and unaffected.
        let (s_after, p_after) = bump_blocked(id);
        assert_eq!(p_after, 1, "page count restarts at 1 after a reset");
        assert!(
            s_after >= s,
            "session total is monotonic across a page reset"
        );
    }

    #[test]
    fn session_count_is_shared_across_tabs_and_monotonic() {
        let (a, b) = (9101, 9102);
        zero_page(a);
        zero_page(b);
        let before = session_blocked();
        let (sa, pa) = bump_blocked(a);
        let (sb, pb) = bump_blocked(b);
        assert_eq!(pa, 1, "tab a's page count is independent");
        assert_eq!(pb, 1, "tab b's page count is independent");
        assert!(sb > sa, "session total advances across different tabs");
        // SESSION_BLOCKED is global — other tests may interleave, so we assert
        // deltas relative to `before` rather than exact values.
        assert!(sa > before, "sa advanced past before");
        assert!(sb >= before + 2, "sb advanced past sa");
    }
}
