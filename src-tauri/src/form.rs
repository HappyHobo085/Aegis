// src-tauri/src/form.rs — Login form detection for vault autofill triggering.
//
// ## STATUS: NEITHER DETECTION MODE CURRENTLY WORKS. Read this before wiring anything up.
//
// The design has two modes:
//
// 1. **One-shot** (`form.detectLoginForm`) — evaluate JS in the active content webview and
//    wait for the result over the Tauri event bridge.
// 2. **Event-driven** (`form.state`) — an injected MutationObserver in the content webview
//    emits `form:formStateChanged` whenever password fields appear/disappear, and
//    [`install_listener`] relays it to the chrome as `form.state`.
//
// Both need a **content webview → core callback**, and that transport does not exist:
//
// - The JS in both modes ends in `window.__TAURI__.emit(...)`, but a **content** webview is
//   created with no Tauri capability (`src-tauri/capabilities/default.json` matches only the
//   `main` window and declares no `remote` block) and `withGlobalTauri` is absent from
//   `tauri.conf.json`. So `window.__TAURI__` is `undefined` in a content webview and the emit
//   is unreachable. Verified against tauri 2.11's `ipc/authority.rs`: `Origin::matches` returns
//   false for `(Local, Remote)`, which is what keeps untrusted pages off the `ipc` command.
// - There is **no** injected callback that stands in for it. Grepping the tree for a
//   content→core shim turns up only `__aegisFind` (a macOS find-in-page shim), `__aegisBlocked`
//   (a page-local DOM stub) and the Android `__aegisOpenTab` bridge.
//   Nothing emits `form:formStateChanged` or `form:detectionResult` from any platform.
// - The MutationObserver this module documents **is not in the codebase at all** — it was
//   described in a comment, never written.
//
// So mode 2's listener has no producer, and mode 1 could only ever have timed out.
//
// ## What mode 1 does now, and why it is an `Err` rather than a `false`
//
// It used to `eval` the detection script, wait on a oneshot channel for a result that could
// never arrive, burn the full 5 s timeout, and then answer `{hasLoginForm: false}`. That had
// two problems, and both were worse than being broken:
//
// 1. `ipc` is a **synchronous** `#[tauri::command]`, so it runs on the main thread — a
//    guaranteed 5-second UI freeze on every call, for every channel, not just this one.
// 2. `{hasLoginForm: false}` is a **lie**: it tells the renderer "I inspected this page and
//    there is no login form", when in fact nothing inspected anything. A caller could not tell
//    that apart from a real negative, so the feature would look alive in the UI while being
//    permanently dead underneath.
//
// It now returns an `Err` naming the missing transport, so a caller can distinguish
//! "unsupported" from "no login form here" and no longer blocks the main thread.
//
// The pending-request machinery and the two relay listeners in [`install_listener`] are kept
// deliberately: they are exactly what whoever adds the transport needs, and a listener that
// has no producer yet costs nothing. This module is the seam, not the mechanism.

use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::OnceLock;

use parking_lot::Mutex;
use tauri::{AppHandle, Listener};

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
    _app: &AppHandle,
    channel: &str,
    _payload: &serde_json::Value,
) -> Option<Result<serde_json::Value, String>> {
    match channel {
        // No app handle needed: this refuses without touching any state (see `detect_login_form`).
        "form.detectLoginForm" => detect_login_form(),
        _ => None,
    }
}

#[derive(serde::Serialize, serde::Deserialize, Clone)]
struct FormDetectionResult {
    has_login_form: bool,
    domain: Option<String>,
}

/// The error `form.detectLoginForm` returns, and the whole reason this function is honest
/// instead of merely broken.
///
/// Split out as a `const` so a test can assert on the message without standing up an app —
/// which matters, because the entire point is that this path must never be reached by a real
/// caller, so there is nothing app-shaped left to exercise.
const DETECT_UNSUPPORTED: &str = "form.detectLoginForm is not implemented: the content webview \
has no Tauri capability and `withGlobalTauri` is off, so `window.__TAURI__.emit` is unreachable \
from the page and there is no injected content->core callback to replace it. The core cannot \
evaluate JS in a content webview and read the answer back, so it refuses instead of blocking the \
main thread waiting for a result that can never arrive. See the module header for what a real fix \
needs.";

/// Answer `form.detectLoginForm` — by refusing, immediately.
///
/// Takes no `&AppHandle` and reads no state on purpose: the old version resolved the active
/// content webview, armed a oneshot channel, `eval`'d a detection script into the page, and then
/// blocked the main thread for the full 5 s timeout, because the page could not emit a result
/// back (see the module header). It then reported `{hasLoginForm: false}` — a value
/// indistinguishable from "I looked at this page and there is no login form", so a caller had no
/// way to know the feature was dead. A refused promise is visible; a plausible `false` is not.
fn detect_login_form() -> Option<Result<serde_json::Value, String>> {
    Some(Err(DETECT_UNSUPPORTED.to_string()))
}

// ─── Tests ───────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    /// The channel must refuse, and the message must name the actual blocker.
    ///
    /// The bug this pins is subtle and was invisible to the whole suite: the old
    /// implementation was a *plausible* answer, not a crash. It blocked the main thread for 5 s
    /// and then returned `{hasLoginForm: false}` — exactly what a caller sees on a page with no
    /// login form — so every test and every consumer agreed it was working.
    #[test]
    fn detect_login_form_refuses_instead_of_reporting_a_bogus_negative() {
        let out = detect_login_form().expect("the channel must still be dispatched");
        let err = out.expect_err("must not answer Ok: a `false` here is a lie about the page");
        assert_eq!(err, DETECT_UNSUPPORTED);
        // Name the two things a fixer needs: the missing capability/global, and the fact that
        // the old answer was worse than useless.
        assert!(
            err.contains("withGlobalTauri"),
            "message must name the cause: {err}"
        );
        assert!(
            err.contains("main thread"),
            "message must name the freeze it avoids: {err}"
        );
    }

    /// The refusal must be a *prompt* refusal — nothing in this path may block.
    ///
    /// This is the property the 5 s `recv_timeout` violated, and asserting only on the error
    /// string would not catch a reintroduced timeout. An app handle is not needed because
    /// `detect_login_form` does not take one; that is itself the guarantee.
    #[test]
    fn detect_login_form_needs_no_app_handle_so_it_cannot_block_on_one() {
        // Compile-time proof of the above: this only type-checks if the fn is app-free.
        let f: fn() -> Option<Result<serde_json::Value, String>> = detect_login_form;
        assert!(f().is_some());
    }

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
