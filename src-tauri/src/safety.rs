//! Malicious-site protection (safety.* IPC). Top-level navigations to known-malware
//! hosts (bundled URLhaus blocklist) are blocked in the nav gate (nav.rs); the
//! content area shows a warning and a safety.interstitial event is emitted for the
//! chrome. Session-only exceptions let the user proceed. A fetched/auto-updated
//! blocklist + the chrome interstitial overlay (needs the z-swap) are follow-ups.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url};

/// Parsed malware hosts (bundled URLhaus hostfile), built once.
fn malware_hosts() -> &'static HashSet<String> {
    static SET: OnceLock<HashSet<String>> = OnceLock::new();
    SET.get_or_init(|| {
        const HOSTFILE: &str = include_str!("../resources/malware-hosts.txt");
        HOSTFILE
            .lines()
            .filter_map(|l| {
                let l = l.trim();
                if l.is_empty() || l.starts_with('#') {
                    return None;
                }
                // hosts format: "127.0.0.1<ws>domain"
                l.split_whitespace().nth(1).map(str::to_lowercase)
            })
            .collect()
    })
}

#[derive(Default)]
pub struct SafetyState {
    /// Current interstitial payload ({url, reason}) or Null.
    pub interstitial: Mutex<Value>,
    /// Session-only host exceptions (the user chose to proceed).
    pub exceptions: Mutex<HashSet<String>>,
}

/// True if navigating to `url` should be blocked as malware (and it isn't excepted).
pub fn is_blocked(app: &AppHandle, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_lowercase();
    if let Some(s) = app.try_state::<SafetyState>() {
        if s.exceptions.lock().unwrap().contains(&host) {
            return false;
        }
    }
    malware_hosts().contains(&host)
}

/// Whether `host` is a known-malware host in the bundled list (case-insensitive).
/// Used by the Android content WebView's navigation/resource guard — there's no
/// AppHandle/session-exception context there (per-site "proceed anyway" on mobile is
/// a follow-up). Android-only (its sole caller is the JNI export below), so it's
/// `cfg`-gated to avoid a dead-code warning on desktop builds.
#[cfg(target_os = "android")]
pub fn is_malware_host(host: &str) -> bool {
    malware_hosts().contains(&host.to_ascii_lowercase())
}

/// JNI bridge for Android's `NativeSafety.isMalwareHost`, called from the content
/// WebView's guards (shouldOverrideUrlLoading / shouldInterceptRequest / the nav
/// bridge). Same pattern as `adblock_engine.rs`; lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeSafety_isMalwareHost(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    host: jni::objects::JString,
) -> jni::sys::jboolean {
    let host: String = env.get_string(&host).map(|s| s.into()).unwrap_or_default();
    is_malware_host(&host) as jni::sys::jboolean
}

/// Record + surface the interstitial, and show a visible warning in the content
/// area (deferred to avoid nav-callback re-entrancy).
pub fn raise(app: &AppHandle, url: &str) {
    let payload = json!({ "url": url, "reason": "malware" });
    if let Some(s) = app.try_state::<SafetyState>() {
        *s.interstitial.lock().unwrap() = payload.clone();
    }
    crate::emit_event(app, "safety.interstitial", payload);

    let app2 = app.clone();
    let _ = app.run_on_main_thread(move || {
        // No '#' or '&' in the body — they'd be parsed as URL fragment/query and
        // truncate the data: URL. Colors use %23 (percent-encoded #).
        const WARN: &str = "data:text/html,<body style='font:16px system-ui;margin:0;padding:48px;background:%23450a0a;color:%23fff'><h1>Malicious site blocked</h1><p>Aegis blocked a known-malware site (URLhaus blocklist). Go back to leave this page.</p></body>";
        let label = crate::nav::active_content_label(&app2);
        if let (Some(w), Ok(u)) = (app2.get_webview(&label), Url::parse(WARN)) {
            let _ = w.navigate(u);
        }
    });
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "safety.getState" => {
            let v = app
                .try_state::<SafetyState>()
                .map(|s| s.interstitial.lock().unwrap().clone())
                .unwrap_or(Value::Null);
            Some(Ok(v))
        }

        "safety.proceed" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            if let Ok(u) = Url::parse(url) {
                if let (Some(host), Some(s)) = (u.host_str(), app.try_state::<SafetyState>()) {
                    s.exceptions.lock().unwrap().insert(host.to_lowercase());
                    *s.interstitial.lock().unwrap() = Value::Null;
                }
                crate::emit_event(app, "safety.interstitial", Value::Null);
                let label = crate::nav::active_content_label(app);
                if let Some(w) = app.get_webview(&label) {
                    let _ = w.navigate(u);
                }
            }
            Some(Ok(Value::Null))
        }

        "safety.listExceptions" => {
            let list: Vec<String> = app
                .try_state::<SafetyState>()
                .map(|s| s.exceptions.lock().unwrap().iter().cloned().collect())
                .unwrap_or_default();
            Some(Ok(json!(list)))
        }

        "safety.removeException" => {
            let host = payload
                .get("host")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_lowercase();
            if let Some(s) = app.try_state::<SafetyState>() {
                s.exceptions.lock().unwrap().remove(&host);
            }
            Some(Ok(Value::Null))
        }

        _ => None,
    }
}
