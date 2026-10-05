//! Element picker (picker.* IPC). `picker.start` injects a picking overlay into
//! the content webview; the user hovers to highlight and clicks an element. The
//! overlay computes a CSS selector + the page host and signals them back by briefly
//! setting `document.title` to an `AEGISPICK:<nonce>:<json>` sentinel — caught by the
//! title-change handler on each platform (Linux: `linux_layout::connect_title_label`
//! via WebKit's `notify::title`; Windows: `nav_url_win` via WebView2's
//! `DocumentTitleChanged` event; macOS: `nav_url_mac` via WKWebView KVO on `title`).
//! We persist `host##selector` as a custom cosmetic filter — the content-blocker
//! converter turns it into a css-display-none action, so it hides on future
//! visits — and re-install the engine. The element is hidden immediately
//! client-side too, for instant feedback.
//!
//! # Two channels, because a picker with only an on switch cannot be turned off
//!
//! `picker.stop` is the second one, and it exists because every exit the overlay had was
//! page-side: a pick and an Escape both call the closure-local `teardown`, and the overlay's
//! opening line (`if (window.__aegisPicking) return;`) turned every later injection into a
//! silent no-op. The toolbar button could arm the picker and never disarm it without a page
//! reload. The fix has three parts, and all three are load-bearing — the obvious two-part
//! version ships a button that lies:
//!
//! 1. **`picker.stop`** injects [`STOP_JS`], which calls the one handle the overlay publishes
//!    (`window.__aegisPickStop`) and revokes the session. Revoking is the part that matters
//!    for safety: the nonce is already in the running overlay's closure, so clearing
//!    [`SESSION`] is what stops a sentinel that page might still fire.
//! 2. **`picker.state {active}`** is emitted on every transition — including the two that
//!    happen entirely in the page. Escape is why the overlay reports itself: without that
//!    report the core never learns the session ended, the button stays pressed, and the
//!    user's next click calls `picker.stop` at a picker that is no longer armed — a no-op.
//!    That is the same dead button, one click later.
//! 3. **A matched nonce ends the session whatever the payload is**, so `on_picked` emits the
//!    state *before* it branches. A duplicate rule, a malformed payload, an over-cap file
//!    and a failed write all return without emitting `picker.picked`, and the page has
//!    already torn itself down in every one of them.
//!
//! A cancelled session is reported as `{cancelled:true}` down the same nonce-gated title
//! sentinel, so it is authorised exactly like a pick and a page can forge neither.
//!
//! # The sentinel is on a page-controlled channel
//!
//! `document.title` is settable by arbitrary page script, so a sentinel arriving
//! here is untrusted input, not a user action. Historically `on_picked` believed
//! any `AEGISPICK:` title was a real pick, which let any site append arbitrary
//! text to the persistent (and synced) custom-filter file and force an ad-block
//! engine rebuild on demand, with no user interaction at all.
//!
//! The fix is a per-session nonce. `picker.start` mints 128 bits from the OS
//! CSPRNG, bakes them into the overlay's IIFE closure (never onto `window`, so
//! page script cannot read them), and `on_picked` drops any sentinel whose nonce
//! is not the live session's. A page can set `document.title` all it likes; it
//! cannot produce a matching nonce, so it cannot write a filter rule. The
//! remaining checks in `build_rule` (host + selector charset) and the
//! `MAX_FILTER_BYTES` cap are defence in depth behind that gate.
//!
//! On Android the picker is not implemented — `dispatch` falls through to the
//! unsupported-platform branch and answers `{ok:false}` — so the entire
//! sentinel-authorisation half of this module (SENTINEL, the session/nonce
//! machinery, `on_picked`, `build_rule` and its validators) has no caller there
//! and warns as dead code. The allow is Android-scoped: desktop keeps the lint on,
//! so a genuinely dead item there still fails CI's `-D warnings` cross-target gate.
#![cfg_attr(target_os = "android", allow(dead_code))]

use serde_json::{json, Value};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Runtime};

/// Sentinel prefix a picked selector's payload is wrapped in (via document.title).
pub const SENTINEL: &str = "AEGISPICK:";

/// Upper bound on the persisted custom-filter file. Every injected rule costs a
/// full ad-block engine re-parse (and a WebKit filter reinstall) on each refresh,
/// and the file syncs, so an unbounded file is both a CPU and a storage amplifier.
const MAX_FILTER_BYTES: usize = 512 * 1024;

/// Longest single CSS selector we will persist. Real picks are far shorter.
const MAX_SELECTOR_LEN: usize = 512;

/// A picking session, i.e. the window between `picker.start` and the first
/// accepted sentinel.
struct Session {
    nonce: String,
    at: Instant,
}

/// The single live picking session, if any.
///
/// The element picker is a one-at-a-time affordance scoped to the ACTIVE tab
/// (`picker.start` injects into `nav::active_webview`), so one process-wide
/// session is the right granularity. The nonce is what actually authorises a
/// sentinel: it is minted here, baked into the injected overlay's closure, and
/// never exposed on `window`, so page script cannot read it and cannot forge a
/// sentinel even if it can set `document.title` at will.
static SESSION: Mutex<Option<Session>> = Mutex::new(None);

/// Drop an expired session. A stale nonce is worth nothing, and this keeps the
/// static from holding a session open forever if the user walks away mid-pick.
fn prune_expired(now: Instant) {
    let mut g = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref()
        .is_some_and(|s| now.duration_since(s.at) > SESSION_TTL)
    {
        *g = None;
    }
}

/// Mint a session and return its nonce. `None` if the OS CSPRNG is unavailable,
/// in which case we refuse to start a picker rather than fall back to guessable
/// randomness — an unguessable nonce is the entire security property here.
fn begin_session() -> Option<String> {
    let mut b = [0u8; 16];
    getrandom::getrandom(&mut b).ok()?;
    let nonce: String = b.iter().map(|x| format!("{x:02x}")).collect();
    let mut g = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    *g = Some(Session {
        nonce: nonce.clone(),
        at: Instant::now(),
    });
    Some(nonce)
}

/// Accept `nonce` iff it is the live session's. Single-use: a match clears the
/// session so the page cannot fire the sentinel repeatedly. A *mismatch* is
/// ignored WITHOUT clearing, so a page spamming bogus sentinels cannot cancel
/// the user's in-progress pick.
fn consume_session(nonce: &str) -> bool {
    let now = Instant::now();
    prune_expired(now);
    let mut g = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    if g.as_ref().is_some_and(|s| s.nonce == nonce) {
        *g = None;
        true
    } else {
        false
    }
}

/// Drop the live session, reporting whether there was one.
///
/// `picker.stop` MUST go through this rather than only injecting the teardown: the nonce
/// is already baked into an overlay that is running in the page, so clearing the session is
/// what actually revokes it. Without that, a page that had read the nonce could still fire
/// the sentinel after the user pressed stop — the teardown removes the listeners, but the
/// string was never a secret from the page, only from a page that never had it.
fn clear_session() -> bool {
    let mut g = SESSION.lock().unwrap_or_else(|e| e.into_inner());
    g.take().is_some()
}

/// Report whether a picking session is armed. The toolbar button's pressed state is a CLAIM
/// about the core, so every transition emits it — including the two that happen entirely in
/// the page (a pick and an Escape), which is why the overlay reports them at all.
fn emit_state<R: Runtime>(app: &AppHandle<R>, active: bool) {
    crate::emit_event(app, "picker.state", json!({ "active": active }));
}

/// How long a picking session stays open. The nonce is single-use, so this is
/// just an upper bound on how long an unused session lingers in the static.
const SESSION_TTL: Duration = Duration::from_secs(5 * 60);

/// Characters allowed in a host. `location.hostname` yields LDH labels (letters,
/// digits, `-`, `.`, and `_` for the exotic-but-legal cases). Everything else is
/// rejected — most importantly `#`, which is the `host##selector` field separator.
fn is_host_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || c == '.' || c == '-' || c == '_'
}

/// Is `selector` safe to interpolate into the generated stylesheet?
///
/// The selector reaches an adblock converter that emits
/// `<selector> { display: none !important; }`, so an *unescaped* `{`, `}` or `;`
/// would let a hand-forged payload break out of its own rule and inject
/// arbitrary CSS. CSS escapes are honoured: a backslash makes the next character a
/// literal, which is exactly how a CSS parser reads it. That matters because the
/// overlay's own `esc()` runs `CSS.escape` over ids and class names, so picking an
/// element whose id is `a}b` legitimately produces the selector `#a\}b` — treating
/// that `}` as a terminator would reject valid picks. A trailing lone backslash is
/// rejected, since it would escape whatever followed it in the generated text.
///
/// The nonce gate in `consume_session` is the real control; this is defence in
/// depth behind it.
fn selector_is_safe(selector: &str) -> bool {
    let mut chars = selector.chars();
    while let Some(c) = chars.next() {
        if c == '\\' {
            // Escaped literal: the next char is data, whatever it is. Must exist.
            if chars.next().is_none() {
                return false;
            }
            continue;
        }
        if c.is_control() || matches!(c, '{' | '}' | ';' | '@') {
            return false;
        }
    }
    true
}

/// Build the `host##selector` cosmetic rule for a picked element, or `None` if
/// either half is unusable. Pure — no AppHandle, no IPC — so it is directly
/// unit-testable (see the `tests` module at the bottom of this file).
fn build_rule(host: &str, selector: &str) -> Option<String> {
    let selector = selector.trim();
    if selector.is_empty() || selector.len() > MAX_SELECTOR_LEN {
        return None;
    }
    if !selector_is_safe(selector) {
        return None;
    }
    let host = host.trim();
    // An empty host means "scoped to nothing", which would emit a global `##sel`
    // cosmetic rule — the overlay always supplies a hostname, so treat its absence
    // as a malformed payload rather than widening the rule's scope.
    if host.is_empty() || !host.chars().all(is_host_char) {
        return None;
    }
    Some(format!("{host}##{selector}"))
}

/// Picking overlay: highlight on hover, pick on click, Esc to cancel. On pick it
/// hides the element (instant feedback) and signals {selector, host} via a short
/// title sentinel, restored after a moment. Idempotent while active.
/// Engine-agnostic — works in WebKitGTK, WebView2, and WKWebView.
///
/// It publishes exactly one handle, `window.__aegisPickStop` (see the assignment at
/// the bottom), because [`STOP_JS`] has to reach `teardown` and `teardown` is
/// closure-local. That handle is what makes `picker.stop` — and therefore the
/// toolbar button's off half — possible at all.
///
/// `__AEGIS_PICK_NONCE__` is substituted with the per-session nonce by
/// [`picker_js`]. It is read from the enclosing IIFE's closure and never
/// assigned to `window`, so page script cannot observe it. The sentinel the
/// overlay emits is `AEGISPICK:<nonce>:<json>`; [`on_picked`] rejects any
/// sentinel whose nonce is not the live session's, which is what stops a page
/// from injecting cosmetic rules by setting `document.title` itself. A cancelled
/// session is reported the same way, with `{cancelled:true}`.
const PICKER_JS_TEMPLATE: &str = r#"
(function () {
  if (window.__aegisPicking) return;
  window.__aegisPicking = true;
  var NONCE = "__AEGIS_PICK_NONCE__";
  var prev = null;
  var box = document.createElement('div');
  box.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;background:rgba(59,130,246,0.25);border:2px solid #3b82f6;border-radius:2px';
  box.style.display = 'none';
  (document.documentElement || document.body).appendChild(box);
  function esc(s) { return (window.CSS && CSS.escape) ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1'); }
  function highlight(e) {
    var el = e.target;
    if (!el || el === box) return;
    prev = el;
    var r = el.getBoundingClientRect();
    box.style.display = 'block';
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  }
  function selectorFor(el) {
    if (el.id) return '#' + esc(el.id);
    var parts = [];
    while (el && el.nodeType === 1 && el !== document.body) {
      var part = el.tagName.toLowerCase();
      if (el.classList && el.classList.length) {
        part += '.' + Array.prototype.slice.call(el.classList).map(esc).join('.');
        parts.unshift(part);
        break; // a class-qualified ancestor is usually specific enough
      }
      var i = 1, sib = el;
      while ((sib = sib.previousElementSibling)) { if (sib.tagName === el.tagName) i++; }
      parts.unshift(part + ':nth-of-type(' + i + ')');
      el = el.parentElement;
    }
    return parts.join(' > ');
  }
  function signal(payload) {
    var orig = document.title;
    document.title = 'AEGISPICK:' + NONCE + ':' + JSON.stringify(payload);
    setTimeout(function () { try { document.title = orig; } catch (_) {} }, 400);
  }
  function teardown() {
    window.__aegisPicking = false;
    try { delete window.__aegisPickStop; } catch (_) {}
    box.remove();
    document.removeEventListener('mousemove', highlight, true);
    document.removeEventListener('click', pick, true);
    document.removeEventListener('keydown', key, true);
  }
  function pick(e) {
    e.preventDefault(); e.stopPropagation();
    var el = prev || e.target;
    var sel = selectorFor(el);
    try { el.style.setProperty('display', 'none', 'important'); } catch (_) {}
    signal({ selector: sel, host: location.hostname });
    teardown();
  }
  function key(e) {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    // Escape ends the session on the PAGE side, so the core never learns that the picker
    // is no longer armed and the toolbar button would sit there claiming otherwise. Report
    // it down the SAME nonce-gated title sentinel a pick uses; `on_picked` writes no filter
    // for a cancelled payload, it only reports the state.
    signal({ cancelled: true });
    teardown();
  }
  document.addEventListener('mousemove', highlight, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', key, true);
  // THE ONE HANDLE THIS OVERLAY PUBLISHES, and it exists for one reason: `teardown` is a
  // closure-local function, so `picker.stop` cannot reach it except through a reference the
  // overlay hands out. It is a CONTROL function, not data — no cross-site identifier is
  // derivable from it (unlike the farble seed, which is why that one stays in the closure),
  // and page script calling it could only cancel the user's own pick, which Escape already
  // does. `teardown` deletes it, so the handle cannot outlive the session it stops.
  window.__aegisPickStop = teardown;
})();
"#;

/// The picking overlay JS with `nonce` baked in. Substitution is safe without
/// escaping: [`begin_session`] only ever produces lowercase hex.
fn picker_js(nonce: &str) -> String {
    PICKER_JS_TEMPLATE.replace("__AEGIS_PICK_NONCE__", nonce)
}

/// What `picker.stop` injects. It reaches the overlay's own `teardown` through the one
/// handle the overlay publishes, because a closure-local function is otherwise
/// unreachable from a second injection — which is precisely why the picker had no off
/// switch and the toolbar button could only ever arm it.
///
/// It deliberately does NOT send a cancel sentinel. `picker.stop` is the core asking, so
/// the core already knows the session is over and emits `picker.state` itself; a sentinel
/// would consume the session the stop had just cleared and report the same thing twice.
const STOP_JS: &str = "(function () { if (window.__aegisPickStop) window.__aegisPickStop(); })();";

/// Persist a picked element as a custom cosmetic filter and re-install the engine.
/// `payload` is everything after [`SENTINEL`], i.e. `<nonce>:<json>`. Called by
/// the platform title-sentinel handlers:
/// - Linux: `linux_layout::connect_title_label`
/// - Windows: `nav_url_win` DocumentTitleChanged event
/// - macOS: `nav_url_mac` KVO title observer
///
/// The sentinel arrives on a page-controlled channel (`document.title`), so it is
/// treated as untrusted input. A payload is only honoured when its nonce matches
/// the live session minted by [`picker.start`] — that is what makes this
/// unforgeable by page script, which can set `document.title` but cannot read
/// the nonce out of the overlay's closure. Everything after the nonce check is
/// then re-validated ([`build_rule`]) before it reaches the persisted filter file.
///
/// Generic over `R: Runtime` so the whole write path is reachable from a
/// `MockRuntime` test — `customfilters::load`/`write`, `adblock_refresh::refresh`
/// and `emit_event` are all generic already, and the only production callers
/// (`linux_layout`, `nav_url_win`, `nav_url_mac`) infer `Wry` exactly as before.
pub fn on_picked<R: Runtime>(app: &AppHandle<R>, payload: &str) {
    let Some((nonce, json)) = payload.split_once(':') else {
        return;
    };
    if !consume_session(nonce) {
        // Not a sentinel this session minted: a page setting document.title
        // itself, or a stale/expired session. Ignore it — do NOT clear the
        // session, so a page spamming sentinels cannot cancel the user's pick.
        eprintln!("[aegis-picker] ignored sentinel with invalid session nonce");
        return;
    }
    // The session is single-use, so a sentinel that MATCHED it has ended it, whatever the
    // payload turns out to be. Reporting that HERE rather than on the success path is what
    // makes the button honest: a duplicate rule, a malformed payload, an over-cap file and
    // a failed write all return below WITHOUT emitting `picker.picked`, and in every one of
    // them the page has already torn its own overlay down — so the toolbar button must stop
    // claiming to be armed. Putting this after the success emit instead would leave it stuck
    // on for exactly the cases that report nothing.
    emit_state(app, false);
    let parsed: Value = serde_json::from_str(json).unwrap_or(Value::Null);
    // A cancelled session — the user pressed Escape in the page — is a legitimate report,
    // not a malformed one, so it is handled before `build_rule` rather than being left to
    // fail as an empty selector. It writes nothing at all; the state report above is the
    // whole of its effect.
    if parsed.get("cancelled").and_then(Value::as_bool) == Some(true) {
        return;
    }
    let selector = parsed.get("selector").and_then(Value::as_str).unwrap_or("");
    let host = parsed.get("host").and_then(Value::as_str).unwrap_or("");
    let Some(rule) = build_rule(host, selector) else {
        eprintln!("[aegis-picker] rejected malformed pick (host={host:?})");
        return;
    };
    let mut text = crate::customfilters::load(app);
    if text.lines().any(|l| l.trim() == rule) {
        return; // already have this rule
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    if text.len() + rule.len() + 1 > MAX_FILTER_BYTES {
        eprintln!(
            "[aegis-picker] rejected pick: custom-filter file is at {} bytes (cap {MAX_FILTER_BYTES})",
            text.len()
        );
        return;
    }
    text.push_str(&rule);
    text.push('\n');
    // `write` reports whether the `.txt` landed, because the `picker.picked` event below is
    // the UI's only signal that the pick was saved. Emitting it for a write that failed told
    // the user their element was blocked when it is not.
    if let Err(e) = crate::customfilters::write(app, &text) {
        eprintln!("[aegis-picker] the rule was NOT saved ({e}); not reporting a pick");
        return;
    }
    crate::adblock_refresh::refresh(app);
    crate::emit_event(app, "picker.picked", json!({ "rule": rule }));
    eprintln!("[aegis-picker] added rule: {rule}");
}

/// Evaluate `js` in the ACTIVE tab's content webview. Returns whether there was a webview
/// to evaluate it in — the only thing all four platform arms can honestly report, and the
/// same answer both picker channels need.
///
/// Extracted so `picker.start` and `picker.stop` share ONE copy of the per-platform
/// injection. The arms differ only in the engine's eval call; duplicated per channel they
/// would drift, and the macOS one carries a `move`-closure requirement that is easy to get
/// wrong on the second copy.
#[allow(clippy::needless_return)] // a cfg arm's trailing `return` is the point of each block
fn inject<R: Runtime>(app: &AppHandle<R>, js: &str) -> bool {
    // `with_webview` takes an `FnOnce(..) + Send + 'static` closure, so every arm needs an
    // OWNED copy: a borrow of this parameter would not outlive the call.
    let js = js.to_string();
    // Linux: WebKitGTK evaluate_javascript (native, no async callback needed).
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        let Some(content) = crate::nav::active_webview(app) else {
            return false;
        };
        let _ = content.with_webview(move |pw| {
            pw.inner()
                .evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
        });
        return true;
    }
    // Windows: WebView2 ExecuteScript (async, fire-and-forget — the sentinel
    // is caught by DocumentTitleChanged in nav_url_win.rs).
    #[cfg(target_os = "windows")]
    {
        use webview2_com::ExecuteScriptCompletedHandler;
        let Some(content) = crate::nav::active_webview(app) else {
            return false;
        };
        let _ = content.with_webview(move |pw| unsafe {
            let core = match pw.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            // HSTRING implements Param<PCWSTR>, so we can pass it directly.
            let hstr = windows::core::HSTRING::from(js);
            let handler = ExecuteScriptCompletedHandler::create(Box::new(|_hr, _result| Ok(())));
            let _ = core.ExecuteScript(&hstr, &handler);
        });
        return true;
    }
    // macOS: WKWebView evaluateJavaScript (async, fire-and-forget — the sentinel is caught
    // by KVO on title in nav_url_mac.rs).
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_foundation::NSString;
        use objc2_web_kit::WKWebView;
        let Some(content) = crate::nav::active_webview(app) else {
            return false;
        };
        // `move` is REQUIRED here, not stylistic: `with_webview` takes an
        // `FnOnce(..) + Send + 'static` closure, and `NSString::from_str(&js)` only
        // *borrows* `js`. Without `move` the closure captures `js` by reference and fails to
        // compile with "closure may outlive the current function, but it borrows `js`". The
        // owned copy above is what makes the same shape work in all three arms.
        let _ = content.with_webview(move |pw| {
            let ptr = pw.inner() as *mut WKWebView;
            if ptr.is_null() {
                return;
            }
            // SAFETY: ptr is non-null and is a valid WKWebView owned by wry.
            if let Some(webview) = unsafe { Retained::retain(ptr) } {
                unsafe {
                    let js = NSString::from_str(&js);
                    // No completion handler needed — the picker signals via
                    // document.title, caught by the title KVO observer.
                    webview.evaluateJavaScript_completionHandler(&js, None);
                }
            }
        });
        return true;
    }
    // Fallback for unsupported platforms (e.g. Android): there is no content webview to
    // inject into, so nothing is armed and nothing needs tearing down.
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, js);
        return false;
    }
}

/// `picker.start`: mint a session, inject the overlay, and report whether it is armed.
fn start<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    // Mint the session nonce BEFORE injecting, so the overlay we inject is provably the one
    // holding it. Bail out rather than fall back to guessable randomness: an unguessable
    // nonce is the entire security property here.
    let Some(nonce) = begin_session() else {
        eprintln!("[aegis-picker] refusing to start: no OS randomness for session nonce");
        return Ok(json!({ "ok": false, "active": false, "error": "no-randomness" }));
    };
    let armed = inject(app, &picker_js(&nonce));
    // `active` is `armed`, never a literal `true`: with no content webview (Android) or no
    // active tab the overlay was never injected, so reporting "armed" would be a button
    // claiming a session that does not exist. The session is still minted above and expires
    // on its own, because the nonce must exist before the injection is attempted.
    if armed {
        emit_state(app, true);
    }
    Ok(json!({ "ok": armed, "active": armed }))
}

/// `picker.stop`: revoke the session and tear the overlay down.
///
/// This is the half the toolbar button did not have. Until it existed the picker's ONLY
/// exits were a pick and an Escape, both inside the page, and the overlay's opening line
/// (`if (window.__aegisPicking) return;`) made every later injection a silent no-op — so the
/// button could arm the picker and never disarm it without reloading the page.
fn stop<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    // Revoke FIRST. The nonce is already baked into the running overlay's closure, so
    // clearing the session is what actually stops a sentinel that page might still fire;
    // the injection only removes the listeners.
    clear_session();
    let injected = inject(app, STOP_JS);
    emit_state(app, false);
    Ok(json!({ "ok": injected, "active": false }))
}

/// Handle the two picker channels.
///
/// Generic over `R: Runtime` for the reason [`on_picked`] is: `nav::active_webview` is
/// already generic, and `lib.rs`'s dispatch arm is the only production caller, so it infers
/// `Wry` unchanged.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    _payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "picker.start" => Some(start(app)),
        "picker.stop" => Some(stop(app)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // ── build_rule: the pure half of the authorisation+validation path ──────────

    #[test]
    fn build_rule_scopes_to_host() {
        assert_eq!(
            build_rule("example.com", "#banner").as_deref(),
            Some("example.com###banner")
        );
    }

    #[test]
    fn build_rule_accepts_real_generated_selectors() {
        // Shapes `selectorFor` in PICKER_JS_TEMPLATE actually emits.
        for sel in [
            "#ad",
            "div.slot",
            "div:nth-of-type(2)",
            "div.a > span:nth-of-type(3)",
            r"#a\}b", // CSS.escape output for a hostile id
            r#"[data-x="1"]"#,
        ] {
            assert!(
                build_rule("example.com", sel).is_some(),
                "legit selector rejected: {sel}"
            );
        }
    }

    #[test]
    fn build_rule_rejects_empty_selector() {
        assert!(build_rule("example.com", "").is_none());
        assert!(build_rule("example.com", "   ").is_none());
    }

    #[test]
    fn build_rule_rejects_empty_host() {
        // An empty host would emit a GLOBAL `##sel` cosmetic rule, hiding the
        // element on every site. The overlay always supplies a hostname, so its
        // absence is a malformed payload, not a request for a wider rule.
        assert!(build_rule("", "#banner").is_none());
    }

    #[test]
    fn build_rule_rejects_css_breakout_in_selector() {
        // These are the characters that would let a forged selector escape the
        // generated `sel{display:none!important}` text.
        for sel in [
            "a} body{display:none",
            "a{bad",
            "a;color:red",
            "}@import url(evil)",
            "a\nb",
            "a\u{0}b",
            "#a\\", // trailing lone backslash — would escape the generated text
        ] {
            assert!(
                build_rule("example.com", sel).is_none(),
                "css-breakout selector accepted: {sel:?}"
            );
        }
    }

    #[test]
    fn build_rule_accepts_css_escaped_braces() {
        // `CSS.escape` turns an id of `a}b` into `a\}b`. That is a LITERAL brace in
        // the selector, not a CSS block terminator, so it must be accepted —
        // rejecting it would break picking any element with braces in its id.
        assert_eq!(
            build_rule("example.com", r"#a\}b").as_deref(),
            Some(r"example.com###a\}b")
        );
        assert!(build_rule("example.com", r".x\;y").is_some());
        assert!(build_rule("example.com", r".\@media").is_some());
    }

    #[test]
    fn build_rule_rejects_field_separator_in_host() {
        // `#` is the `host##selector` separator, and `,`/`/`/whitespace have no
        // business in a hostname. Without this a forged host could forge the
        // scope half of the rule.
        for host in ["a.com##evil", "evil.com,other.com", "a b.com", "a.com/x"] {
            assert!(
                build_rule(host, "#banner").is_none(),
                "bad host accepted: {host:?}"
            );
        }
    }

    #[test]
    fn build_rule_rejects_overlong_selector() {
        let long = "a".repeat(MAX_SELECTOR_LEN + 1);
        assert!(build_rule("example.com", &long).is_none());
        let ok = "a".repeat(MAX_SELECTOR_LEN);
        assert!(build_rule("example.com", &ok).is_some());
    }

    // ── session nonce: the actual authorisation check ──────────────────────────

    #[test]
    fn session_nonce_round_trips_once() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        let n = begin_session().expect("os randomness");
        assert!(consume_session(&n), "fresh nonce must be accepted");
        assert!(
            !consume_session(&n),
            "session must be single-use — a page must not be able to fire the \
             sentinel repeatedly"
        );
    }

    #[test]
    fn session_rejects_forged_nonce() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        let _real = begin_session().expect("os randomness");
        // This is the attack: a page sets document.title itself, with a nonce it
        // made up. No picker session of ours, so it must not be accepted.
        for forged in ["", "0", "deadbeef", &"f".repeat(32)] {
            assert!(
                !consume_session(forged),
                "forged nonce accepted: {forged:?}"
            );
        }
    }

    #[test]
    fn session_rejects_nonce_when_no_picker_running() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        // No begin_session() at all — the common case: a page sets the title on
        // a site the user is merely visiting.
        *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
        assert!(!consume_session("00000000000000000000000000000000"));
    }

    #[test]
    fn session_mismatch_does_not_cancel_a_live_pick() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        // A page spamming bogus sentinels must not be able to consume the user's
        // session and thereby cancel their in-progress pick.
        let real = begin_session().expect("os randomness");
        assert!(!consume_session("not-the-nonce"));
        assert!(
            consume_session(&real),
            "a mismatched sentinel must leave the real session intact"
        );
    }

    #[test]
    fn new_session_invalidates_the_previous_nonce() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        let first = begin_session().expect("os randomness");
        let second = begin_session().expect("os randomness");
        assert_ne!(first, second, "each session must get a fresh nonce");
        assert!(!consume_session(&first), "stale nonce must not be accepted");
        assert!(consume_session(&second));
    }

    #[test]
    fn nonce_is_lowercase_hex_of_expected_width() {
        // SESSION is process-global, and the `with_tmp_app` tests below hold the
        // shared lock for their whole body: without this, cargo test could run a
        // nonce test concurrently with an `on_picked` test and cross their sessions.
        let _guard = crate::test_support::lock();
        // `picker_js` substitutes the nonce into a JS string literal without
        // escaping; this pins the property that makes that safe.
        let n = begin_session().expect("os randomness");
        assert_eq!(n.len(), 32, "16 bytes hex-encoded");
        assert!(
            n.chars()
                .all(|c| c.is_ascii_hexdigit() && !c.is_uppercase()),
            "nonce must be lowercase hex: {n:?}"
        );
    }

    #[test]
    fn picker_js_bakes_the_nonce_and_leaves_no_placeholder() {
        let js = picker_js("abc123");
        assert!(js.contains(r#"var NONCE = "abc123";"#));
        assert!(
            !js.contains("__AEGIS_PICK_NONCE__"),
            "placeholder must be fully substituted"
        );
        // The nonce must live in the closure only — never on window, which page
        // script can read. This is the property that makes the gate work.
        assert!(
            !js.contains("window.__aegisNonce"),
            "nonce must not be exposed on window"
        );
    }

    #[test]
    fn picker_js_emits_the_nonce_in_the_sentinel() {
        let js = picker_js("abc123");
        assert!(js.contains("'AEGISPICK:' + NONCE + ':' + JSON.stringify"));
    }

    // ── on_picked: the ENTIRE security write path, end to end ────────────────
    //
    // Everything above is a pure half. These drive the real writer: the real
    // `customfilters` file, the real cap, the real `picker.picked` event. The
    // property asserted throughout is the OBSERVABLE one — what is on disk and
    // what the chrome is told — never "which branch ran".

    use tauri::{Listener, Manager};

    /// Where `customfilters` persists, so a test can seed or read the real file.
    fn filters_path<R: Runtime>(app: &AppHandle<R>) -> std::path::PathBuf {
        app.path()
            .app_data_dir()
            .expect("app data dir")
            .join("custom-filters.txt")
    }

    fn filters_on_disk<R: Runtime>(app: &AppHandle<R>) -> String {
        std::fs::read_to_string(filters_path(app)).unwrap_or_default()
    }

    /// Collect `picker.picked` payloads. `emit_event` rewrites `.` to `:`, and
    /// Tauri invokes a Rust listener callback SYNCHRONOUSLY inside `emit`, so
    /// `try_recv` immediately after `on_picked` returns is definitive — no
    /// timeout, and no flake waiting for a race to lose.
    fn watch_picked<R: Runtime>(app: &AppHandle<R>) -> std::sync::mpsc::Receiver<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        // `Listener::listen` hands back the event id, not a Result: a failed
        // registration would leave the channel empty, which every assertion here
        // already treats as "no event", so there is nothing to unwrap.
        let _id = app.listen("picker:picked", move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).unwrap_or(Value::Null));
        });
        rx
    }

    /// Collect `picker.state` payloads — the same shape as [`watch_picked`], for the event
    /// that answers "is the toolbar button still armed?". The toolbar's pressed state is a
    /// claim about the core, so every test below that ends or refuses a session asserts what
    /// this channel said, not merely that a filter was or was not written.
    fn watch_state<R: Runtime>(app: &AppHandle<R>) -> std::sync::mpsc::Receiver<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        let _id = app.listen("picker:state", move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).unwrap_or(Value::Null));
        });
        rx
    }

    /// The `{cancelled:true}` payload the overlay's Escape handler sends.
    fn cancelled(nonce: &str) -> String {
        format!("{SENTINEL}{nonce}:{}", json!({ "cancelled": true }))
    }

    /// The `document.title` the injected overlay sets, for a live session's
    /// nonce — `AEGISPICK:<nonce>:<json>`, byte for byte what
    /// `PICKER_JS_TEMPLATE` bakes in.
    fn sentinel(nonce: &str, host: &str, selector: &str) -> String {
        format!(
            "{SENTINEL}{nonce}:{}",
            json!({ "selector": selector, "host": host })
        )
    }

    /// Deliver a page-set `document.title` exactly as the three platform
    /// title-sentinel handlers do (`linux_layout::connect_title_label`,
    /// `nav_url_win`'s `DocumentTitleChanged`, `nav_url_mac`'s KVO observer):
    /// strip `SENTINEL` and hand the rest to `on_picked`. A title without the
    /// sentinel is not a pick at all, so it must not reach the writer.
    fn route_title<R: Runtime>(app: &AppHandle<R>, title: &str) {
        if let Some(payload) = title.strip_prefix(SENTINEL) {
            on_picked(app, payload);
        }
    }

    #[test]
    fn a_pick_persists_the_rule_and_tells_the_chrome() {
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            let n = begin_session().expect("os randomness");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert_eq!(filters_on_disk(app), "example.com###banner\n");
            assert_eq!(
                picked
                    .try_recv()
                    .expect("picker.picked must fire on a saved pick"),
                json!({ "rule": "example.com###banner" })
            );
        });
    }

    #[test]
    fn a_page_that_sets_the_title_itself_writes_nothing() {
        // THE attack: `document.title` is settable by any script on any site, and
        // the custom-filter file is persistent AND synced. Without a matching
        // nonce this must write nothing at all — not a rule, not an event.
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            // A live session exists, so the only thing standing between the page
            // and the file is the nonce comparison.
            let _real = begin_session().expect("os randomness");

            for forged in [
                // A well-formed sentinel carrying a nonce this session never minted.
                "AEGISPICK:deadbeefdeadbeefdeadbeefdeadbeef:{\"selector\":\"#x\",\"host\":\"evil.test\"}",
                // The right shape, no nonce at all.
                "AEGISPICK::{\"selector\":\"#x\",\"host\":\"evil.test\"}",
                // A page simply setting a title: not a sentinel, so it must not
                // even reach `on_picked`.
                "My clever page:{\"selector\":\"#x\",\"host\":\"evil.test\"}",
            ] {
                route_title(app, forged);
            }

            assert!(
                filters_on_disk(app).is_empty(),
                "a forged sentinel wrote a filter: {:?}",
                filters_on_disk(app)
            );
            assert!(
                picked.try_recv().is_err(),
                "a forged sentinel reported a pick to the chrome"
            );
        });
    }

    #[test]
    fn a_pick_whose_write_fails_is_reported_as_nothing() {
        // The control-that-lies case, and the reason `write` was made to return
        // a Result: `picker.picked` is the UI's ONLY signal that the rule was
        // saved. Emitting it for a write that failed told the user their element
        // was blocked when it is not.
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            let n = begin_session().expect("os randomness");
            let _blocked = crate::test_support::block_store_file(app, "custom-filters.txt");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert!(
                picked.try_recv().is_err(),
                "picker.picked fired for a rule that was never written"
            );
        });
    }

    #[test]
    fn picking_the_same_element_twice_stores_one_rule() {
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);

            // A fresh session each round, exactly as a second click on the
            // picker would mint one.
            let first = begin_session().expect("os randomness");
            route_title(app, &sentinel(&first, "example.com", "#banner"));
            assert_eq!(
                picked.try_recv().expect("the first pick is reported"),
                json!({ "rule": CAP_RULE })
            );

            let second = begin_session().expect("os randomness");
            route_title(app, &sentinel(&second, "example.com", "#banner"));

            assert_eq!(
                filters_on_disk(app),
                format!("{CAP_RULE}\n"),
                "the second pick must be a no-op, not a duplicate line"
            );
            assert!(
                picked.try_recv().is_err(),
                "the duplicate pick must not re-report — nothing changed"
            );
        });
    }

    #[test]
    fn a_pick_is_appended_to_a_filter_file_with_no_trailing_newline() {
        // Hand-edited and imported `.txt` files routinely lack a final newline.
        // Appending without inserting one would fuse the new rule onto the last
        // existing line and silently corrupt it.
        crate::test_support::with_tmp_app(|app| {
            crate::jsonstore::write_atomic(&filters_path(app), b"||legacy.test^")
                .expect("seed a file with no trailing newline");
            let n = begin_session().expect("os randomness");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert_eq!(
                filters_on_disk(app),
                "||legacy.test^\nexample.com###banner\n"
            );
        });
    }

    /// The cap is what stops a pick — or a synced filter file — becoming a ~20 MB
    /// engine re-parse amplifier. `on_picked` accepts a rule only while
    /// `existing.len() + rule.len() + 1 <= MAX_FILTER_BYTES`, so pin BOTH sides
    /// of that boundary: one byte over is refused and changes nothing, and
    /// exactly at the cap is accepted.
    const CAP_RULE: &str = "example.com###banner";

    /// Seed the filter file with `len` newlines, so its length is exactly `len`
    /// and it already ends in one (no inserted newline shifts the boundary).
    fn seed_len<R: Runtime>(app: &AppHandle<R>, len: usize) {
        crate::jsonstore::write_atomic(&filters_path(app), "\n".repeat(len).as_bytes())
            .expect("seed the filter file");
    }

    #[test]
    fn a_pick_one_byte_over_the_filter_cap_is_refused_and_changes_nothing() {
        crate::test_support::with_tmp_app(|app| {
            let over = MAX_FILTER_BYTES - CAP_RULE.len();
            seed_len(app, over);
            let picked = watch_picked(app);
            let n = begin_session().expect("os randomness");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert!(
                picked.try_recv().is_err(),
                "a pick past the cap was reported as saved"
            );
            assert_eq!(
                filters_on_disk(app).len(),
                over,
                "the file must be left exactly as it was"
            );
        });
    }

    #[test]
    fn a_pick_that_fits_exactly_under_the_filter_cap_is_saved() {
        crate::test_support::with_tmp_app(|app| {
            let at = MAX_FILTER_BYTES - CAP_RULE.len() - 1;
            seed_len(app, at);
            let picked = watch_picked(app);
            let n = begin_session().expect("os randomness");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert_eq!(
                picked.try_recv().expect("a rule that fits is saved"),
                json!({ "rule": CAP_RULE })
            );
            let on_disk = filters_on_disk(app);
            assert_eq!(
                on_disk.len(),
                MAX_FILTER_BYTES,
                "file grows to exactly the cap"
            );
            assert!(
                on_disk.ends_with(&format!("{CAP_RULE}\n")),
                "the appended rule must be the last line, not fused onto the filler"
            );
        });
    }

    // ── dispatch: channel ownership + session minting ────────────────────────

    #[test]
    fn dispatch_declines_a_channel_it_does_not_own() {
        crate::test_support::with_tmp_app(|app| {
            // `None` is how `lib.rs`'s dispatch chain knows to keep looking; a
            // `Some` here would make `picker` swallow every other module's
            // channel that reached it.
            assert!(dispatch(app, "some.other.channel", &Value::Null).is_none());
            assert!(dispatch(app, "", &Value::Null).is_none());
        });
    }

    #[test]
    fn dispatch_mints_the_session_even_when_there_is_nothing_to_inject_into() {
        // The nonce must be minted BEFORE the injection is attempted, so the
        // overlay we inject is provably the one holding it. There is no content
        // webview on a MockRuntime, so the desktop branch reports `{ok:false}`
        // — and the session it minted is still live, which is what makes the
        // ordering observable rather than merely stated.
        crate::test_support::with_tmp_app(|app| {
            *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;

            let reply = crate::test_support::ran(
                dispatch(app, "picker.start", &Value::Null),
                "picker.start",
            );

            let reply = reply.expect("picker.start is dispatched to picker::dispatch");
            assert_eq!(reply["ok"], json!(false), "no webview to inject into");
            // The `active` half is what the toolbar button's pressed state is derived from.
            // It MUST follow `ok` rather than being a literal `true`: with no overlay injected
            // there is no session in the page, so `active: true` would be a control claiming
            // a state the core does not hold.
            assert_eq!(
                reply["active"],
                json!(false),
                "a start that injected nothing must not report the picker as armed"
            );
            assert!(
                SESSION.lock().unwrap_or_else(|e| e.into_inner()).is_some(),
                "the session must be minted before injection is attempted"
            );
        });
    }

    // ── picker.stop: the off switch the picker did not have ──────────────────

    #[test]
    fn stop_revokes_the_session_and_reports_inactive() {
        crate::test_support::with_tmp_app(|app| {
            let state = watch_state(app);
            let _armed = begin_session().expect("os randomness");

            let reply =
                crate::test_support::ran(dispatch(app, "picker.stop", &Value::Null), "picker.stop")
                    .expect("picker.stop is dispatched to picker::dispatch");

            // Revoking the session is the part that matters for SAFETY, and it is separate
            // from the injection: the nonce is already baked into the running overlay's
            // closure, so the injection only removes listeners while clearing SESSION is
            // what stops a sentinel that page might still fire.
            assert!(
                SESSION.lock().unwrap_or_else(|e| e.into_inner()).is_none(),
                "picker.stop must revoke the session, not just tear the overlay down"
            );
            assert_eq!(
                reply["active"],
                json!(false),
                "a stopped picker is not active, whatever the injection managed"
            );
            assert_eq!(
                state.try_recv().expect("picker.state reports the stop"),
                json!({ "active": false })
            );
        });
    }

    #[test]
    fn a_sentinel_minted_before_a_stop_can_no_longer_write_a_rule() {
        // The attack the revocation closes. A page that captured the nonce while the overlay
        // was armed — it is in the closure, and a determined page could read it — must not be
        // able to fire the sentinel after the user pressed stop.
        crate::test_support::with_tmp_app(|app| {
            let nonce = begin_session().expect("os randomness");

            crate::test_support::ran(dispatch(app, "picker.stop", &Value::Null), "picker.stop")
                .expect("picker.stop");

            route_title(app, &sentinel(&nonce, "evil.test", "#banner"));

            assert!(
                filters_on_disk(app).is_empty(),
                "a stop must invalidate a nonce the page already had: {:?}",
                filters_on_disk(app)
            );
        });
    }

    #[test]
    fn dispatch_still_declines_a_channel_it_does_not_own() {
        // `dispatch` is now a two-arm `match` rather than an `if` + fallthrough, so the
        // "returns None so lib.rs keeps looking" contract needs re-pinning at the new shape.
        crate::test_support::with_tmp_app(|app| {
            assert!(dispatch(app, "picker.starts", &Value::Null).is_none());
            assert!(dispatch(app, "some.other.channel", &Value::Null).is_none());
            assert!(dispatch(app, "", &Value::Null).is_none());
        });
    }

    // ── picker.state: the button's pressed state must be the core's answer ──

    #[test]
    fn an_escape_reports_the_cancel_and_writes_no_rule() {
        // THE reason the overlay reports itself. Escape tears the overlay down inside the
        // page, so without this sentinel the core would never learn the session ended, the
        // toolbar button would stay pressed, and the next click would call `picker.stop` at a
        // picker that is no longer armed.
        //
        // It pins the OBSERVABLE (state reported, nothing written, no rule event) and NOT
        // the `cancelled` arm in `on_picked`: a bare `{cancelled:true}` carries no selector,
        // so `build_rule` refuses it whether the arm is there or not. Removing the arm left
        // this test green, which is why the arm's own necessity is pinned separately by
        // `a_cancelled_payload_cannot_smuggle_a_rule_past_the_picker`.
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            let state = watch_state(app);
            let n = begin_session().expect("os randomness");

            route_title(app, &cancelled(&n));

            assert!(
                filters_on_disk(app).is_empty(),
                "a cancelled pick must write nothing: {:?}",
                filters_on_disk(app)
            );
            assert!(
                picked.try_recv().is_err(),
                "a cancel is not a pick and must not report a rule to the chrome"
            );
            assert_eq!(
                state.try_recv().expect("the cancel reports the state"),
                json!({ "active": false })
            );
        });
    }

    #[test]
    fn a_forged_cancel_reports_no_state_at_all() {
        // A page can set `document.title` to anything. Without the nonce a cancel must be
        // indistinguishable from ordinary noise — including emitting no state change, or a
        // page could un-press the user's toolbar button whenever it liked.
        crate::test_support::with_tmp_app(|app| {
            let state = watch_state(app);
            let _real = begin_session().expect("os randomness");

            for forged in ["deadbeefdeadbeefdeadbeefdeadbeef", "", "not-the-nonce"] {
                route_title(app, &cancelled(forged));
            }

            assert!(
                state.try_recv().is_err(),
                "a page forged a picker.state change: {:?}",
                state.try_recv()
            );
            assert!(filters_on_disk(app).is_empty());
        });
    }

    #[test]
    fn a_saved_pick_reports_inactive_alongside_the_rule() {
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            let state = watch_state(app);
            let n = begin_session().expect("os randomness");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert_eq!(
                picked.try_recv().expect("the rule is reported"),
                json!({ "rule": CAP_RULE })
            );
            // A separate event rather than a field folded into `picker.picked`: that
            // payload is the RULE, and one event meaning two things is how the two drift.
            assert_eq!(
                state.try_recv().expect("the pick reports the state"),
                json!({ "active": false })
            );
        });
    }

    #[test]
    fn a_pick_the_core_refuses_still_reports_inactive() {
        // The case that fixes WHERE the state emit sits. A duplicate rule and a failed write
        // both return without emitting `picker.picked` — but the page has already torn its
        // own overlay down, so an emit placed on the success path would leave the toolbar
        // button stuck on for exactly the outcomes that report nothing.
        crate::test_support::with_tmp_app(|app| {
            let state = watch_state(app);
            let n = begin_session().expect("os randomness");
            let _blocked = crate::test_support::block_store_file(app, "custom-filters.txt");

            route_title(app, &sentinel(&n, "example.com", "#banner"));

            assert_eq!(
                state
                    .try_recv()
                    .expect("a refused pick still ends the session"),
                json!({ "active": false })
            );
        });
    }

    // ── the injected JS: the handle, and only the handle ────────────────────

    #[test]
    fn the_overlay_publishes_exactly_one_handle_and_teardown_removes_it() {
        // A handle that outlived its session would let a page re-run a stale teardown, and
        // the count matters because this template is the one place a page-controlled surface
        // reaches into the overlay at all.
        let js = picker_js("abc123");
        assert_eq!(
            js.matches("window.__aegisPickStop").count(),
            2,
            "exactly one publish and one removal: {js}"
        );
        assert!(
            js.contains("try { delete window.__aegisPickStop; }"),
            "teardown must remove the handle, or it outlives the session it stops"
        );
    }

    #[test]
    fn the_published_handle_is_the_overlays_own_teardown() {
        // Assigning some other function would make `picker.stop` a silent no-op while
        // reporting success — the worst shape, because the core would clear the session and
        // the chrome would report inactive while the page stayed armed.
        let js = picker_js("abc123");
        assert!(
            js.contains("window.__aegisPickStop = teardown;"),
            "the handle must BE teardown"
        );
    }

    #[test]
    fn stop_js_calls_the_handle_the_overlay_publishes() {
        // The two halves are written in different files' worth of Rust and would otherwise
        // be able to disagree: a renamed handle leaves `picker.stop` injecting a call to
        // nothing, which reports success and disarms nothing.
        assert!(STOP_JS.contains("window.__aegisPickStop"));
        assert!(
            picker_js("abc123").contains("window.__aegisPickStop = teardown;"),
            "STOP_JS calls a handle the overlay never publishes"
        );
    }

    #[test]
    fn stop_js_reports_no_cancel_sentinel() {
        // `picker.stop` is the core asking, so the core already knows the session is over and
        // emits `picker.state` itself. A sentinel here would consume the session the stop had
        // just cleared and report the same transition twice.
        assert!(
            !STOP_JS.contains("AEGISPICK"),
            "picker.stop must not send a sentinel: {STOP_JS}"
        );
    }

    #[test]
    fn escape_reports_through_the_same_nonce_gated_sentinel_a_pick_uses() {
        // Same gate, same channel — so a page can forge neither, and there is one place
        // (`on_picked`) that has to be right about authorisation.
        let js = picker_js("abc123");
        assert!(
            js.contains("signal({ cancelled: true });"),
            "Escape must report the cancel: {js}"
        );
        assert!(
            js.contains("signal({ selector: sel, host: location.hostname });"),
            "a pick must still report its selector through the same helper"
        );
        // And the cancel must not carry a selector, or a cancelled session could reach
        // `build_rule` and write a filter for an empty element.
        assert!(!js.contains("cancelled: true, selector"));
    }

    #[test]
    fn the_sentinel_is_written_in_exactly_one_place() {
        // It goes through `signal()` now, which is what makes ONE nonce-gated writer for both
        // payloads instead of two inline copies. My first version of this asserted the
        // sentinel was "not written inline", which cannot distinguish anything — `signal()`
        // itself contains that literal — so the property is stated as a COUNT instead.
        let js = picker_js("abc123");
        assert!(
            js.contains("function signal(payload)"),
            "the sentinel writer must be a named helper"
        );
        assert_eq!(
            js.matches("document.title = 'AEGISPICK:'").count(),
            1,
            "exactly one writer for the sentinel: a second inline copy is a second set of \
             title-sentinel invariants that can drift from the first"
        );
        // And both payloads must route through it, so neither can bypass it.
        assert_eq!(
            js.matches("'AEGISPICK:' + NONCE + ':' + JSON.stringify")
                .count(),
            1,
            "the payload must be serialised once, inside the helper"
        );
    }

    #[test]
    fn a_cancelled_payload_cannot_smuggle_a_rule_past_the_picker() {
        // The `cancelled` arm's REAL observable, and the reason it is not merely a clearer
        // early return. A bare `{cancelled:true}` would be refused by `build_rule` anyway, so
        // deleting the arm changes nothing observable — I removed it in a mutation probe and
        // the whole suite stayed green. This payload is the one it does change: a page that
        // would like a cosmetic rule written while the core believes the user cancelled.
        //
        // Nothing else stops it. The nonce is REAL (the page holds it, in the overlay's
        // closure), the payload is well-formed, and `host`/`selector` both pass every
        // validator in `build_rule`. Only the explicit cancel arm refuses to look past the
        // flag — so without it, Escape would be the cheapest way to write an arbitrary
        // filter, and it would write it while logging a successful pick.
        crate::test_support::with_tmp_app(|app| {
            let picked = watch_picked(app);
            let state = watch_state(app);
            let n = begin_session().expect("os randomness");

            route_title(
                app,
                &format!(
                    "{SENTINEL}{n}:{}",
                    json!({ "cancelled": true, "selector": "#banner", "host": "evil.test" })
                ),
            );

            assert!(
                filters_on_disk(app).is_empty(),
                "a cancelled payload smuggled a rule onto disk: {:?}",
                filters_on_disk(app)
            );
            assert!(
                picked.try_recv().is_err(),
                "a cancelled payload reported a saved rule to the chrome"
            );
            // The session still ended, which is the whole legitimate effect of a cancel.
            assert_eq!(
                state
                    .try_recv()
                    .expect("the cancel still reports the state"),
                json!({ "active": false })
            );
        });
    }
}
