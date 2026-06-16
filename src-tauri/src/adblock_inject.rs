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

// Only the non-Linux script() path caches into this; the test calls build() directly.
#[cfg(not(target_os = "linux"))]
static SCRIPT: std::sync::OnceLock<String> = std::sync::OnceLock::new();

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

/// The document-start script injected into the content webview. The pop-under guard
/// runs on EVERY platform; the heavier fetch/XHR/cosmetic ad-block layer is added only
/// on Windows/macOS (Linux does full network blocking via WebKit content filters, so it
/// skips the ~1 MB injection — but still gets the tiny pop-under guard).
pub fn script() -> &'static str {
    #[cfg(target_os = "linux")]
    {
        POPUP_GUARD
    }
    #[cfg(not(target_os = "linux"))]
    {
        SCRIPT.get_or_init(|| format!("{POPUP_GUARD}\n{}", build())).as_str()
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
    fn popup_guard_overrides_window_open_and_ships_everywhere() {
        let g = super::POPUP_GUARD;
        // It replaces window.open and gates on cross-origin, returning the marker stub.
        assert!(g.contains("window.open ="));
        assert!(g.contains("d.origin !== location.origin"));
        assert!(g.contains("__aegisBlocked"));
        // Same-origin / non-http(s) opens still fall through to the real window.open.
        assert!(g.contains("realOpen.apply"));
        // script() carries the guard on EVERY platform — incl. the Linux test host,
        // where the heavy ad-block injection is otherwise skipped.
        assert!(super::script().contains("__aegisBlocked"));
    }
}
