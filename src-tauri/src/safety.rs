//! Malicious-site protection (safety.* IPC). Top-level navigations to known-malware
//! hosts (bundled URLhaus blocklist) are blocked in the nav gate (nav.rs); the
//! content area shows a warning and a safety.interstitial event is emitted for the
//! chrome. Session-only exceptions let the user proceed. A fetched/auto-updated
//! blocklist + the chrome interstitial overlay (needs the z-swap) are follow-ups.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url};

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
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn is_blocked<R: Runtime>(app: &AppHandle<R>, url: &Url) -> bool {
    let Some(host) = url.host_str() else {
        return false;
    };
    let host = host.to_lowercase();
    if let Some(s) = app.try_state::<SafetyState>() {
        if s.exceptions
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&host)
        {
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
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeSafety_isMalwareHost(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    host: jni::objects::JString,
) -> jni::sys::jboolean {
    let host: String = env.get_string(&host).map(|s| s.into()).unwrap_or_default();
    // Fails OPEN on a panic, matching `is_malware_host`'s own contract: malware blocking
    // must never be the reason a page fails to load.
    match crate::ffi_guard(|| is_malware_host(&host)) {
        Some(bad) => bad as jni::sys::jboolean,
        None => {
            eprintln!("[aegis-safety] is_malware_host panicked; failing open for this host");
            0
        }
    }
}

/// Record + surface the interstitial, and show a visible warning in the content
/// area (deferred to avoid nav-callback re-entrancy).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn raise<R: Runtime>(app: &AppHandle<R>, url: &str) {
    let payload = json!({ "url": url, "reason": "malware" });
    if let Some(s) = app.try_state::<SafetyState>() {
        *s.interstitial.lock().unwrap_or_else(|e| e.into_inner()) = payload.clone();
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

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "safety.getState" => {
            let v = app
                .try_state::<SafetyState>()
                .map(|s| {
                    s.interstitial
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .clone()
                })
                .unwrap_or(Value::Null);
            Some(Ok(v))
        }

        "safety.proceed" => {
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            let Ok(u) = Url::parse(url) else {
                return Some(Err(format!("`{url}` is not a URL")));
            };
            // Scheme gate. This arm is the one channel that says "load it anyway", so it is
            // the LAST place a scheme policy can be applied — and it is the only path here
            // that both lifts a block and navigates, so a non-web scheme here is a local-file
            // read or script injection in a webview that can reach the IPC chokepoint. It
            // reuses `nav::is_navigable` rather than keeping a second scheme list, because
            // two lists is how `file:` reached tabs.json in the first place (see
            // `tabs::on_tab_url`).
            //
            // The old shape also LIED on refusal: the exception insert and the interstitial
            // clear were both inside `if let (Some(host), Some(state))`, so a hostless
            // scheme (`javascript:`, `data:`) recorded nothing — the block stayed armed — yet
            // the warning was dismissed and the navigation happened anyway. Gate first, so a
            // refusal leaves the user looking at the block that is still in force.
            if !crate::nav::is_navigable(&u) {
                return Some(Err(format!(
                    "refusing to proceed to a `{}:` URL — Aegis only opens web (http and \
                     https) pages",
                    u.scheme()
                )));
            }
            if let (Some(host), Some(s)) = (u.host_str(), app.try_state::<SafetyState>()) {
                s.exceptions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .insert(host.to_lowercase());
                *s.interstitial.lock().unwrap_or_else(|e| e.into_inner()) = Value::Null;
            }
            crate::emit_event(app, "safety.interstitial", Value::Null);
            let label = crate::nav::active_content_label(app);
            if let Some(w) = app.get_webview(&label) {
                let _ = w.navigate(u);
            }
            Some(Ok(Value::Null))
        }

        "safety.listExceptions" => {
            let list: Vec<String> = app
                .try_state::<SafetyState>()
                .map(|s| {
                    s.exceptions
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .iter()
                        .cloned()
                        .collect()
                })
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
                s.exceptions
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .remove(&host);
            }
            Some(Ok(Value::Null))
        }

        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    // Filled from resources/malware-hosts.txt (first data line, second field).
    const MALWARE_HOST: &str = "0022a601.pphost.net";

    #[test]
    fn malware_hosts_parsed_from_bundle_is_nonempty_and_contains_the_probe() {
        assert!(
            !malware_hosts().is_empty(),
            "bundled malware host set must parse"
        );
        assert!(
            malware_hosts().contains(MALWARE_HOST),
            "the chosen probe host must be in the bundled list (re-run Step 0 if this fails)"
        );
    }

    #[test]
    fn is_blocked_true_for_malware_host_false_for_clean() {
        with_tmp_app(|app| {
            let bad = Url::parse(&format!("https://{MALWARE_HOST}/x")).unwrap();
            let good = Url::parse("https://example.com/").unwrap();
            assert!(is_blocked(app, &bad));
            assert!(!is_blocked(app, &good));
        });
    }

    #[test]
    fn session_exception_unblocks_the_host() {
        with_tmp_app(|app| {
            let bad = Url::parse(&format!("https://{MALWARE_HOST}/x")).unwrap();
            assert!(is_blocked(app, &bad));
            // Add a session exception directly (the same set `proceed` writes).
            app.state::<SafetyState>()
                .exceptions
                .lock()
                .unwrap()
                .insert(MALWARE_HOST.to_string());
            assert!(
                !is_blocked(app, &bad),
                "an excepted host is no longer blocked"
            );
        });
    }

    #[test]
    fn proceed_records_exception_and_clears_interstitial() {
        with_tmp_app(|app| {
            // Seed an interstitial as raise() would.
            *app.state::<SafetyState>()
                .interstitial
                .lock()
                .unwrap_or_else(|e| e.into_inner()) =
                json!({ "url": format!("https://{MALWARE_HOST}/"), "reason": "malware" });
            let url = format!("https://{MALWARE_HOST}/");
            dispatch(app, "safety.proceed", &json!({ "url": url }))
                .unwrap()
                .unwrap();
            // interstitial cleared.
            let state = dispatch(app, "safety.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(state, Value::Null);
            // exception recorded → listExceptions contains the host.
            let list = dispatch(app, "safety.listExceptions", &json!({}))
                .unwrap()
                .unwrap();
            let hosts: Vec<&str> = list
                .as_array()
                .unwrap()
                .iter()
                .filter_map(Value::as_str)
                .collect();
            assert!(hosts.contains(&MALWARE_HOST));
        });
    }

    #[test]
    fn remove_exception_drops_it() {
        with_tmp_app(|app| {
            app.state::<SafetyState>()
                .exceptions
                .lock()
                .unwrap()
                .insert(MALWARE_HOST.to_string());
            let _ = dispatch(
                app,
                "safety.removeException",
                &json!({ "host": MALWARE_HOST }),
            )
            .unwrap();
            let list = dispatch(app, "safety.listExceptions", &json!({}))
                .unwrap()
                .unwrap();
            assert!(list.as_array().unwrap().is_empty());
        });
    }

    /// The proceed arm is the ONE channel that says "yes, load this anyway", so it is the
    /// last place a scheme policy belongs. `file://` is the sharpest case: it has a host,
    /// so the old code recorded a host exception and cleared the interstitial for it —
    /// handing the user their click back while arming an exception for the very host they
    /// were warned about, and navigating a webview to a local file.
    #[test]
    fn proceeding_to_a_non_web_scheme_records_no_exception_and_keeps_the_warning() {
        with_tmp_app(|app| {
            raise(app, &format!("http://{MALWARE_HOST}/"));
            let armed = dispatch(app, "safety.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                !armed.is_null(),
                "precondition: the warning must be armed before a proceed attempt"
            );

            let out = dispatch(
                app,
                "safety.proceed",
                &json!({ "url": format!("file://{MALWARE_HOST}/etc/passwd") }),
            )
            .unwrap();
            assert!(
                out.is_err(),
                "proceeding to a file: URL must be refused, not navigated: {out:?}"
            );

            let list = dispatch(app, "safety.listExceptions", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                list.as_array().unwrap().is_empty(),
                "a refused proceed must not record a host exception, or it unblocks the \
                 very host the user was just warned about: {list}"
            );

            let after = dispatch(app, "safety.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                !after.is_null(),
                "a refused proceed must leave the warning up; dismissing it hides a block \
                 that is still armed, which is the same lie as a toggle that does nothing"
            );
        });
    }

    /// The other half of the same gate: a scheme with no host at all records nothing even
    /// in the old code, so the ONLY thing that changes is the dismissal — the warning
    /// vanished while the block stayed armed. Pinned so a future refactor cannot pass by
    /// fixing only the `file:` case.
    #[test]
    fn proceeding_to_a_hostless_scheme_still_keeps_the_warning() {
        with_tmp_app(|app| {
            raise(app, &format!("http://{MALWARE_HOST}/"));
            let out = dispatch(
                app,
                "safety.proceed",
                &json!({ "url": "javascript:alert(1)" }),
            )
            .unwrap();
            assert!(
                out.is_err(),
                "javascript: must be refused too, not just file:"
            );
            let after = dispatch(app, "safety.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                !after.is_null(),
                "the warning must survive a refused proceed"
            );
        });
    }

    /// An http(s) proceed must still work — the gate is a scheme check, not a blanket
    /// refusal, and a fix that broke this would strand a user on a malware warning.
    #[test]
    fn proceeding_to_an_https_url_still_records_the_exception_and_clears_the_warning() {
        with_tmp_app(|app| {
            raise(app, &format!("http://{MALWARE_HOST}/"));
            let out = dispatch(
                app,
                "safety.proceed",
                &json!({ "url": format!("http://{MALWARE_HOST}/") }),
            )
            .unwrap();
            assert!(out.is_ok(), "an http proceed must succeed: {out:?}");
            let list = dispatch(app, "safety.listExceptions", &json!({}))
                .unwrap()
                .unwrap();
            assert_eq!(
                list.as_array().unwrap(),
                &vec![json!(MALWARE_HOST)],
                "an accepted proceed must record the host, or the user is blocked forever"
            );
            let after = dispatch(app, "safety.getState", &json!({}))
                .unwrap()
                .unwrap();
            assert!(
                after.is_null(),
                "an accepted proceed must clear the warning"
            );
        });
    }
}
