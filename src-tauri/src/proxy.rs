//! Pure `ProxyConfig` parse/validate/URI core. No Tauri types — fully unit-tested.
//! The Tauri layer (Tasks 2-6) reads `default_uri()` and `bypass_hosts` to configure
//! the content webview's proxy on every platform.

// Tasks 2-6 consume this module; suppress dead-code warnings until they are wired in.
#![allow(dead_code)]

use serde_json::Value;
use std::net::ToSocketAddrs;
use std::sync::Mutex;
use tauri::{AppHandle, Manager, Runtime};

/// Parsed, validated proxy configuration.
///
/// Field invariants (enforced by `from_value`, not the struct itself):
/// - `mode`   : `"off"` | `"proxy"` (anything else → `is_active()` == false)
/// - `scheme` : `"http"` | `"socks5"` (anything else → `is_active()` == false)
/// - `host`   : trimmed; empty string when absent
/// - `port`   : 0 when absent or out of range (1–65535)
/// - `bypass_hosts`: trimmed, non-empty strings from a JSON array of strings
///
/// The canonical on-disk and IPC key for `bypass_hosts` is `"bypassHosts"` (matching
/// `settings.json`, `state_json`, and the TS `ProxyConfig` interface). The `serde`
/// rename ensures `serde_json::to_value` writes `"bypassHosts"` and `from_value`
/// reads it back — preventing the silent data-loss bug where persisted bypass hosts
/// were lost on restart because serde wrote `"bypass_hosts"` but `from_value` read `"bypass"`.
#[derive(Clone, Debug, PartialEq, serde::Serialize)]
pub struct ProxyConfig {
    pub mode: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
    #[serde(rename = "bypassHosts")]
    pub bypass_hosts: Vec<String>,
}

impl ProxyConfig {
    /// Parse a `serde_json::Value` (expected: a JSON object from the settings store)
    /// into a `ProxyConfig`. Missing or invalid fields fall back to safe defaults:
    /// `mode = "off"`, `scheme = "http"`, `host = ""`, `port = 0`, `bypass = []`.
    ///
    /// Out-of-range ports (0 or > 65535) are stored as 0, which makes `is_active()`
    /// return `false` so a broken config is never silently applied.
    pub fn from_value(v: &serde_json::Value) -> Self {
        let mode = v
            .get("mode")
            .and_then(|m| m.as_str())
            .unwrap_or("off")
            .trim()
            .to_string();

        let scheme = v
            .get("scheme")
            .and_then(|s| s.as_str())
            .unwrap_or("http")
            .trim()
            .to_string();

        let host = v
            .get("host")
            .and_then(|h| h.as_str())
            .unwrap_or("")
            .trim()
            .to_string();

        // Accept both integer and float JSON numbers; clamp to u16 range.
        let port_raw = v.get("port").and_then(|p| p.as_u64()).unwrap_or(0);
        let port: u16 = if (1..=65535).contains(&port_raw) {
            port_raw as u16
        } else {
            0
        };

        // Canonical key is "bypassHosts" (array of strings) — matches settings.json default,
        // state_json, and the TS ProxyConfig interface. The old "bypass" comma-string key is
        // removed; all persisted data uses the array form via the serde rename above.
        let bypass_hosts = v
            .get("bypassHosts")
            .and_then(|b| b.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            })
            .unwrap_or_default();

        ProxyConfig {
            mode,
            scheme,
            host,
            port,
            bypass_hosts,
        }
    }

    /// Returns `true` iff the config is fully valid and the proxy should be applied:
    /// - `mode == "proxy"`
    /// - `scheme` is one of `"http"` or `"socks5"`
    /// - `host` is non-empty
    /// - `port` is in 1–65535
    pub fn is_active(&self) -> bool {
        self.mode == "proxy"
            && (self.scheme == "http" || self.scheme == "socks5")
            && !self.host.is_empty()
            && self.port >= 1
    }

    /// Build the proxy URI string: `"<scheme>://<host>:<port>"`.
    /// Returns `None` when `is_active()` is false (i.e. mode=off, invalid config).
    pub fn default_uri(&self) -> Option<String> {
        if !self.is_active() {
            return None;
        }
        Some(format!("{}://{}:{}", self.scheme, self.host, self.port))
    }
}

// ---------------------------------------------------------------------------
// Tauri layer — Tasks 2-6 (managed state, IPC dispatch, apply stub, probe).
// ---------------------------------------------------------------------------

/// Managed proxy state. Seeded from `settings::proxy_config` at boot;
/// updated on `proxy.setConfig` / `proxy.clear`.
pub struct ProxyState(pub Mutex<ProxyConfig>);

impl Default for ProxyState {
    fn default() -> Self {
        ProxyState(Mutex::new(ProxyConfig {
            mode: "off".into(),
            scheme: "http".into(),
            host: String::new(),
            port: 8080,
            bypass_hosts: vec![],
        }))
    }
}

/// Read the current `ProxyConfig` from managed state, falling back to the
/// settings store if the state is not managed (e.g. minimal test harness).
pub fn current<R: Runtime>(app: &AppHandle<R>) -> ProxyConfig {
    if let Some(st) = app.try_state::<ProxyState>() {
        return st.0.lock().unwrap().clone();
    }
    ProxyConfig::from_value(&crate::settings::proxy_config(app))
}

/// Build the JSON payload returned by `proxy.getState` and emitted as `proxy.state`.
fn state_json<R: Runtime>(app: &AppHandle<R>) -> Value {
    let cfg = current(app);
    let active = cfg.is_active();
    let uri = cfg.default_uri();
    serde_json::json!({
        "mode": cfg.mode,
        "scheme": cfg.scheme,
        "host": cfg.host,
        "port": cfg.port,
        "bypassHosts": cfg.bypass_hosts,
        "active": active,
        "uri": uri,
    })
}

/// Apply the active proxy config to a single content webview (identified by tab id).
/// Linux: routes through WebKitGTK `WebsiteDataManager::set_network_proxy_settings` (live).
/// Windows: SPAWN-TIME only — the proxy is baked into `--proxy-server` via
///   `additional_browser_args` in `nav::spawn_tab` at webview creation. WebView2 browser
///   args are IMMUTABLE after creation, so this live setter is a deliberate no-op: changing
///   the proxy on Windows takes effect only when the tab is reloaded / a new tab is opened.
///   The `apply` → `emit_event("proxy.state")` path still runs so the chrome's UI reflects
///   the new config immediately; only the actual egress proxy of live open tabs is unaffected.
///   (Task 9 docs should surface: "On Windows, reload the tab to apply a proxy change.")
/// macOS: NOT implemented — direct connection (no proxy applied).
///   The proper fix is a hand-rolled Network.framework / objc2 binding that sets
///   `WKWebsiteDataStore.proxyConfigurations` (macOS 14+). That binding requires
///   `nw_proxy_config_*` / `nw_endpoint_create_host` FFI signatures that cannot be
///   verified without a macOS toolchain (objc2 cannot be compiled from Linux).
///   Deferred to a Mac-developer follow-up (sub-project I). macOS builds and runs,
///   just with no proxy support.
///   See `docs/roadmap/macOS-proxy-bindings.md` for the full implementation guide.
pub fn apply_to_tab<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let cfg = current(app);
    #[cfg(target_os = "linux")]
    crate::linux_layout::apply_proxy_label(app, &crate::nav::content_label(id), &cfg);
    // macOS: documented no-op — direct connection. Network.framework binding deferred
    // to a Mac-developer follow-up; see doc-comment above and
    // docs/roadmap/macOS-proxy-bindings.md.
    #[cfg(target_os = "macos")]
    let _ = (id, cfg);
    // Windows: spawn-time only (see doc-comment above).
    // Android: proxy is applied via the AegisAndroid bridge + ProxyController at boot
    // and on every proxy.setConfig / proxy.clear call via apply() → note_config().
    // Neither platform has a live per-tab setter here.
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let _ = (id, cfg);
}

/// Re-apply the active proxy config to every existing live content webview, then
/// emit `proxy.state` so the chrome reflects the new config immediately.
///
/// On Android: also pushes the config to `ANDROID_PROXY_CONFIG` so the Kotlin
/// boot-apply (and any subsequent `NativeProxy.proxyConfig()` call) reads the
/// current config without an `AppHandle`. The chrome's `AegisAndroid.setProxy` /
/// `clearProxy` bridge methods apply it to `ProxyController` process-globally.
pub fn apply<R: Runtime>(app: &AppHandle<R>) {
    if let Some(s) = app.try_state::<crate::tabs::Tabs>() {
        let ids: Vec<u32> = s.reg.lock().unwrap().all_ids();
        for id in ids {
            apply_to_tab(app, id);
        }
    }
    #[cfg(target_os = "android")]
    note_config(&current(app));
    crate::emit_event(app, "proxy.state", state_json(app));
}

/// Android-only: the serialized proxy config the `NativeProxy.proxyConfig()` JNI getter
/// reads. Seeded at boot (by `apply` → here) and updated on every `proxy.setConfig` /
/// `proxy.clear` (again via `apply`). The JNI getter has no `AppHandle`, so the config
/// is pushed into this global by the Rust side.
///
/// The value is a compact JSON object matching the `ProxyConfig` serde shape:
/// `{"mode":"proxy","scheme":"http","host":"...","port":8080,"bypassHosts":[...]}`.
/// The Kotlin side parses it, then calls `ProxyController.setProxyOverride` /
/// `clearProxyOverride` through the `AegisAndroid` bridge.
#[cfg(target_os = "android")]
static ANDROID_PROXY_CONFIG: std::sync::RwLock<String> = std::sync::RwLock::new(String::new());

/// Push the current proxy config to the Android-side global so the Kotlin boot-apply
/// can read it via the `NativeProxy.proxyConfig()` JNI getter. Android-only.
#[cfg(target_os = "android")]
pub fn note_config(cfg: &ProxyConfig) {
    let json = serde_json::to_string(cfg).unwrap_or_default();
    if let Ok(mut g) = ANDROID_PROXY_CONFIG.write() {
        *g = json;
    }
}

/// JNI bridge for Android's `NativeProxy.proxyConfig()`. Returns the serialized
/// `ProxyConfig` JSON for the current proxy settings, so the Kotlin boot-apply can
/// call `ProxyController.setProxyOverride` without an `AppHandle`. Returns a null
/// jstring on failure (Kotlin treats that as "use direct / no proxy").
///
/// Panic-safe via `catch_unwind` — a JNI frame that unwinds across a non-unwinding
/// boundary causes SIGABRT (see the Android JNI crash gotcha in the project memory).
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeProxy_proxyConfig<'a>(
    env: jni::JNIEnv<'a>,
    _this: jni::objects::JObject<'a>,
) -> jni::sys::jstring {
    let result = std::panic::catch_unwind(|| {
        ANDROID_PROXY_CONFIG
            .read()
            .map(|g| g.clone())
            .unwrap_or_default()
    });
    let json = result.unwrap_or_default();
    match env.new_string(json) {
        Ok(s) => s.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Route `proxy.*` IPC channels. Returns `None` for unowned channels.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "proxy.getState" => Some(Ok(state_json(app))),

        "proxy.setConfig" | "proxy.clear" => {
            let cfg = if channel == "proxy.clear" {
                ProxyConfig {
                    mode: "off".into(),
                    ..current(app)
                }
            } else {
                ProxyConfig::from_value(payload.get("config").unwrap_or(&Value::Null))
            };
            // Persist into settings.json's `proxy` key (exported/imported with data.export).
            let mut s = crate::settings::all(app);
            if let Some(o) = s.as_object_mut() {
                o.insert(
                    "proxy".into(),
                    serde_json::to_value(&cfg).unwrap_or(Value::Null),
                );
            }
            crate::settings::write(app, &s);
            if let Some(st) = app.try_state::<ProxyState>() {
                *st.0.lock().unwrap() = cfg;
            }
            apply(app);
            Some(Ok(state_json(app)))
        }

        "proxy.testConnection" => {
            let cfg = ProxyConfig::from_value(payload.get("config").unwrap_or(&Value::Null));
            Some(Ok(test_connection(&cfg)))
        }

        _ => None,
    }
}

/// TCP-connect probe: attempts to reach `cfg.host:cfg.port` within 3 s.
/// Returns `{ ok, latencyMs?, error? }`.
///
/// Proves host:port is TCP-reachable, NOT that traffic egresses through the proxy.
/// The live egress trace (Task 9) is the definitive proof.
pub fn test_connection(cfg: &ProxyConfig) -> Value {
    if cfg.host.is_empty() {
        return serde_json::json!({ "ok": false, "error": "host is empty" });
    }
    let addr_str = format!("{}:{}", cfg.host, cfg.port);
    let t0 = std::time::Instant::now();
    match addr_str.to_socket_addrs().ok().and_then(|mut a| a.next()) {
        None => serde_json::json!({
            "ok": false,
            "error": format!("could not resolve '{addr_str}'"),
        }),
        Some(addr) => {
            match std::net::TcpStream::connect_timeout(&addr, std::time::Duration::from_secs(3)) {
                Ok(_) => {
                    let ms = t0.elapsed().as_millis() as u64;
                    serde_json::json!({ "ok": true, "latencyMs": ms })
                }
                Err(e) => serde_json::json!({ "ok": false, "error": e.to_string() }),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_value_applies_defaults_and_clamps() {
        let v = serde_json::json!({ "mode": "proxy", "scheme": "socks5", "host": "10.0.0.9", "port": 1080 });
        let c = ProxyConfig::from_value(&v);
        assert_eq!(c.mode, "proxy");
        assert_eq!(c.scheme, "socks5");
        assert_eq!(c.host, "10.0.0.9");
        assert_eq!(c.port, 1080);
        // Missing object → all defaults, OFF.
        let d = ProxyConfig::from_value(&serde_json::json!({}));
        assert_eq!(d.mode, "off");
        assert!(!d.is_active());
        // Out-of-range / zero port on an ON config → not active (won't be applied).
        let bad = ProxyConfig::from_value(
            &serde_json::json!({ "mode": "proxy", "host": "h", "port": 0 }),
        );
        assert!(!bad.is_active());
    }

    #[test]
    fn is_active_requires_on_mode_host_port_scheme() {
        let on = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "p.example".into(),
            port: 8080,
            bypass_hosts: vec![],
        };
        assert!(on.is_active());
        let off = ProxyConfig {
            mode: "off".into(),
            ..on.clone()
        };
        assert!(!off.is_active());
        let nohost = ProxyConfig {
            host: "".into(),
            ..on.clone()
        };
        assert!(!nohost.is_active());
        let badscheme = ProxyConfig {
            scheme: "ftp".into(),
            ..on.clone()
        };
        assert!(!badscheme.is_active());
    }

    #[test]
    fn default_uri_builds_scheme_host_port_or_none_when_off() {
        let http = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "p".into(),
            port: 3128,
            bypass_hosts: vec![],
        };
        assert_eq!(http.default_uri().as_deref(), Some("http://p:3128"));
        let socks = ProxyConfig {
            scheme: "socks5".into(),
            ..http.clone()
        };
        assert_eq!(socks.default_uri().as_deref(), Some("socks5://p:3128"));
        assert_eq!(
            ProxyConfig {
                mode: "off".into(),
                ..http
            }
            .default_uri(),
            None
        );
    }

    // Additional coverage beyond the brief's required cases.

    #[test]
    fn port_boundary_values() {
        // Port 1 is valid.
        let c = ProxyConfig::from_value(
            &serde_json::json!({ "mode": "proxy", "scheme": "http", "host": "h", "port": 1 }),
        );
        assert!(c.is_active());
        assert_eq!(c.port, 1);
        // Port 65535 is valid.
        let c = ProxyConfig::from_value(
            &serde_json::json!({ "mode": "proxy", "scheme": "http", "host": "h", "port": 65535 }),
        );
        assert!(c.is_active());
        assert_eq!(c.port, 65535);
        // Port 65536 is out of range → stored as 0 → not active.
        let c = ProxyConfig::from_value(
            &serde_json::json!({ "mode": "proxy", "scheme": "http", "host": "h", "port": 65536 }),
        );
        assert!(!c.is_active());
        assert_eq!(c.port, 0);
    }

    #[test]
    fn bypass_parsing_splits_and_trims() {
        // Canonical form: "bypassHosts" as a JSON array of strings.
        let v = serde_json::json!({
            "mode": "proxy", "scheme": "http", "host": "h", "port": 8080,
            "bypassHosts": ["localhost", " 127.0.0.1 ", "::1", "", "internal.corp"]
        });
        let c = ProxyConfig::from_value(&v);
        assert_eq!(
            c.bypass_hosts,
            vec!["localhost", "127.0.0.1", "::1", "internal.corp"]
        );
    }

    #[test]
    fn bypass_missing_yields_empty_vec() {
        let v = serde_json::json!({ "mode": "proxy", "scheme": "http", "host": "h", "port": 8080 });
        let c = ProxyConfig::from_value(&v);
        assert!(c.bypass_hosts.is_empty());
    }

    /// Regression guard for the bypass-hosts data-loss bug:
    /// `serde_json::to_value` (used by `proxy.setConfig` to persist) must write
    /// `"bypassHosts"` (not `"bypass_hosts"`), and `from_value` must read it back —
    /// so bypass hosts survive a restart.  This test FAILS before the fix and PASSES
    /// after (the `#[serde(rename = "bypassHosts")]` + array `from_value` path).
    #[test]
    fn bypass_hosts_survive_serde_roundtrip() {
        let original = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "proxy.corp".into(),
            port: 3128,
            bypass_hosts: vec!["localhost".into(), "192.168.0.0/24".into(), "*.corp".into()],
        };
        // Simulate what proxy.setConfig does: serialize to Value (written to settings.json).
        let serialized = serde_json::to_value(&original).expect("serialize");
        // Confirm the key is "bypassHosts", not "bypass_hosts" or "bypass".
        assert!(
            serialized.get("bypassHosts").is_some(),
            "serde must write 'bypassHosts' key, got: {serialized}"
        );
        assert!(
            serialized.get("bypass_hosts").is_none(),
            "serde must NOT write 'bypass_hosts'"
        );
        // Simulate what proxy_config + from_value does at boot: deserialize back.
        let reloaded = ProxyConfig::from_value(&serialized);
        assert_eq!(
            reloaded.bypass_hosts, original.bypass_hosts,
            "bypass hosts must survive the serde round-trip"
        );
    }

    #[test]
    fn host_and_scheme_are_trimmed() {
        let v = serde_json::json!({ "mode": "proxy", "scheme": " http ", "host": "  proxy.local  ", "port": 3128 });
        let c = ProxyConfig::from_value(&v);
        assert_eq!(c.scheme, "http");
        assert_eq!(c.host, "proxy.local");
        assert!(c.is_active());
    }

    #[test]
    fn unknown_mode_is_not_active() {
        let c = ProxyConfig::from_value(
            &serde_json::json!({ "mode": "manual", "scheme": "http", "host": "h", "port": 8080 }),
        );
        assert!(!c.is_active());
        assert_eq!(c.default_uri(), None);
    }

    #[test]
    fn default_uri_uses_correct_port_in_uri() {
        let c = ProxyConfig {
            mode: "proxy".into(),
            scheme: "socks5".into(),
            host: "10.0.0.9".into(),
            port: 1080,
            bypass_hosts: vec![],
        };
        assert_eq!(c.default_uri().as_deref(), Some("socks5://10.0.0.9:1080"));
    }

    #[test]
    fn test_connection_reachable() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let cfg = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "127.0.0.1".into(),
            port,
            bypass_hosts: vec![],
        };
        let result = test_connection(&cfg);
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert!(result.get("latencyMs").is_some());
    }

    #[test]
    fn test_connection_unreachable() {
        // Bind briefly to get a free port, then drop so it's closed.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let cfg = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "127.0.0.1".into(),
            port,
            bypass_hosts: vec![],
        };
        let result = test_connection(&cfg);
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
        assert!(result.get("error").is_some());
    }

    #[test]
    fn test_connection_empty_host() {
        let cfg = ProxyConfig {
            mode: "proxy".into(),
            scheme: "http".into(),
            host: "".into(),
            port: 8080,
            bypass_hosts: vec![],
        };
        let result = test_connection(&cfg);
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(false));
    }
}
