//! Ad-block on/off + allowlist state, and the `adblock.*` IPC. On Linux,
//! enabling re-installs the WebKit content filters (cached → fast) and disabling
//! removes them. Per-host allowlisting on the declarative WebKit tier requires
//! rebuilding filters with ignore-previous-rules exceptions — for now the host is
//! recorded in state (a follow-up applies it to the filters).
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

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
            json!({ "enabled": g.enabled, "allowlistedHosts": g.allowlist, "sessionBlocked": 0 })
        }
        None => json!({ "enabled": true, "allowlistedHosts": [], "sessionBlocked": 0 }),
    }
}

/// Mirror the ad-block policy (on/off + allowlist) into the Android matching engine,
/// which honors it in `shouldInterceptRequest`. No-op on desktop, where the WebKit
/// filters are reconfigured directly above.
fn sync_engine(app: &AppHandle) {
    #[cfg(target_os = "android")]
    if let Some(s) = app.try_state::<AdblockState>() {
        let g = s.0.lock().unwrap();
        crate::adblock_engine::set_policy(g.enabled, &g.allowlist);
    }
    #[cfg(not(target_os = "android"))]
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
