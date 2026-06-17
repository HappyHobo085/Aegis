//! Element picker (picker.* IPC). `picker.start` injects a picking overlay into
//! the content webview; the user hovers to highlight and clicks an element. The
//! overlay computes a CSS selector + the page host and signals them back by briefly
//! setting `document.title` to an `AEGISPICK:{json}` sentinel — caught by the
//! existing title-change handler (linux_layout::connect_title_label), which routes it
//! here. (A WebKit script-message handler would collide with wry's own catch-all
//! IPC handler, so the title channel keeps the picker off the native IPC surface.)
//! We persist `host##selector` as a custom cosmetic filter — the content-blocker
//! converter turns it into a css-display-none action, so it hides on future
//! visits — and re-install the engine. The element is hidden immediately
//! client-side too, for instant feedback.
use serde_json::{json, Value};
use tauri::AppHandle;

/// Sentinel prefix a picked selector's JSON is wrapped in (via document.title).
#[allow(dead_code)] // parsed only by the Linux WebKit title-changed signal (linux_layout)
pub const SENTINEL: &str = "AEGISPICK:";

/// Picking overlay: highlight on hover, pick on click, Esc to cancel. On pick it
/// hides the element (instant feedback) and signals {selector, host} via a short
/// title sentinel, restored after a moment. Idempotent while active.
#[cfg(target_os = "linux")]
const PICKER_JS: &str = r#"
(function () {
  if (window.__aegisPicking) return;
  window.__aegisPicking = true;
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
    document.title = 'AEGISPICK:' + JSON.stringify({ selector: sel, host: location.hostname });
    setTimeout(function () { try { document.title = orig; } catch (_) {} }, 400);
    teardown();
  }
  function key(e) { if (e.key === 'Escape') { e.preventDefault(); teardown(); } }
  document.addEventListener('mousemove', highlight, true);
  document.addEventListener('click', pick, true);
  document.addEventListener('keydown', key, true);
})();
"#;

/// Persist a picked element as a custom cosmetic filter and re-install the engine.
/// `payload` is the JSON `{selector, host}` from the title sentinel (prefix
/// already stripped). Called by linux_layout::connect_title_label.
#[cfg(target_os = "linux")]
pub fn on_picked(app: &AppHandle, payload: &str) {
    let parsed: Value = serde_json::from_str(payload).unwrap_or(Value::Null);
    let selector = parsed.get("selector").and_then(Value::as_str).unwrap_or("").trim();
    let host = parsed.get("host").and_then(Value::as_str).unwrap_or("").trim();
    if selector.is_empty() {
        return;
    }
    // Scope the cosmetic rule to the page host when we know it.
    let rule = if host.is_empty() {
        format!("##{selector}")
    } else {
        format!("{host}##{selector}")
    };
    let mut text = crate::customfilters::load(app);
    if text.lines().any(|l| l.trim() == rule) {
        return; // already have this rule
    }
    if !text.is_empty() && !text.ends_with('\n') {
        text.push('\n');
    }
    text.push_str(&rule);
    text.push('\n');
    crate::customfilters::write(app, &text);
    crate::adblock_refresh::refresh(app);
    let _ = crate::emit_event(app, "picker.picked", json!({ "rule": rule }));
    eprintln!("[aegis-picker] added rule: {rule}");
}

/// Handle `picker.start`: inject the picking overlay into the content webview.
pub fn dispatch(app: &AppHandle, channel: &str, _payload: &Value) -> Option<Result<Value, String>> {
    if channel != "picker.start" {
        return None;
    }
    #[cfg(target_os = "linux")]
    {
        use webkit2gtk::WebViewExt;
        let Some(content) = crate::nav::active_webview(app) else {
            return Some(Ok(json!({ "ok": false })));
        };
        let _ = content.with_webview(|pw| {
            pw.inner()
                .evaluate_javascript(PICKER_JS, None, None, None::<&gio::Cancellable>, |_| {});
        });
        Some(Ok(json!({ "ok": true })))
    }
    #[cfg(not(target_os = "linux"))]
    {
        let _ = app;
        Some(Ok(json!({ "ok": false })))
    }
}
