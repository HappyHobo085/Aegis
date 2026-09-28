//! A webview-agnostic ad/tracker blocker injected as a document-start script into the
//! content webview (and all its iframes). This is the ad-blocking layer for Chromium
//! webviews where wry does NOT expose request interception — Windows (WebView2) and
//! macOS (WKWebView) via Tauri — and it harmlessly supplements the WebKit content
//! filters on Linux (which is also where it's verified, since the same JS runs in any
//! engine). It (a) blocks fetch / XMLHttpRequest / sendBeacon to known ad-and-tracker
//! domains and (b) hides ad elements with injected CSS. Both lists are extracted from
//! the same bundled EasyList the Rust engine uses.
//!
//! ## The ad-block allowlist
//!
//! This tier used to be the one place the allowlist was accepted but not honoured:
//! `script()` was handed `host_allowlisted` and consulted it only for the WebRTC shim, so
//! an allowlisted page still had its beacons rejected, its ad slots hidden and its
//! cross-origin `window.open` stubbed. `adblock_layer` now gates the whole ad-block layer
//! on it, and the Android JNI getter threads the page's host through to the same seam.
//! Farbling is deliberately NOT gated on it (separate `fp-allowlist`).
//!
//! ## Anti-fingerprinting (farbling) — Task 6
//!
//! `script()` also composes the farbling shim (from `farble::shim_for`) into the
//! document-start injection. The shim is appended after the ad-block layer by
//! `compose(webrtc, farble, adblock_allowed)`. It uses a SEPARATE allowlist
//! (`fp-allowlist` / `farble::host_allowlisted`) from the ad-block allowlist, and consults
//! the `antiFingerprint` setting (`farble::level`). `off` or an allowlisted host → `""` →
//! no injection (fail-safe no-op).
//!
//! **Per-spawn limitation:** the farble shim (like the WebRTC shim and this ad-block tier)
//! is evaluated ONCE at content-webview creation (document-start script registered per
//! webview). Toggling the farbling level, the fp-allowlist, the ad-block allowlist, or the
//! ad-block on/off switch applies to newly spawned/reloaded tabs, not already-open ones. The
//! allowlist host is evaluated from the spawn URL at creation time — an in-tab SPA
//! navigation to a different host is not re-evaluated until the tab is reloaded/respawned.
//! This is the same model as the WebRTC shim and other spawn-time injections. (The
//! declarative Linux tier is the exception: it re-applies on an allowlist change, since it is
//! a per-webview filter set rather than a one-shot document-start script.)
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

/// Pop-under guard, injected at document-start on every platform (and every frame) —
/// but NOT for an ad-block-exempt page: either ad-block-allowlisted, or ad-blocking off
/// entirely (see `adblock_layer`, which is the one place that decision is made).
///
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

/// The document-start script injected into the desktop content webview: the WebRTC
/// IP-leak shim (per the user's `webrtcPolicy` + the ad-block per-site allowlist escape
/// hatch), then the pop-under guard (EVERY platform), then — on Windows/macOS — the heavier
/// fetch/XHR/cosmetic ad-block layer (Linux does full network blocking via WebKit content
/// filters, so it skips the ~1 MB injection), and finally the anti-fingerprinting (farbling)
/// shim (per the user's `antiFingerprint` setting + the SEPARATE `fp-allowlist` escape hatch).
///
/// `host_allowlisted` = the tab host is on the AD-BLOCK allowlist (doubles as the WebRTC
/// escape hatch). `host` = the raw host string of the spawn URL, used to look up the
/// FARBLE allowlist separately (`fp-allowlist`; a different allowlist from the ad-block one).
///
/// For `off` farbling level or an fp-allowlisted host, `farble::shim_for` returns `""` →
/// no farble injection (fail-safe no-op). A farble error never blocks webview creation.
///
/// **Per-spawn limitation:** the farble shim is evaluated ONCE at content-webview creation.
/// Toggling the level or fp-allowlist applies to newly spawned/reloaded tabs only.
///
/// Android builds its equivalent via the NativeInject + NativeWebrtc JNI getters.
///
/// Generic over `R: Runtime` (every callee already was) so the composition is reachable
/// from the `MockRuntime` test harness in `tests` below; the only production caller,
/// `nav::spawn_tab`, infers `R = Wry` exactly as before.
#[cfg_attr(target_os = "android", allow(dead_code))] // Android uses the JNI getters instead
pub fn script<R: tauri::Runtime>(
    app: &tauri::AppHandle<R>,
    host_allowlisted: bool,
    host: &str,
) -> String {
    let webrtc_policy = crate::settings::webrtc_policy(app);
    // WebRTC gets its OWN exemption list, not the ad-block one. They used to be the same
    // switch, which let a synced ad-block allowlist record (any device holding the data key
    // can write one) turn off IP-leak protection on every device. See `webrtc_exempt.rs`.
    let webrtc_exempt = crate::webrtc_exempt::host_exempt(app, host);
    // Fast path: use the pre-computed shim if prewarm() has run; fall back to shim_for.
    let webrtc = if webrtc_exempt {
        String::new()
    } else {
        crate::webrtc_shim::get_precomputed(&webrtc_policy)
            .map(|s| s.to_string())
            .unwrap_or_else(|| crate::webrtc_shim::shim_for(&webrtc_policy, webrtc_exempt))
    };
    // Farble shim: uses the SEPARATE fp-allowlist (not the ad-block allowlist). Fail-open:
    // a farble computation error (e.g. missing state) yields "" → no-op injection.
    let farble = {
        let level = crate::farble::level(app);
        let fp_allowlisted = crate::farble::host_allowlisted(app, host);
        crate::farble::shim_for(&level, fp_allowlisted)
    };
    let vault = crate::vault_inject::script();
    // The ad-block layer is gated on the on/off toggle AND the allowlist: this tier used
    // to consult only the allowlist, so switching ad-blocking off left the fetch/XHR/
    // cosmetic body and the pop-under guard live in every tab spawned afterwards.
    let adblock_block = crate::adblock::enabled(app) && !host_allowlisted;
    let mut result = compose(&webrtc, &farble, adblock_block);
    if !vault.is_empty() {
        result.push('\n');
        result.push_str(&vault);
    }
    result
}

/// The ad-block portion of the document-start script for one page. `block` is "should this
/// page be ad-blocked at the JS tier" = enabled AND not allowlisted — the two independent
/// ways the user says "show me this site's ads".
///
/// Empty when it is false. That means NEITHER the pop-under guard (which stubs
/// `window.open`, breaking legitimate scripted popups) NOR the heavy fetch/XHR/cosmetic
/// body (which rejects beacons and hides ad slots) is injected. The guard travels with
/// the body deliberately: it is the ad pop-under defence, so a user who switches
/// ad-blocking off has asked for their pop-unders back, and there is no second UI control
/// that would otherwise release it.
///
/// This is the one place the decision is made, and every tier that can honour the policy
/// goes through it: desktop [`script`] via [`compose`], and Android via
/// [`android_document_start_layer`]. (The engine tier can't share this seam — it answers
/// per request, so it vetoes in `adblock_engine::should_block` instead.)
/// Linux omits the body because it blocks at the network tier via WebKit content filters,
/// which carry their own `ignore-previous-rules` exemptions
/// (`adblock_convert::allowlist_exemptions`).
fn adblock_layer(block: bool) -> String {
    if !block {
        return String::new();
    }
    #[cfg(target_os = "linux")]
    {
        POPUP_GUARD.to_string()
    }
    #[cfg(not(target_os = "linux"))]
    {
        format!("{POPUP_GUARD}\n{}", BUILT.get_or_init(build))
    }
}

/// The Android document-start script's ad-block layer, for a content WebView on `host`.
///
/// Split out of the JNI export so the decision is reachable from a plain unit test: the
/// `#[no_mangle] extern "system"` entry point cannot be invoked from a Linux test, and
/// asserting on a re-typed copy of its body would prove nothing about the body. This tier
/// has no `AppHandle` (the document-start script is registered while the content WebView is
/// being created), so it reads the process-global mirror in `adblock_engine` — the same
/// `ENABLED`/`ALLOWLIST` the interceptor reads, so the two Android tiers cannot disagree.
///
/// `cfg`'d to Android + test: the JNI export is Android-only, and outside those there is no
/// caller — desktop `script()` reads the `AppHandle`-backed `adblock::enabled` instead. Gated
/// rather than `allow(dead_code)`, because here the absence of a caller is the truth.
#[cfg(any(target_os = "android", test))]
pub(crate) fn android_document_start_layer(host: &str) -> String {
    adblock_layer(
        crate::adblock_engine::enabled() && !crate::adblock_engine::host_is_allowlisted(host),
    )
}

/// Compose the document-start script from the (already-built) WebRTC shim prefix + the
/// ad-block layer (pop-under guard + the cached body) + the farble shim suffix.
/// Split out so the composition is unit-testable without an AppHandle.
///
/// `farble` is `""` for the `off`/allowlisted case → no farble appended (correct no-op).
///
/// `adblock_block` is the ad-block policy for this page — see [`adblock_layer`]. The farble
/// shim is deliberately unaffected: farbling is governed by the SEPARATE `fp-allowlist`, so
/// "show me this site's ads" must not also mean "stop farbling this site".
///
/// Empty parts are dropped rather than joined as blank lines, so an ad-block-exempt page
/// with farbling off yields a genuinely empty script instead of two newlines.
#[cfg_attr(target_os = "android", allow(dead_code))]
fn compose(webrtc: &str, farble: &str, adblock_block: bool) -> String {
    let adblock = adblock_layer(adblock_block);
    let parts: Vec<&str> = [webrtc, adblock.as_str(), farble]
        .into_iter()
        .filter(|p| !p.is_empty())
        .collect();
    parts.join("\n")
}

#[cfg(any(not(target_os = "linux"), test))]
fn build() -> String {
    let mut domains: Vec<&str> = Vec::new();
    let mut selectors: Vec<&str> = Vec::new();
    // Extract from EVERY bundled list (ads + trackers + Peter Lowe's), so the injected
    // blocker covers the same domains/cosmetics as the engine tier — see `adblock_lists`.
    for line in crate::adblock_lists::ALL
        .iter()
        .flat_map(|list| list.lines())
    {
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

/// JNI bridge for Android's `NativeInject.documentStartScript(host)` (a Kotlin `object`,
/// so the symbol is `Java_<pkg>_NativeInject_documentStartScript` and the second arg is
/// the singleton instance, ignored). Returns the full document-start script (pop-under
/// guard + the fetch/XHR/cosmetic ad-block layer) for Kotlin to register via
/// `WebViewCompat.addDocumentStartJavaScript`. Returns a null jstring on failure (Kotlin
/// then skips injection rather than crashing). Lives in `libapp_lib.so`, loaded at startup.
///
/// `host` is the content WebView's host, so a page the user turned ad-blocking off for —
/// globally, or via the per-host allowlist — gets no ad-block injection at all. The same
/// decision desktop `script()` makes, from the same policy, reached through the
/// process-global mirror because this tier has no `AppHandle` (see
/// [`android_document_start_layer`], which holds the logic so it is unit-testable).
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeInject_documentStartScript<'a>(
    mut env: jni::JNIEnv<'a>,
    _this: jni::objects::JObject<'a>,
    host: jni::objects::JString,
) -> jni::sys::jstring {
    let host: String = env.get_string(&host).map(|s| s.into()).unwrap_or_default();
    // Android gets its WebRTC shim and farble shim from their own JNI getters
    // (`NativeWebrtc` / `NativeFarble`), so only the ad-block layer is built here.
    // An empty script is the same effective outcome as the null-jstring failure below
    // (Kotlin registers nothing either way), so a panic degrades to "no injection".
    let s = crate::ffi_guard(|| android_document_start_layer(&host)).unwrap_or_default();
    match env.new_string(s) {
        Ok(js) => js.into_raw(),
        Err(_) => std::ptr::null_mut(),
    }
}

/// JNI bridge for Android's `NativeAdblock.enabled()` (a Kotlin `object`, so the symbol is
/// `Java_<pkg>_NativeAdblock_enabled` and the second arg is the singleton instance, ignored).
///
/// Kotlin needs this to key its document-start script cache on the on/off toggle as well as
/// the host. The cache is per-process, so without the toggle in the key a user who turned
/// ad-blocking off mid-session would keep being handed the script built while it was on —
/// the same stale-cache class of bug as the original host-only key, one level up.
///
/// It reads the same `ENABLED` global that `should_block` reads, so Kotlin's idea of
/// "ad-blocking is on" is the interceptor's idea by construction.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeAdblock_enabled(
    _env: jni::JNIEnv,
    _this: jni::objects::JObject,
) -> jni::sys::jboolean {
    crate::adblock_engine::enabled() as jni::sys::jboolean
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use crate::test_support::with_tmp_app;

    // ── The enabled toggle must reach the JS tier (Wave 1(2)) ────────────────────
    //
    // Before the fix BOTH of these were red: the toggle was read by the engine tier and by
    // Linux's WebKit tier, but this tier consulted only the allowlist, so switching
    // ad-blocking off left the pop-under guard and the whole fetch/XHR/cosmetic body
    // injected into every tab spawned afterwards. On Windows/macOS this injection is the
    // PRIMARY ad-block mechanism, so the toggle simply did not work there.
    #[test]
    fn disabled_adblock_injects_no_js_layer() {
        with_tmp_app(|app| {
            crate::adblock::dispatch(app, "adblock.setEnabled", &json!({ "enabled": false }))
                .unwrap()
                .unwrap();
            let s = super::script(app, false, "site.example");
            assert!(
                !s.contains("__aegisBlocked"),
                "with ad-block OFF the pop-under guard must not be injected, \
                 but window.open is still stubbed: {}",
                &s[..s.len().min(120)]
            );
            assert!(
                !s.contains("window.fetch="),
                "with ad-block OFF the fetch/XHR/cosmetic body must not be injected"
            );
            // …and back on, it returns. Guards against "fixed" by dropping the tier.
            crate::adblock::dispatch(app, "adblock.setEnabled", &json!({ "enabled": true }))
                .unwrap()
                .unwrap();
            let s = super::script(app, false, "site.example");
            assert!(
                s.contains("__aegisBlocked"),
                "re-enabling must restore the pop-under guard"
            );
        });
    }

    // The same claim for the ANDROID tier, through the seam the JNI export actually calls
    // (`android_document_start_layer`) rather than a re-typed copy of its expression.
    //
    // The two `set_policy` calls are the only writers of the process-global policy, and the
    // rest of the crate reaches them through `adblock::dispatch` inside `with_tmp_app` —
    // which holds `test_support::lock()` for its whole body. Taking that same lock is the
    // interlock; a lock of our own would exclude nothing.
    #[test]
    fn android_js_layer_follows_the_enabled_toggle() {
        let _guard = crate::test_support::lock();
        crate::adblock_engine::set_policy(false, &[]);
        assert!(
            super::android_document_start_layer("site.example").is_empty(),
            "with ad-block OFF the Android document-start script must carry no ad-block layer"
        );
        crate::adblock_engine::set_policy(true, &[]);
        assert!(
            !super::android_document_start_layer("site.example").is_empty(),
            "re-enabling must restore the Android ad-block layer"
        );
        // The allowlist still vetoes per host, independently of the toggle.
        crate::adblock_engine::set_policy(true, &["site.example".to_string()]);
        assert!(
            super::android_document_start_layer("site.example").is_empty(),
            "an allowlisted page must get no Android ad-block layer even with the toggle on"
        );
        assert!(
            !super::android_document_start_layer("other.example").is_empty(),
            "the allowlist is per host, so an unrelated page is unaffected"
        );
        crate::adblock_engine::set_policy(true, &[]);
    }

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
        assert!(
            s.contains("\"adnxs.com\""),
            "expected a known ad domain in the set"
        );
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
        // The composed script carries the guard on EVERY platform — incl. the Linux test
        // host, where the heavy ad-block injection is otherwise skipped. compose() with an
        // empty WebRTC prefix, empty farble and ad-blocking allowed is the default case.
        assert!(super::compose("", "", true).contains("__aegisBlocked"));
        // The WebRTC shim is prepended ahead of the guard when present.
        assert!(super::compose("/*shim*/", "", true).starts_with("/*shim*/"));
    }

    #[test]
    fn compose_appends_farble_after_popup_guard() {
        // A non-empty farble argument must appear AFTER the popup guard.
        let s = super::compose("", "/*farble*/", true);
        let guard_pos = s
            .find("__aegisBlocked")
            .expect("popup guard must be present");
        let farble_pos = s.find("/*farble*/").expect("farble must be present");
        assert!(
            farble_pos > guard_pos,
            "farble must appear after the popup guard: guard@{guard_pos} farble@{farble_pos}"
        );
        assert!(s.ends_with("/*farble*/"), "farble must be at the end");
    }

    #[test]
    fn compose_empty_farble_unchanged() {
        // An empty farble argument must not append anything.
        let with_empty = super::compose("", "", true);
        assert!(!with_empty.contains("/*farble*/"));
        // Sanity: popup guard still present.
        assert!(with_empty.contains("__aegisBlocked"));
    }

    // ── The ad-block allowlist reaches THIS tier ──────────────────────────────────
    //
    // `script()` is already handed `host_allowlisted` (nav.rs computes it from
    // `adblock::host_allowlisted`), but it only consulted it for the WebRTC shim. The
    // heavy ad-block body and the pop-under guard were injected for EVERY page, so a
    // site the user allowlisted — meaning "trust this site's ads" — still had its
    // fetch/XHR/beacon calls rejected, its elements hidden by cosmetic CSS, and its
    // cross-origin `window.open` stubbed out.
    #[test]
    fn allowlisted_page_gets_no_adblock_injection() {
        let s = super::compose("", "", false);
        assert!(
            !s.contains("__aegisBlocked"),
            "an ad-block-allowlisted page must not get the pop-under guard (window.open \
             stub), but the guard is still injected: {s}"
        );
        // The heavy body is gated by the same decision. On Linux `compose` never includes
        // it (the network tier blocks there), so assert via `adblock_layer` directly,
        // which is the seam BOTH desktop and the Android JNI getter go through.
        assert!(
            super::adblock_layer(false).is_empty(),
            "an allowlisted page must get an empty ad-block layer, not just lose the guard"
        );
        assert!(
            super::adblock_layer(true).contains("__aegisBlocked"),
            "a NON-allowlisted page must keep the guard"
        );
    }

    /// The allowlist gates ad-blocking ONLY. Farbling is governed by the separate
    /// `fp-allowlist`, so "show me this site's ads" must not silently also mean "stop
    /// farbling this site" (and vice versa) — the two lists are independent by design.
    #[test]
    fn allowlisting_ads_does_not_disable_farbling() {
        let s = super::compose("", "/*farble*/", false);
        assert!(
            !s.contains("__aegisBlocked"),
            "ad-block layer must still be gated: {s}"
        );
        assert!(
            s.contains("/*farble*/") && s == "/*farble*/",
            "the farble shim must survive on an allowlisted page (and be the whole \
             script when the WebRTC shim is also absent): {s}"
        );
        // ...and the WebRTC shim is keyed on the SAME ad-block allowlist (it is the
        // per-site WebRTC escape hatch), so it is absent too.
        assert!(
            super::compose("/*webrtc*/", "", false) == "/*webrtc*/",
            "an allowlisted page is 'trusted', so the WebRTC shim must not be injected"
        );
    }

    /// An allowlisted page with no farbling and no WebRTC shim must produce a genuinely
    /// empty script, not stray newlines. Kotlin caches and registers whatever string comes
    /// back, and `MainActivity` decides "injection unavailable" by emptiness.
    #[test]
    fn all_layers_absent_yields_an_empty_script_not_blank_lines() {
        assert_eq!(super::compose("", "", false), "");
        assert_eq!(
            super::compose("", "", true),
            super::POPUP_GUARD,
            "with only the ad-block layer present the script is exactly the guard"
        );
    }
}
