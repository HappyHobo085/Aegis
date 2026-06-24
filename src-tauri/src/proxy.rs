//! Pure `ProxyConfig` parse/validate/URI core. No Tauri types — fully unit-tested.
//! The Tauri layer (Tasks 2-6) reads `default_uri()` and `bypass_hosts` to configure
//! the content webview's proxy on every platform.

// Tasks 2-6 consume this module; suppress dead-code warnings until they are wired in.
#![allow(dead_code)]

/// Parsed, validated proxy configuration.
///
/// Field invariants (enforced by `from_value`, not the struct itself):
/// - `mode`   : `"off"` | `"proxy"` (anything else → `is_active()` == false)
/// - `scheme` : `"http"` | `"socks5"` (anything else → `is_active()` == false)
/// - `host`   : trimmed; empty string when absent
/// - `port`   : 0 when absent or out of range (1–65535)
/// - `bypass_hosts`: trimmed, non-empty items split from a comma-separated string
#[derive(Clone, Debug, PartialEq)]
pub struct ProxyConfig {
    pub mode: String,
    pub scheme: String,
    pub host: String,
    pub port: u16,
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

        let bypass_hosts = v
            .get("bypass")
            .and_then(|b| b.as_str())
            .map(parse_bypass)
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

/// Split a comma-separated bypass list into trimmed, non-empty host entries.
fn parse_bypass(raw: &str) -> Vec<String> {
    raw.split(',')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
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
        let v = serde_json::json!({
            "mode": "proxy", "scheme": "http", "host": "h", "port": 8080,
            "bypass": "localhost, 127.0.0.1 , ::1,, internal.corp"
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
}
