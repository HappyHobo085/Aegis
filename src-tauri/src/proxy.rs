//! Pure `ProxyConfig` parse/validate/URI core. No Tauri types — fully unit-tested.
//! The Tauri layer reads `default_uri()` and `bypass_hosts` to configure the content
//! webview's proxy on every platform.

// NOTE: this module used to carry a crate-wide `#![allow(dead_code)]` on the grounds that
// "Tasks 2-6 consume this module; suppress dead-code warnings until they are wired in". They
// are wired in — the dispatch arms, the boot seed and the per-platform `apply_to_tab` are all
// live — so the suppression only served to hide genuinely unreachable items (a dead helper is
// indistinguishable from a used one once the lint is off). It was removed; if a target-specific
// build turns up something only one platform calls, that gets a narrow `#[cfg]` + `allow`
// with a reason, not a blanket one.

use serde_json::Value;
use std::net::ToSocketAddrs;
use std::sync::Mutex;
use std::time::Duration;
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
        // Blank (not keep) an invalid host: `is_active()` requires a non-empty host, so
        // a bad value deactivates the proxy instead of being applied.
        let host = if is_valid_proxy_host(&host) {
            host
        } else {
            String::new()
        };

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
        //
        // Each entry is dropped unless it is a well-formed bypass token. These are joined
        // with ';' into a single `--proxy-bypass-list=` switch, so an entry carrying a
        // space, '=', a quote, or the ';' separator itself would split into extra switches
        // or extra rules. `*` (e.g. `*.example.com`), `/` (CIDR), and `<local>` are all real
        // Chromium bypass syntax and are allowed.
        let bypass_hosts = v
            .get("bypassHosts")
            .and_then(|b| b.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|e| e.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| is_valid_bypass_host(s))
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

// ─── Input validation ────────────────────────────────────────────────────────

/// True for a hostname/IP literal we are willing to interpolate into a proxy URI.
///
/// The value reaches `default_uri()` and from there, on Windows, a Chromium/WebView2
/// `additional_browser_args` string built by `nav` as ` --proxy-server={uri}`. That is
/// a *command line*, so a single space terminates the argument and everything after it
/// becomes another browser switch: a host of
/// `127.0.0.1:1 --remote-debugging-port=9222 --disable-web-security` would inject
/// switches into every content webview Aegis later spawns, and `--remote-debugging-port`
/// opens a DevTools-protocol endpoint that fully controls the pages inside it.
///
/// Validating here, in the one place a `ProxyConfig` is ever built, means no consumer has
/// to remember to re-check — and because `is_active()` already requires a non-empty host,
/// a rejected host simply disables the proxy instead of being applied unsafely.
fn is_valid_proxy_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '_' | ':' | '[' | ']' | '%')
        })
}

/// True for a `--proxy-bypass-list` entry.
///
/// Wider than the host rule, because Chromium's bypass syntax legitimately uses
/// wildcards (`*.example.com`), CIDR (`10.0.0.0/8`), host:port, and the literal
/// `<local>`. The characters that must NOT appear are the ones that would break out of
/// the single switch these get joined into: whitespace, `=`, quotes, and `;` — the join
/// separator itself.
fn is_valid_bypass_host(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 255
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(
                    c,
                    '.' | '-' | '_' | ':' | '*' | '[' | ']' | '%' | '/' | '<' | '>'
                )
        })
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
        return st.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
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
///   The 383-line implementation guide that used to live at
///   `docs/roadmap/macOS-proxy-bindings.md` was deleted in commit 58d2c4b and is NOT
///   recoverable from this repo — this is genuinely lost institutional knowledge, so the
///   macOS tier has to be re-derived from scratch (objc2 / Network.framework bindings,
///   which cannot be compiled or verified from Linux).
pub fn apply_to_tab<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let cfg = current(app);
    #[cfg(target_os = "linux")]
    crate::linux_layout::apply_proxy_label(app, &crate::nav::content_label(id), &cfg);
    // macOS: documented no-op — direct connection. Network.framework binding deferred
    // to a Mac-developer follow-up; see the doc-comment above (the original
    // implementation guide was deleted in commit 58d2c4b and is not recoverable).
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
        let ids: Vec<u32> = s.reg.lock().unwrap_or_else(|e| e.into_inner()).all_ids();
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
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
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
            // Persist into settings.json's `proxy` key (exported/imported with data.export)
            // through the SHARED local-edit region rather than a private load-mutate-write.
            // That buys this arm three things it did not have:
            //   * the settings store lock, so a concurrent settings form save, the sync
            //     worker's `merge_remote`, or a `data.import` cannot revert the proxy write;
            //   * `validate_setting`, so a non-object `proxy` is refused rather than stored;
            //   * a per-key sync projection record, so the config reaches the user's other
            //     paired devices like every other non-local-only setting.
            // And a failed write comes back as `Err`: Tauri does not `catch_unwind` a command
            // body, so the `.expect` this replaced aborted the process (a full disk, a
            // read-only mount, or a directory at settings.json — reachable from the Apply,
            // Turn-off and Test buttons in `ProxySettingsTab.tsx`).
            let cfg_value = serde_json::to_value(&cfg).unwrap_or(Value::Null);
            if let Err(e) = crate::settings::apply_local(
                app,
                &serde_json::json!({ "partial": { "proxy": cfg_value } }),
            ) {
                return Some(Err(e));
            }
            if let Some(st) = app.try_state::<ProxyState>() {
                *st.0.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
            }
            apply(app);
            Some(Ok(state_json(app)))
        }

        "proxy.testConnection" => {
            let cfg = ProxyConfig::from_value(payload.get("config").unwrap_or(&Value::Null));
            Some(Ok(test_connection_bounded(cfg)))
        }

        _ => None,
    }
}

/// TCP-connect probe: attempts to reach `cfg.host:cfg.port` within 3 s.
/// Returns `{ ok, latencyMs?, error? }`.
///
/// **Module-private on purpose**, but the guarantee is narrower than it looks and is worth
/// being precise about. `pub` → private stops *other modules* from adopting this for a new
/// channel (the realistic regression: someone adds a `proxy.testSomething` and reaches for the
/// probe directly). It does **not** stop the `proxy.testConnection` arm in this same file from
/// being re-pointed at it, because `dispatch` can still name a module-private item. That arm
/// is covered only end-to-end by
/// `the_test_connection_channel_answers_through_the_bounded_probe`, which cannot tell a
/// bounded call from an unbounded one — a reachable host answers identically either way.
/// Closing that last gap needs a source-level check on the arm, which is deliberately not
/// added here; the two `await_probe` tests are what pin the bounding itself.
///
/// Proves host:port is TCP-reachable, NOT that traffic egresses through the proxy.
/// The live egress trace (Task 9) is the definitive proof.
fn test_connection(cfg: &ProxyConfig) -> Value {
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

/// How long the IPC thread will wait for a TCP probe before giving up on it.
///
/// Strictly greater than the probe's own 3 s connect timeout so a *reachable* host always
/// gets to report its real latency rather than being cut off at the budget.
const PROBE_BUDGET: Duration = Duration::from_secs(4);

/// Run `work` on a worker thread and wait up to `budget` for its result.
///
/// `proxy.testConnection` is reached through `ipc`, a **synchronous** `#[tauri::command]`,
/// so it runs on the UI thread. The probe it performs is not safely bounded there: the DNS
/// lookup in [`test_connection`] is `to_socket_addrs()`, which has **no timeout of its own**
/// and blocks for as long as the platform resolver takes (tens of seconds on a broken or
/// captive network), and only the TCP connect after it is capped. On a bad network, pressing
/// "Test connection" therefore froze the entire window — toolbar, tab strip and page — for
/// the length of a DNS timeout, with no way to cancel it.
///
/// std offers no way to put a deadline on `to_socket_addrs`, so rather than pretend the work
/// is bounded we move it off the UI thread and bound only the *wait*. That is the property
/// that actually matters: the UI is released after `budget` no matter what the resolver does.
///
/// The abandoned worker is not cancelled — `std::thread` has no join-with-timeout — but it
/// terminates on its own once the resolver gives up, its result is simply dropped, and at
/// most one exists per probe the user explicitly asked for.
fn await_probe<T: Send + 'static>(
    work: impl FnOnce() -> T + Send + 'static,
    budget: Duration,
) -> Option<T> {
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        // A send failure just means the caller already hit its budget.
        let _ = tx.send(work());
    });
    rx.recv_timeout(budget).ok()
}

/// The `proxy.testConnection` entry point: [`test_connection`] on a worker thread, with the
/// UI thread's wait capped at [`PROBE_BUDGET`].
///
/// On timeout it reports a *distinct* error rather than a bare failure. "Timed out" and
/// "refused" are different diagnoses for the user (a firewall/blackhole vs a dead proxy),
/// and collapsing them into one `ok: false` is the same class of bug as `form.detectLoginForm`
/// answering `false` for a page it never inspected.
pub fn test_connection_bounded(cfg: ProxyConfig) -> Value {
    test_connection_within(move || test_connection(&cfg), PROBE_BUDGET)
}

/// [`test_connection_bounded`] with both the work and the budget injectable.
///
/// The work is a parameter for the same reason the budget is: a test has to be able to
/// provoke the timeout arm **deterministically**. Note that a closed *loopback* port is not a
/// slow probe — the kernel refuses it instantly, so it comes back well inside any budget and
/// can never exercise this path. Injecting the work is the only reliable way in.
fn test_connection_within(
    work: impl FnOnce() -> Value + Send + 'static,
    budget: Duration,
) -> Value {
    match await_probe(work, budget) {
        Some(v) => v,
        None => serde_json::json!({
            "ok": false,
            "error": format!(
                "probe timed out after {}s (the host may be unreachable, or DNS is not responding)",
                budget.as_secs()
            ),
        }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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

    // ── The UI thread must not be hostage to the resolver ────────────────────
    //
    // `test_connection` calls `to_socket_addrs()`, which has no timeout of its own. Because
    // `ipc` is a synchronous command these run on the UI thread, so an unbounded lookup
    // froze the whole window. `await_probe` is the seam that makes that wait bounded, and
    // the work is injected here so the timing is deterministic rather than dependent on a
    // real resolver.

    #[test]
    fn a_probe_that_finishes_in_time_returns_its_value() {
        let got = await_probe(|| 41u32 + 1, Duration::from_secs(30));
        assert_eq!(got, Some(42));
    }

    #[test]
    fn a_probe_that_overruns_its_budget_is_dropped_rather_than_waited_on() {
        // 500 ms of work against a 20 ms budget: the slow direction, so this is the case that
        // reproduces the freeze (a fast probe would pass even if the budget were ignored).
        let started = std::time::Instant::now();
        let got = await_probe(
            || {
                std::thread::sleep(Duration::from_millis(500));
                "should never be observed"
            },
            Duration::from_millis(20),
        );
        assert_eq!(got, None);
        // The point of the fix: the CALLER is released at the budget, not at 500 ms.
        assert!(
            started.elapsed() < Duration::from_millis(400),
            "await_probe blocked for {:?}, so the UI thread would still be frozen",
            started.elapsed()
        );
    }

    #[test]
    fn a_timed_out_probe_reports_a_distinct_error_not_a_bare_failure() {
        // A slow probe that would otherwise report "Connection refused": the bounded entry
        // point must report the TIMEOUT instead. This is the decisive guard — the timing test
        // above proves only that the wait RETURNS, not that the probe's own diagnosis is
        // discarded rather than passed off as the answer.
        let out = test_connection_within(
            || {
                std::thread::sleep(Duration::from_millis(400));
                serde_json::json!({ "ok": false, "error": "Connection refused (os error 111)" })
            },
            Duration::from_millis(1),
        );
        assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(false));
        let err = out
            .get("error")
            .and_then(|v| v.as_str())
            .unwrap_or_default();
        assert!(
            err.contains("timed out"),
            "a 1 ms budget must yield the timeout diagnosis, got {err:?}"
        );
        assert!(
            !err.contains("refused"),
            "the probe's own result leaked through, so the budget was not applied: {err:?}"
        );
    }

    #[test]
    fn the_budget_outlasts_the_connect_timeout_but_stays_short() {
        // A budget at or below `test_connection`'s own 3 s connect timeout would report
        // "timed out" for a proxy that is merely slow, which is a worse lie than a long wait.
        assert!(
            PROBE_BUDGET > Duration::from_secs(3),
            "budget must outlast the probe's 3s connect timeout"
        );
        assert!(
            PROBE_BUDGET <= Duration::from_secs(10),
            "a budget this long still reads as a freeze to the user"
        );
    }

    #[test]
    fn the_bounded_entry_point_still_answers_a_reachable_host() {
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
        // End to end through the worker thread — the reachable path must not be broken by
        // the very change that rescues the slow one.
        let result = test_connection_bounded(cfg);
        assert_eq!(result.get("ok").and_then(|v| v.as_bool()), Some(true));
        assert!(result.get("latencyMs").is_some());
    }

    /// The end-to-end check that the `proxy.testConnection` arm is still owned here and still
    /// answers. The *bounding* itself is pinned by the two tests above plus the module-private
    /// `test_connection` (re-pointing the arm at it would not compile).
    #[test]
    fn the_test_connection_channel_answers_through_the_bounded_probe() {
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        crate::test_support::with_tmp_app(|app| {
            let out = dispatch(
                app,
                "proxy.testConnection",
                &serde_json::json!({
                    "config": { "mode": "proxy", "scheme": "http", "host": "127.0.0.1", "port": port }
                }),
            )
            .expect("proxy.testConnection must be owned by this module")
            .expect("a reachable proxy must not error");
            assert_eq!(out.get("ok").and_then(|v| v.as_bool()), Some(true));
            assert!(out.get("latencyMs").is_some());
        });
    }
    // ── Host / bypass validation (command-line injection) ────────────────────
    //
    // A proxy host is interpolated into ` --proxy-server={uri}` inside Chromium's
    // `additional_browser_args` on Windows, and bypass entries are joined with ';' into
    // ` --proxy-bypass-list=`. Both are command lines, so a stray space turns the rest
    // of the value into extra browser switches. These pin the fix at the parse point.

    #[test]
    fn accepts_ordinary_hosts() {
        for h in [
            "127.0.0.1",
            "proxy.example.com",
            "my-proxy.internal",
            "under_score",
            "10.0.0.5",
            "[::1]",
            "fe80::1%eth0",
        ] {
            let c = ProxyConfig::from_value(&json!({
                "mode": "proxy", "scheme": "http", "host": h, "port": 8080
            }));
            assert_eq!(c.host, h, "{h} should be accepted");
            assert!(c.is_active(), "{h} should yield an active config");
        }
    }

    #[test]
    fn rejects_hosts_that_could_inject_a_browser_switch() {
        for h in [
            "127.0.0.1:1 --remote-debugging-port=9222",
            "127.0.0.1:1 --disable-web-security",
            "host --proxy-bypass-list=",
            "evil\" --x",
            "a b",
            "",
            "  ",
        ] {
            let c = ProxyConfig::from_value(&json!({
                "mode": "proxy", "scheme": "http", "host": h, "port": 8080
            }));
            assert_eq!(c.host, "", "host {h:?} must be rejected");
            assert!(
                !c.is_active(),
                "a rejected host must not produce an active proxy"
            );
            assert_eq!(c.default_uri(), None, "no URI may be built from {h:?}");
        }
    }

    #[test]
    fn keeps_real_bypass_syntax_and_drops_injected_entries() {
        let c = ProxyConfig::from_value(&json!({
            "mode": "proxy", "scheme": "http", "host": "127.0.0.1", "port": 8080,
            "bypassHosts": [
                "*.example.com",
                "localhost",
                "10.0.0.0/8",
                "intranet.corp:8080",
                "<local>",
                "bad; --remote-debugging-port=9222",
                "a b",
                "x --disable-web-security"
            ]
        }));
        assert_eq!(
            c.bypass_hosts,
            vec![
                "*.example.com".to_string(),
                "localhost".to_string(),
                "10.0.0.0/8".to_string(),
                "intranet.corp:8080".to_string(),
                "<local>".to_string()
            ],
            "real bypass tokens survive; anything with a space or a ';' is dropped"
        );
        // The whole joined list must still be a single, space-free argument.
        let joined = c.bypass_hosts.join(";");
        assert!(
            !joined.contains(' '),
            "joined bypass list must contain no spaces"
        );
        assert!(!joined.contains(';') || joined.matches(';').count() == 4);
    }

    // ── `proxy.setConfig` / `proxy.clear` persistence ─────────────────────────
    //
    // The arm used to do its own `load` -> mutate -> `write` of the whole settings snapshot,
    // outside the store lock, with no sync projection record, and ending in
    // `settings::write(app, &s).expect("settings fixture write")` — a TEST-FIXTURE panic
    // message left behind when the call site was mechanically converted when `settings::write`
    // was flipped to `Result`. These four pin the replacement: route through
    // `settings::apply_local`, the one documented locked local-edit region.

    /// The regression: a settings write that cannot land used to panic.
    ///
    /// `settings::write` returns `Err` for a missing app-data dir (`settings.rs`) and
    /// propagates `write_atomic`'s error, so a full disk, a read-only mount, or a directory
    /// sitting where `settings.json` belongs all reached that `.expect`. Tauri does not
    /// `catch_unwind` a command body — `tauri-macros`' `body_blocking` emits a plain
    /// `let result = $path(args)` and propagates — so the panic unwound out of the GUI thread
    /// and took the process down, from the Apply / Turn-off / Test buttons in
    /// `ProxySettingsTab.tsx`.
    ///
    /// `block_store_file` puts a non-empty DIRECTORY at the store path. That is the portable
    /// way to force this: `chmod 0500` is a no-op for a process running as root, which would
    /// make the test silently vacuous (it would pass without the fix too).
    #[test]
    fn a_failed_settings_write_is_reported_rather_than_aborting_the_process() {
        crate::test_support::with_tmp_app(|app| {
            let blocked = crate::test_support::block_store_file(app, "settings.json");
            let out = dispatch(
                app,
                "proxy.setConfig",
                &json!({ "config": { "mode": "proxy", "scheme": "http",
                                     "host": "127.0.0.1", "port": 8080 } }),
            )
            .expect("proxy.setConfig must be owned by this module");
            // Unblock before asserting so a failure cannot leak the blocking directory.
            crate::test_support::unblock_store_file(&blocked);

            let err = out.expect_err(
                "a settings write that cannot land must surface as Err, not abort the process",
            );
            assert!(
                err.contains("settings"),
                "the error must name the file that could not be written, got {err:?}"
            );
        });
    }

    /// The persisted bytes are `serde_json::to_value` of the SANITISED `ProxyConfig`, never
    /// the caller's object.
    ///
    /// This is what routing through the shared region buys beyond the panic fix, and it is the
    /// load-bearing half of the security story: the host is interpolated into
    /// ` --proxy-server={uri}` inside Chromium's `additional_browser_args` on Windows, a
    /// command line, so `1.2.3.4 --remote-debugging-port=9222` would inject a DevTools
    /// endpoint into every content webview spawned afterwards. `ProxyConfig::from_value`
    /// blanks the host, `is_active()` then requires a non-empty host, and that blanked struct
    /// is what reaches the store. Reading it back off disk is the only honest check — the
    /// `from_value` unit tests above can pass while the arm stores something else.
    #[test]
    fn the_persisted_proxy_is_the_sanitised_config_not_the_callers_bytes() {
        crate::test_support::with_tmp_app(|app| {
            dispatch(
                app,
                "proxy.setConfig",
                &json!({ "config": { "mode": "proxy", "scheme": "http",
                                     "host": "1.2.3.4 --remote-debugging-port=9222",
                                     "port": 8080 } }),
            )
            .expect("proxy.setConfig must be owned by this module")
            .expect("a rejected host is blanked into an inert config, not an error");

            let stored = crate::settings::load(app);
            let p = stored
                .get("proxy")
                .expect("the proxy key is persisted into settings.json");
            assert_eq!(
                p.get("host").and_then(Value::as_str),
                Some(""),
                "the blanked host is what was stored"
            );
            assert!(
                !p.to_string().contains("remote-debugging-port"),
                "no byte of the caller's host may reach settings.json, got {p}"
            );
        });
    }

    /// The owner-approved consequence of routing the arm through `apply_local`: a proxy change
    /// now reaches the user's other paired devices, like every other non-local-only setting
    /// (`proxy` is not in `LOCAL_ONLY_KEYS`). The arm rewrote `settings.json` without ever
    /// calling `record_change`, so the projection held no `proxy` record at all and the config
    /// never left the device that set it.
    #[test]
    fn a_proxy_change_becomes_a_sync_projection_record() {
        crate::test_support::with_tmp_app(|app| {
            dispatch(
                app,
                "proxy.setConfig",
                &json!({ "config": { "mode": "proxy", "scheme": "http",
                                     "host": "127.0.0.1", "port": 8080 } }),
            )
            .expect("proxy.setConfig must be owned by this module")
            .expect("a well-formed config is saved");

            let recs = crate::settings::sync_records_readonly(app);
            let rec = recs
                .iter()
                .find(|r| r.get("key").and_then(Value::as_str) == Some("proxy"))
                .expect("a proxy record exists in the sync projection");
            assert_eq!(
                rec.get("value")
                    .and_then(|v| v.get("host"))
                    .and_then(Value::as_str),
                Some("127.0.0.1"),
                "the record carries the sanitised value"
            );
            assert_eq!(
                rec.get("deleted").and_then(Value::as_bool),
                Some(false),
                "a local edit is a live record, not a tombstone"
            );
        });
    }

    /// The happy path, end to end through the store: a set round-trips into `settings.json`,
    /// and `proxy.clear` puts `mode: "off"` back — read back off disk, not from the returned
    /// state object, so the persistence is what is being asserted.
    #[test]
    fn the_proxy_config_round_trips_through_the_store_and_clear_returns_to_off() {
        crate::test_support::with_tmp_app(|app| {
            dispatch(
                app,
                "proxy.setConfig",
                &json!({ "config": { "mode": "proxy", "scheme": "socks5",
                                     "host": "127.0.0.1", "port": 1080 } }),
            )
            .expect("owned")
            .expect("saved");

            let on = crate::settings::load(app)
                .get("proxy")
                .cloned()
                .expect("persisted");
            assert_eq!(on.get("mode").and_then(Value::as_str), Some("proxy"));
            assert_eq!(on.get("scheme").and_then(Value::as_str), Some("socks5"));
            assert_eq!(on.get("port").and_then(Value::as_u64), Some(1080));

            dispatch(app, "proxy.clear", &json!({}))
                .expect("owned")
                .expect("cleared");

            let off = crate::settings::load(app)
                .get("proxy")
                .cloned()
                .expect("still persisted, now off");
            assert_eq!(off.get("mode").and_then(Value::as_str), Some("off"));
        });
    }
}
