//! Link gestures: **Ctrl/Cmd+click, middle-click and Shift+click on a link open it in a new
//! background tab** instead of navigating the tab you are reading.
//!
//! The gesture layer is a document-start JavaScript layer
//! ([`include_str!`]'d from `link_gestures.js`, executed in the page's own MAIN world the
//! same way `farble`'s and `find`'s shims are). There is deliberately **no IPC channel and
//! no new bridge**: on a gesture it calls the page's *native* `window.open`, so the result
//! arrives at the same `nav::on_new_window` (desktop) / `MainActivity.onCreateWindow`
//! (Android) handler that already serves `target=_blank`, and therefore inherits the exact
//! same admission control — [`crate::adblock_engine::is_unwanted_popup`] for the ad
//! pop-under case and [`crate::nav::is_navigable`] for the scheme.
//!
//! ## Why the layer must be injected BEFORE the pop-under guard
//!
//! [`crate::adblock_inject`]'s `POPUP_GUARD` *replaces* `window.open` with a stub that
//! refuses cross-origin http(s) opens — the defence against on-click pop-under ads. A
//! Ctrl+click to another site is by definition cross-origin, so a gesture implemented as
//! `window.open` would be swallowed by that stub on the default configuration (ad-blocking
//! on, page not allowlisted) and would appear to do nothing. `link_gestures.js` reads the
//! native `window.open` at document-start and keeps it in its own closure; both composition
//! paths therefore prepend this layer ahead of the ad-block layer. The guard is never
//! weakened — it still wraps `window.open` for scripted popups, and only the trusted-input
//! branch inside the gesture layer calls past it.
//!
//! ## Why `isTrusted` is the whole security argument
//!
//! Because the layer lives in the page's world, page script could in principle dispatch its
//! own click events to mint tabs. It cannot: every branch requires `event.isTrusted`, which
//! the engine sets for real input and leaves `false` for `dispatchEvent`. So this adds no
//! page-reachable capability while a `window.open` the page issues itself still meets the
//! guard.
//!
//! Injected on every frame (desktop uses `initialization_script_for_all_frames`), which
//! means a link inside an embedded frame honours the gesture too. That is intentional: the
//! `on_new_window` gate is per-request, so it still applies.
//!
//! There is no unit test for the JS here — it is exercised in the renderer suite by
//! `src/lib/linkGestures.test.ts`, which executes these exact shipped bytes in true global
//! scope (the same technique as `findShim.test.ts` / `farbleShim.test.ts`), because
//! `isTrusted` cannot be synthesised from Node.

/// The shipped gesture layer. Exposed as a function (not a bare `pub const`) so the
/// injection sites read as behaviour rather than as a string constant.
pub fn script() -> &'static str {
    include_str!("link_gestures.js")
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The layer must be present even when ad-blocking is off: a gesture is a user
    /// affordance, and it must not disappear because the user turned ad-blocking off for a
    /// site (or globally). So this is not routed through `adblock_layer`'s `block` flag.
    #[test]
    fn the_layer_is_never_empty() {
        assert!(!script().trim().is_empty());
    }

    /// The property that makes the gesture work at all on the default configuration: it
    /// reads `window.open` into a closure variable. Without that read, the only `open` it
    /// could call is the pop-under guard's stub, which refuses the cross-origin open that a
    /// Ctrl+click is.
    #[test]
    fn it_captures_the_native_open_before_the_guard_can_replace_it() {
        let js = script();
        assert!(
            js.contains("var nativeOpen = window.open;"),
            "the layer must read the native window.open at document-start; the pop-under \
             guard replaces it and would otherwise swallow every Ctrl+click"
        );
        // And it must NOT reinstall it — reinstalling would leave the page holding our
        // wrapper instead of the guard, defeating the pop-under defence.
        assert!(
            !js.contains("window.open ="),
            "the layer must never reassign window.open: the pop-under guard's stub has to \
             stay in place for scripted popups"
        );
    }

    /// The forged-event defence. A page cannot set `isTrusted`, so this check is what keeps
    /// the layer from being a page-callable tab factory.
    #[test]
    fn every_gesture_requires_a_trusted_event() {
        let js = script();
        assert!(
            js.contains("if (!e.isTrusted) return;"),
            "the gesture handler must bail on an untrusted event"
        );
    }

    /// Both gestures' event types are bound. `click` alone misses middle-click entirely —
    /// the engine fires `auxclick` with `button === 1` for it, never `click` — so a
    /// click-only binding silently loses one of the three advertised gestures.
    #[test]
    fn both_click_and_middle_click_are_bound_on_the_capture_phase() {
        let js = script();
        assert!(
            js.contains("document.addEventListener('click', onGesture, true);"),
            "primary-button gestures need a capture-phase click listener"
        );
        assert!(
            js.contains("document.addEventListener('auxclick', onGesture, true);"),
            "middle-click needs a capture-phase auxclick listener; it never fires `click`"
        );
    }

    /// Only web URLs become background tabs. `mailto:`/`tel:`/`javascript:` must fall
    /// through to the engine, and the scheme is resolved against the document so a relative
    /// href is judged by its real scheme.
    #[test]
    fn non_web_schemes_are_left_to_the_engine() {
        let js = script();
        assert!(
            js.contains("if (scheme !== 'http:' && scheme !== 'https:') return;"),
            "a non-http(s) target must not be turned into a background tab"
        );
        assert!(
            js.contains("new URL(url, window.location.href)"),
            "the scheme must be resolved against the document, not read off a relative href"
        );
    }

    /// The gesture must request the new tab and NOTHING ELSE — no fallback that navigates
    /// this tab when `window.open` returns nothing.
    ///
    /// This is the regression that shipped: the layer used to read `window.open`'s return
    /// value and, on a null result, assign `location.href`. But the return value is null on
    /// the SUCCESSFUL path for two independent reasons — `noopener` in the features string
    /// makes it null by spec, and `nav::on_new_window` denies the popup (opening the tab
    /// itself) so no `WindowProxy` is ever returned. So the fallback fired on every click:
    /// a new tab opened AND the page you were reading was replaced.
    ///
    /// `preventDefault()` already cancels the navigation, so a refusal must stay a no-op —
    /// refusing to open a link beats opening it twice.
    #[test]
    fn the_gesture_never_navigates_this_tab_itself() {
        let js = script();
        // Scoped to ASSIGNMENT (`location.href =`), not the bare property name: the layer
        // legitimately READS `window.location.href` as the base for resolving a relative
        // href. An earlier version of this assertion banned the bare name and would have
        // failed on that correct read — which is the doc's own point about asserting the
        // observable rather than the mechanism.
        assert!(
            !js.contains("location.href ="),
            "the layer must never ASSIGN location.href: a null window.open result is the \\
             SUCCESS case here, so a location fallback fires on every modifier-click and \\
             replaces the page behind the new tab"
        );
        // And it must not navigate by any other spelling of the same move.
        assert!(
            !js.contains("location.assign(") && !js.contains("location.replace("),
            "location.assign/replace would navigate this tab the same way an assignment does"
        );
        // And it must not branch on the open's return value at all.
        assert!(
            !js.contains("if (!opened)"),
            "the layer must not treat a null window.open result as a refusal — see the doc"
        );
        // The request itself is unconditional: one call, no success check.
        assert!(
            js.contains("nativeOpen.call(window, url, '_blank', 'noopener');"),
            "the new tab is requested unconditionally"
        );
    }

    /// The href is read through the `href` IDL attribute, so a relative href or a
    /// `<base href>` resolves to the URL the engine would have navigated to. Handing the
    /// raw attribute value to `window.open` would resolve it against the wrong base.
    #[test]
    fn the_link_target_is_resolved_through_the_dom() {
        let js = script();
        assert!(
            js.contains("if (node.tagName === 'A' && node.hasAttribute('href')) return node.href;"),
            "walk to the nearest anchor with an href and use its resolved href"
        );
    }

    /// Idempotence. Document-start scripts can be registered more than once for a document
    /// (and the renderer re-injects on some paths); a second binding would open two tabs per
    /// click. The marker must be non-enumerable so it is not enumerable page-visible state,
    /// and non-writable so a page cannot clear it to force a double bind.
    #[test]
    fn reinjection_is_a_no_op() {
        let js = script();
        assert!(js.contains("if (window[MARK]) return;"));
        assert!(js.contains("configurable: false,"));
        assert!(js.contains("writable: false,"));
        assert!(js.contains("enumerable: false,"));
    }

    /// The native open reference must stay in the closure. A top-level `var` in this IIFE
    /// would land on the page's `window` and become a cross-site handle (the same reason
    /// `farble` keeps its seed inside the closure).
    #[test]
    fn no_top_level_var_can_leak_the_captured_open() {
        // The capture is inside the IIFE, and the only thing the IIFE publishes is MARK.
        assert_eq!(
            script().matches("var nativeOpen = window.open;").count(),
            1,
            "exactly one capture, inside the closure"
        );
    }
}
