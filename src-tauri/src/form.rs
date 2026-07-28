// src-tauri/src/form.rs — Login form detection for vault autofill triggering.
//
// Two detection modes:
// 1. **One-shot** (`form.detectLoginForm`): evaluates JS in the active content webview,
//    waits for the result via a oneshot channel. Used by explicit IPC queries.
// 2. **Event-driven** (`form.state`): an injected MutationObserver in the content webview
//    emits `form:formStateChanged` whenever password fields appear/disappear. The Rust
//    listener relays these as `form.state` events to the chrome, so the UI reacts in
//    real time without polling.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::OnceLock;
use std::time::Duration;

use parking_lot::Mutex;
use tauri::{AppHandle, Listener, Manager};
use uuid::Uuid;

use crate::nav::active_webview;

/// Pending detection requests: request_id → oneshot sender.
static PENDING_REQUESTS: OnceLock<Mutex<HashMap<String, mpsc::SyncSender<FormDetectionResult>>>> =
    OnceLock::new();

fn get_pending_requests() -> &'static Mutex<HashMap<String, mpsc::SyncSender<FormDetectionResult>>>
{
    PENDING_REQUESTS.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Real-time form state event payload (matches the TS `FormState` interface).
#[derive(serde::Serialize, Clone)]
pub struct FormStateEvent {
    #[serde(rename = "hasLoginForm")]
    pub has_login_form: bool,
    pub domain: Option<String>,
    #[serde(rename = "tabId")]
    pub tab_id: u32,
}

/// Emit a `form.state` event to the chrome so the UI can react to form detection.
pub fn emit_form_state(app: &AppHandle, has_login_form: bool, domain: Option<String>, tab_id: u32) {
    let payload = FormStateEvent {
        has_login_form,
        domain,
        tab_id,
    };
    crate::emit_event(app, "form.state", &payload);
}

/// Emit a `form.willSubmit` event before a login form is submitted, so the vault
/// save-prompt can intercept. Called from the content-webview JS bridge.
#[allow(dead_code)] // TODO(M13): wired when the content-webview submit interceptor is added
pub fn emit_will_submit(app: &AppHandle, domain: &str, username: &str, password: &str) {
    crate::emit_event(
        app,
        "form.willSubmit",
        &serde_json::json!({
            "domain": domain,
            "username": username,
            "password": password,
        }),
    );
}

// TODO(M13): Wire `form.willSubmit` emission from the content webview.
//
// The injected JS should intercept form `submit` events on pages where
// `hasLoginForm` is true, capture the `username`/`password` field values, and
// emit `form:willSubmit` via the Tauri event bridge. The Rust listener in
// `install_listener` would then relay as `form.willSubmit` to the chrome.
//
// Alternatively, the content webview's `on_submit` bridge (if available) could
// call `emit_will_submit` directly. The current `window.__TAURI__.emit` bridge
// from the content JS is the natural path (same as `form:detectionResult`).

/// Start the event listeners (called once at app setup).
pub fn install_listener(app: &AppHandle) {
    // One-shot detection result (for explicit IPC queries via `form.detectLoginForm`).
    app.listen("form:detectionResult", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            if let Some(request_id) = payload.get("requestId").and_then(|v| v.as_str()) {
                let result = FormDetectionResult {
                    has_login_form: payload
                        .get("hasLoginForm")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false),
                    domain: payload
                        .get("domain")
                        .and_then(|v| v.as_str())
                        .map(String::from),
                };
                let pending = get_pending_requests().lock();
                if let Some(tx) = pending.get(request_id) {
                    let _ = tx.try_send(result);
                }
            }
        }
    });

    // Event-driven: the injected MutationObserver in the content webview emits
    // `form:formStateChanged` whenever password fields appear or disappear.
    // Relay as `form.state` to the chrome.
    let app_handle = app.clone();
    app.listen("form:formStateChanged", move |event| {
        if let Ok(payload) = serde_json::from_str::<serde_json::Value>(event.payload()) {
            let has_login_form = payload
                .get("hasLoginForm")
                .and_then(|v| v.as_bool())
                .unwrap_or(false);
            let domain = payload
                .get("domain")
                .and_then(|v| v.as_str())
                .map(String::from);
            let tab_id = payload.get("tabId").and_then(|v| v.as_u64()).unwrap_or(0) as u32;

            emit_form_state(&app_handle, has_login_form, domain, tab_id);
        }
    });
}

/// Handle form detection IPC calls.
pub fn dispatch(
    app: &AppHandle,
    channel: &str,
    _payload: &serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    match channel {
        "form.detectLoginForm" => detect_login_form(app),
        _ => None,
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct FormDetectionResult {
    has_login_form: bool,
    domain: Option<String>,
}

/// Evaluate detection JS in the active **content** webview and wait for the
/// result via the Tauri event bridge.
fn detect_login_form(app: &AppHandle) -> Option<Result<serde_json::Value, String>> {
    // FIX: get the CONTENT webview (where the user's page lives), not the
    // chrome webview. The chrome webview has no login forms to detect.
    let content = active_webview(app).or_else(|| {
        // Fallback: the main window (chrome) if no content webview exists yet
        app.get_webview_window("main").map(|w| w.as_ref().clone())
    })?;

    let request_id = Uuid::new_v4().to_string();
    let (tx, rx) = mpsc::sync_channel(1);
    get_pending_requests().lock().insert(request_id.clone(), tx);

    let detection_script = format!(
        r#"(function() {{
            var result = {{ hasLoginForm: false, domain: null }};
            try {{
                var forms = document.forms;
                for (var i = 0; i < forms.length; i++) {{
                    var form = forms[i];
                    var inputs = form.querySelectorAll('input');
                    var hasPassword = false;
                    var hasEmailOrText = false;
                    for (var j = 0; j < inputs.length; j++) {{
                        var type = (inputs[j].type || '').toLowerCase();
                        if (type === 'password') hasPassword = true;
                        if (type === 'email' || type === 'text') hasEmailOrText = true;
                    }}
                    if (hasPassword && hasEmailOrText) {{
                        result.domain = window.location.hostname;
                        try {{
                            if (form.action) {{
                                var u = new URL(form.action, window.location.href);
                                result.domain = u.hostname;
                            }}
                        }} catch(e) {{}}
                        result.hasLoginForm = true;
                        break;
                    }}
                }}
                if (!result.hasLoginForm) {{
                    var pwInputs = document.querySelectorAll('input[type="password"]');
                    if (pwInputs.length > 0) {{
                        result.domain = window.location.hostname;
                        result.hasLoginForm = true;
                    }}
                }}
            }} catch(e) {{}}
            if (typeof window.__TAURI__ !== 'undefined') {{
                window.__TAURI__.emit('form:detectionResult', {{
                    requestId: '{}',
                    hasLoginForm: result.hasLoginForm,
                    domain: result.domain
                }});
            }}
        }})();"#,
        request_id
    );

    if content.eval(&detection_script).is_err() {
        get_pending_requests().lock().remove(&request_id);
        return Some(Ok(serde_json::to_value(&FormDetectionResult {
            has_login_form: false,
            domain: None,
        })
        .unwrap()));
    }

    // Wait for the event listener to deliver the result, with a 5 s timeout
    match rx.recv_timeout(Duration::from_secs(5)) {
        Ok(result) => {
            get_pending_requests().lock().remove(&request_id);
            Some(Ok(serde_json::to_value(&result).unwrap()))
        }
        Err(_) => {
            get_pending_requests().lock().remove(&request_id);
            Some(Ok(serde_json::to_value(&FormDetectionResult {
                has_login_form: false,
                domain: None,
            })
            .unwrap()))
        }
    }
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn form_state_event_has_required_fields() {
        let event = FormStateEvent {
            has_login_form: true,
            domain: Some("example.com".to_string()),
            tab_id: 42,
        };
        let json = serde_json::to_value(&event).unwrap();
        assert_eq!(
            json.get("hasLoginForm").and_then(|v| v.as_bool()),
            Some(true)
        );
        assert_eq!(
            json.get("domain").and_then(|v| v.as_str()),
            Some("example.com")
        );
        assert_eq!(json.get("tabId").and_then(|v| v.as_u64()), Some(42));
    }

    #[test]
    fn form_state_event_serializes_camel_case_for_ts() {
        // FormStateEvent uses #[serde(rename)] to emit camelCase keys matching the
        // TS FormState interface: hasLoginForm, domain, tabId.
        let event = FormStateEvent {
            has_login_form: false,
            domain: None,
            tab_id: 0,
        };
        let json = serde_json::to_value(&event).unwrap();
        // Verify camelCase keys (matching the TS contract).
        assert!(json.get("hasLoginForm").is_some());
        assert!(json.get("tabId").is_some());
        // Old snake_case keys must not be present.
        assert!(json.get("has_login_form").is_none());
        assert!(json.get("tab_id").is_none());
    }
}
