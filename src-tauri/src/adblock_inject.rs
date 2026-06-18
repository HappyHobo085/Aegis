//! A webview-agnostic ad/tracker blocker injected as a document-start script into the
//! content webview (and all its iframes). This is the ad-blocking layer for Chromium
//! webviews where wry does NOT expose request interception — Windows (WebView2) and
//! macOS (WKWebView) via Tauri — and it harmlessly supplements the WebKit content
//! filters on Linux (which is also where it's verified, since the same JS runs in any
//! engine). It (a) blocks fetch / XMLHttpRequest / sendBeacon to known ad-and-tracker
//! domains and (b) hides ad elements with injected CSS. Both lists are extracted from
//! the same bundled EasyList the Rust engine uses.
//!
//! Limitation vs. true network interception: requests the HTML parser makes directly
//! (`<img>`/`<script>`/`<iframe>` src) still hit the network — but the cosmetic layer
//! hides what they render, and the JS-API layer stops scripts/trackers/beacons.

// Caches only the HEAVY build() output (the ~1 MB ad/tracker domain set + cosmetic CSS),
// which parses once. The cheap per-call wrapper (the WebRTC shim + pop-under guard) is
// concatenated per call so it can vary with policy/allowlist without rebuilding the heavy
// part. The test calls build() directly.
#[cfg(not(target_os = "linux"))]
static BUILT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

/// Pop-under guard, injected at document-start on EVERY platform (and every frame).
/// On-click pop-under / pop-up ads on streaming sites open a new window to a rotating
/// ad-network domain via `window.open` — which no static domain list can keep ahead of.
/// So instead of chasing the destination, drop the *mechanism*: override `window.open`
/// to refuse CROSS-ORIGIN scripted popups before any window/tab opens. A harmless stub
/// is returned (with no-op `blur`/`focus`/`close`) so the caller's pop-under focus trick
/// doesn't throw and the script believes it succeeded (no fallback). Same-origin popups
/// (a site opening its own content) and non-http(s)/`about:blank` opens pass through —
/// the native `on_new_window` still vets those (blank shells + ad domains). This is the
/// "prevent it loading" layer; the network/navigation blockers remain as a backstop.
/// Trade-off: legit cross-origin scripted popups (e.g. an OAuth login window) are also
/// blocked — rare on the target sites, and a real `<a target=_blank>` link still opens.
const POPUP_GUARD: &str = r#"(function(){
  try {
    var realOpen = window.open;
    if (typeof realOpen !== 'function') return;
    var stub = { closed: true, __aegisBlocked: true,
      close: function(){}, focus: function(){}, blur: function(){}, postMessage: function(){} };
    window.open = function(u, name, features) {
      try {
        var d = new URL(u == null ? '' : String(u), location.href);
        if ((d.protocol === 'http:' || d.protocol === 'https:') && d.origin !== location.origin) {
          return stub; // cross-origin scripted popup = pop-under ad → drop it
        }
      } catch (e) {}
      return realOpen.apply(this, arguments);
    };
  } catch (e) {}
})();"#;

/// Document-start shim that keeps content pages reporting themselves visible, so an in-app
/// overlay hiding the content webview can't fire visibilitychange-hidden and arm a
/// malvertising redirect/pop-under. Shipped on EVERY platform alongside POPUP_GUARD.
const VISIBILITY_GUARD: &str = include_str!("visibility_shim.js");

/// The document-start script injected into the desktop content webview: the WebRTC
/// IP-leak shim (per the user's `webrtcPolicy` + the per-site allowlist escape hatch),
/// then the pop-under guard (EVERY platform), then — on Windows/macOS — the heavier
/// fetch/XHR/cosmetic ad-block layer (Linux does full network blocking via WebKit content
/// filters, so it skips the ~1 MB injection). `host_allowlisted` = the tab host is on the
/// ad-block allowlist, which doubles as the WebRTC escape hatch (shim returns ""). Android
/// builds its equivalent via the NativeInject + NativeWebrtc JNI getters.
#[cfg_attr(target_os = "android", allow(dead_code))] // Android uses the JNI getters instead
pub fn script(app: &tauri::AppHandle, host_allowlisted: bool) -> String {
    let webrtc = crate::webrtc_shim::shim_for(&crate::settings::webrtc_policy(app), host_allowlisted);
    compose(&webrtc)
}

/// Compose the document-start script from the (already-built) WebRTC shim prefix + the
/// pop-under guard + (non-Linux) the cached ad-block body. Split out so the composition is
/// unit-testable without an AppHandle.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn compose(webrtc: &str) -> String {
    #[cfg(target_os = "linux")]
    {
        format!("{webrtc}\n{POPUP_GUARD}\n{VISIBILITY_GUARD}")
    }
    #[cfg(not(target_os = "linux"))]
    {
        format!("{webrtc}\n{POPUP_GUARD}\n{VISIBILITY_GUARD}\n{}", BUILT.get_or_init(build))
    }
}

#[cfg(any(not(target_os = "linux"), test))]
fn build() -> String {
    let mut domains: Vec<&str> = Vec::new();
    let mut selectors: Vec<&str> = Vec::new();
    // Extract from EVERY bundled list (ads + trackers + Peter Lowe's), so the injected
    // blocker covers the same domains/cosmetics as the engine tier — see `adblock_lists`.
    for line in crate::adblock_lists::ALL.iter().flat_map(|list| list.lines()) {
        let l = line.trim();
        if let Some(rest) = l.strip_prefix("||") {
            // Plain domain anchor `||domain^` (no path, no $options) → block the domain
            // and its subdomains (the runtime check strips labels). Skip anything with
            // a path/options/wildcard so we only take clean host anchors.
            if let Some(dom) = rest.strip_suffix('^') {
                if !dom.is_empty()
                    && dom
                        .bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'.' || b == b'-')
                {
                    domains.push(dom);
                }
            }
        } else if let Some(sel) = l.strip_prefix("##") {
            // Generic element-hiding selector. Drop extended/procedural pseudos that
            // aren't plain CSS (they'd be invalid in a stylesheet).
            if !sel.is_empty() && !is_procedural(sel) {
                selectors.push(sel);
            }
        }
    }

    let domains_js = domains
        .iter()
        .map(|d| format!("\"{d}\""))
        .collect::<Vec<_>>()
        .join(",");

    // Emit the cosmetic rules in chunks so one invalid selector only voids its chunk
    // (a comma selector-list is all-or-nothing per rule).
    let css: String = selectors
        .chunks(1000)
        .map(|chunk| format!("{}{{display:none!important}}", chunk.join(",")))
        .collect::<Vec<_>>()
        .join("\n");
    let css_js = serde_json::to_string(&css).unwrap_or_else(|_| "\"\"".into());

    format!(
        r#"(function(){{
  var B=new Set([{domains_js}]);
  function blk(u){{try{{var h=new URL(u,location.href).hostname;while(h){{if(B.has(h))return true;var i=h.indexOf('.');if(i<0)break;h=h.slice(i+1);}}return false;}}catch(e){{return false;}}}}
  var of=window.fetch;
  if(of)window.fetch=function(i){{var u=typeof i==='string'?i:(i&&i.url);if(u&&blk(u))return Promise.reject(new TypeError('Blocked by Aegis'));return of.apply(this,arguments);}};
  var XO=XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open=function(m,u){{this.__ab=!!(u&&blk(u));return XO.apply(this,arguments);}};
  var XS=XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send=function(){{if(this.__ab)return;return XS.apply(this,arguments);}};
  if(navigator.sendBeacon){{var sb=navigator.sendBeacon.bind(navigator);navigator.sendBeacon=function(u,d){{if(blk(u))return true;return sb(u,d);}};}}
  function css(){{try{{var s=document.createElement('style');s.id='aegis-cosmetic';s.textContent={css_js};(document.head||document.documentElement).appendChild(s);}}catch(e){{}}}}
  if(document.documentElement)css();else document.addEventListener('DOMContentLoaded',css);
}})();"#
    )
}

/// Whether a cosmetic selector uses an extended/procedural pseudo (not plain CSS).
#[cfg(any(not(target_os = "linux"), test))]
fn is_procedural(sel: &str) -> bool {
    const MARKERS: [&str; 11] = [
        ":has(",
        ":has-text(",
        ":matches-css",
        ":style(",
        ":-abp",
        ":xpath(",
        ":upward(",
        ":contains(",
        ":if(",
        ":watch",
        ":remove(",
    ];
    MARKERS.iter().any(|m| sel.contains(m))
}

/// JNI bridge for Android's `NativeInject.documentStartScript()` (a Kotlin `object`,
/// so the symbol is `Java_<pkg>_NativeInject_documentStartScript` and the second arg is
/// the singleton instance, ignored). Returns the full document-start script (pop-under
/// guard + the fetch/XHR/cosmetic ad-block layer) for Kotlin to register via
/// `WebViewCompat.addDocumentStartJavaScript`. Returns a null jstring on failure (Kotlin
/// then skips injection rather than crashing). Lives in `libapp_lib.so`, loaded at startup.
#[cfg(target_os = "android")]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeInject_documentStartScript<'a>(
    env: jni::JNIEnv<'a>,
    _this: jni::objects::JObject<'a>,
) -> jni::sys::jstring {
    // Phase 1 folds the WebRTC shim in via the same InjectConfig seam used by script().
    let s = format!("{POPUP_GUARD}\n{VISIBILITY_GUARD}\n{}", build());
    match env.new_string(s) {
        Ok(js) => js.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn builds_a_blocker_script_with_domains_and_cosmetics() {
        // Test build() directly — script() is empty on the Linux test host (native
        // filters), but build() is what actually ships to Windows/macOS.
        let s = super::build();
        // Sanity: it's an IIFE that overrides fetch and injects cosmetic CSS.
        assert!(s.starts_with("(function(){"));
        assert!(s.contains("window.fetch="));
        assert!(s.contains("display:none!important"));
        // A known EasyList ad/tracker domain is in the blocklist Set.
        assert!(s.contains("\"adnxs.com\""), "expected a known ad domain in the set");
        // Procedural selectors are filtered out (no extended pseudos leak into CSS).
        assert!(!s.contains(":matches-css"));
        assert!(!s.contains(":has-text("));
    }

    #[test]
    fn visibility_shim_ships_in_the_composed_script() {
        // The shim is concatenated on every platform; compose("") is the Linux-host case.
        assert!(super::compose("").contains("aegis-visibility-shim"));
        assert!(super::compose("").contains("visibilityState"));
    }

    #[test]
    fn popup_guard_overrides_window_open_and_ships_everywhere() {
        let g = super::POPUP_GUARD;
        // It replaces window.open and gates on cross-origin, returning the marker stub.
        assert!(g.contains("window.open ="));
        assert!(g.contains("d.origin !== location.origin"));
        assert!(g.contains("__aegisBlocked"));
        // Same-origin / non-http(s) opens still fall through to the real window.open.
        assert!(g.contains("realOpen.apply"));
        // The composed script carries the guard on EVERY platform — incl. the Linux test
        // host, where the heavy ad-block injection is otherwise skipped. compose() with an
        // empty WebRTC prefix is the no-policy/allowlisted case.
        assert!(super::compose("").contains("__aegisBlocked"));
        // The WebRTC shim is prepended ahead of the guard when present.
        assert!(super::compose("/*shim*/").starts_with("/*shim*/"));
    }
}
