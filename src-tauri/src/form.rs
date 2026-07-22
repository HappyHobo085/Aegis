// src-tauri/src/form.rs — Login form detection for vault autofill triggering.
//
// Evaluates a JS snippet in the ACTIVE CONTENT webview (not the chrome webview)
// to detect password + text/email input pairs. The detection script emits a
// Tauri event back with the result; a Rust-side listener routes it through
// an oneshot channel to the waiting IPC handler.

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

/// Start the event listener (called once at app setup).
pub fn install_listener(app: &AppHandle) {
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
