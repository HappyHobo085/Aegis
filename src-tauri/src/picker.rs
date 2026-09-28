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
use tauri::AppHandle;

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
/// `__AEGIS_PICK_NONCE__` is substituted with the per-session nonce by
/// [`picker_js`]. It is read from the enclosing IIFE's closure and never
/// assigned to `window`, so page script cannot observe it. The sentinel the
/// overlay emits is `AEGISPICK:<nonce>:<json>`; [`on_picked`] rejects any
/// sentinel whose nonce is not the live session's, which is what stops a page
/// from injecting cosmetic rules by setting `document.title` itself.
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
  function teardown() {
    window.__aegisPicking = false;
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
    var orig = document.title;
    document.title = 'AEGISPICK:' + NONCE + ':' + JSON.stringify({ selector: sel, host: location.hostname });
    setTimeout(function () { try { document.title = orig; } catch (_) {} }, 400);
    teardown();
  }
  function key(e) { if (e.key === 'Escape') { e.preventDefault(); teardown(); } }
  document.addEventListener('mousemove', highlight, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', key, true);
})();
"#;

/// The picking overlay JS with `nonce` baked in. Substitution is safe without
/// escaping: [`begin_session`] only ever produces lowercase hex.
fn picker_js(nonce: &str) -> String {
    PICKER_JS_TEMPLATE.replace("__AEGIS_PICK_NONCE__", nonce)
}

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
pub fn on_picked(app: &AppHandle, payload: &str) {
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
    let parsed: Value = serde_json::from_str(json).unwrap_or(Value::Null);
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

/// Handle `picker.start`: inject the picking overlay into the content webview.
/// The JS is engine-agnostic; only the injection mechanism differs per platform.
#[allow(clippy::needless_return)] // return is needed inside #[cfg] blocks to prevent fallthrough
pub fn dispatch(app: &AppHandle, channel: &str, _payload: &Value) -> Option<Result<Value, String>> {
    if channel != "picker.start" {
        return None;
    }
    // Mint the session nonce BEFORE injecting, so the overlay we inject is
    // provably the one holding it. Bail out rather than fall back to guessable
    // randomness: an unguessable nonce is the whole authorisation check.
    let Some(nonce) = begin_session() else {
        eprintln!("[aegis-picker] refusing to start: no OS randomness for session nonce");
        return Some(Ok(json!({ "ok": false, "error": "no-randomness" })));
    };
    let js = picker_js(&nonce);
    // Linux: WebKitGTK evaluate_javascript (native, no async callback needed).
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        let Some(content) = crate::nav::active_webview(app) else {
            return Some(Ok(json!({ "ok": false })));
        };
        let _ = content.with_webview(move |pw| {
            pw.inner()
                .evaluate_javascript(&js, None, None, None::<&gio::Cancellable>, |_| {});
        });
        return Some(Ok(json!({ "ok": true })));
    }
    // Windows: WebView2 ExecuteScript (async, fire-and-forget — the sentinel
    // is caught by DocumentTitleChanged in nav_url_win.rs).
    #[cfg(target_os = "windows")]
    {
        use webview2_com::ExecuteScriptCompletedHandler;
        let Some(content) = crate::nav::active_webview(app) else {
            return Some(Ok(json!({ "ok": false })));
        };
        let _ = content.with_webview(|pw| unsafe {
            let core = match pw.controller().CoreWebView2() {
                Ok(c) => c,
                Err(_) => return,
            };
            // HSTRING implements Param<PCWSTR>, so we can pass it directly.
            let hstr = windows::core::HSTRING::from(js);
            let handler = ExecuteScriptCompletedHandler::create(Box::new(|_hr, _result| Ok(())));
            let _ = core.ExecuteScript(&hstr, &handler);
        });
        return Some(Ok(json!({ "ok": true })));
    }
    // macOS: WKWebView evaluateJavaScript (async, fire-and-forget — the sentinel
    // is caught by KVO on title in nav_url_mac.rs).
    #[cfg(target_os = "macos")]
    {
        use objc2::rc::Retained;
        use objc2_foundation::NSString;
        use objc2_web_kit::WKWebView;
        let Some(content) = crate::nav::active_webview(app) else {
            return Some(Ok(json!({ "ok": false })));
        };
        // `move` is REQUIRED here, not stylistic: `with_webview` takes a
        // `FnOnce(..) + Send + 'static` closure, and `NSString::from_str(&js)`
        // only *borrows* the local `js`. Without `move` the closure captures `js`
        // by reference and fails to compile with "closure may outlive the current
        // function, but it borrows `js`". The Linux branch below does the same
        // thing via `HSTRING::from(js)`, which moves instead of borrowing.
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
        return Some(Ok(json!({ "ok": true })));
    }
    // Fallback for unsupported platforms (e.g. Android).
    #[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
    {
        let _ = (app, js);
        Some(Ok(json!({ "ok": false })))
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
        // No begin_session() at all — the common case: a page sets the title on
        // a site the user is merely visiting.
        *SESSION.lock().unwrap_or_else(|e| e.into_inner()) = None;
        assert!(!consume_session("00000000000000000000000000000000"));
    }

    #[test]
    fn session_mismatch_does_not_cancel_a_live_pick() {
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
        let first = begin_session().expect("os randomness");
        let second = begin_session().expect("os randomness");
        assert_ne!(first, second, "each session must get a fresh nonce");
        assert!(!consume_session(&first), "stale nonce must not be accepted");
        assert!(consume_session(&second));
    }

    #[test]
    fn nonce_is_lowercase_hex_of_expected_width() {
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
}
