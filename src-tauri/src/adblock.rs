//! Ad-block on/off + allowlist state, and the `adblock.*` IPC. On Linux,
//! enabling re-installs the WebKit content filters (cached → fast) and disabling
//! removes them. Per-host allowlisting on the declarative WebKit tier requires
//! rebuilding filters with ignore-previous-rules exceptions — for now the host is
//! recorded in state (a follow-up applies it to the filters).
use std::collections::HashMap;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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
fn active_page_blocked(app: &AppHandle) -> u32 {
    let id = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| s.reg.lock().unwrap().active_id())
        .unwrap_or(1);
    page_map().lock().unwrap().get(&id).copied().unwrap_or(0)
}

/// Count one blocked subresource on tab `id` and push the running totals to the chrome
/// badge via `adblock.blockedCount`.
#[allow(dead_code)] // counting currently hooks the Linux resource-load-started signal; Win/Android is a follow-up
pub fn note_blocked(app: &AppHandle, id: u32) {
    let session = SESSION_BLOCKED.fetch_add(1, Ordering::Relaxed) + 1;
    let page = {
        let mut m = page_map().lock().unwrap();
        let c = m.entry(id).or_insert(0);
        *c += 1;
        *c
    };
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": page, "session": session }),
    );
}

/// Reset a tab's per-page blocked count on a new top-frame navigation, and refresh the
/// badge (page → 0, session unchanged).
#[allow(dead_code)] // called from the Linux nav path; Win/Android badge counting is a follow-up
pub fn reset_page(app: &AppHandle, id: u32) {
    page_map().lock().unwrap().insert(id, 0);
    crate::emit_event(
        app,
        "adblock.blockedCount",
        json!({ "viewId": id, "page": 0, "session": session_blocked() }),
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

fn state_json(app: &AppHandle) -> Value {
    match app.try_state::<AdblockState>() {
        Some(s) => {
            let g = s.0.lock().unwrap();
            json!({ "enabled": g.enabled, "allowlistedHosts": g.allowlist, "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) })
        }
        None => json!({ "enabled": true, "allowlistedHosts": [], "sessionBlocked": session_blocked(), "pageBlocked": active_page_blocked(app) }),
    }
}

/// Mirror the ad-block policy (on/off + allowlist) into the matching engine. Android
/// honors it in `shouldInterceptRequest`; Windows in its WebView2 interceptor; all
/// desktops in `nav::on_new_window` (pop-under blocking). On Linux the page-resource
/// blocking is the WebKit content filters (reconfigured directly above) — the engine
/// is consulted only for pop-unders, but it still must honor the toggle + allowlist.
fn sync_engine(app: &AppHandle) {
    #[cfg(any(desktop, target_os = "android", test))]
    if let Some(s) = app.try_state::<AdblockState>() {
        let g = s.0.lock().unwrap();
        crate::adblock_engine::set_policy(g.enabled, &g.allowlist);
    }
    #[cfg(not(any(desktop, target_os = "android", test)))]
    let _ = app;
}

/// Handle `adblock.*` channels. Returns `None` if not an adblock channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "adblock.getState" => Some(Ok(state_json(app))),

        "adblock.setEnabled" => {
            let enabled = payload.get("enabled").and_then(Value::as_bool).unwrap_or(true);
            if let Some(s) = app.try_state::<AdblockState>() {
                s.0.lock().unwrap().enabled = enabled;
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
            let host = payload.get("host").and_then(Value::as_str).unwrap_or("").to_string();
            if let Some(s) = app.try_state::<AdblockState>() {
                let mut g = s.0.lock().unwrap();
                if channel == "adblock.removeAllowlist" {
                    g.allowlist.retain(|h| h != &host);
                } else if let Some(i) = g.allowlist.iter().position(|h| h == &host) {
                    g.allowlist.remove(i);
                } else if !host.is_empty() {
                    g.allowlist.push(host);
                }
            }
            sync_engine(app);
            Some(Ok(state_json(app)))
        }

        "adblock.clearAllowlist" => {
            if let Some(s) = app.try_state::<AdblockState>() {
                s.0.lock().unwrap().allowlist.clear();
            }
            sync_engine(app);
            Some(Ok(state_json(app)))
        }

        _ => None,
    }
}
