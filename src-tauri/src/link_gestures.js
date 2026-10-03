// Aegis link gestures — Ctrl/Cmd+click, middle-click and Shift+click on a link open it in a
// new BACKGROUND tab instead of replacing the page you are reading.
//
// INJECTION ORDER IS LOAD-BEARING. This file must be concatenated BEFORE
// `adblock_inject::POPUP_GUARD` in both composition paths (desktop `compose`, Android
// `android_document_start_layer`). The guard replaces `window.open` to refuse cross-origin
// scripted popups (the ad pop-under defence), and a Ctrl+click to another site IS
// cross-origin — so a gesture implemented as `window.open` AFTER the guard is stubbed out
// and does nothing on exactly the default configuration (ad-blocking on). Reading the native
// open here, at document-start, before the guard wraps it, is what makes the gesture work
// while leaving the guard fully armed for script.
//
// This adds NO capability a page lacks: it calls the same native `window.open` the page
// could call, and the result lands on the same `on_new_window` / `onCreateWindow` handler,
// which applies the identical gates (`is_unwanted_popup`, `is_navigable`) a `target=_blank`
// click already passes through.
//
// The one thing a page must not get is a way to turn ITS OWN synthetic events into tabs, so
// every branch below requires `isTrusted`. That flag is set by the engine for real input
// and is `false` for `dispatchEvent`, which no page can forge — so this layer cannot be
// driven by page script, while the ordinary `window.open` path stays guarded.
//
// Nothing is exposed on `window` except a non-enumerable, non-writable idempotence marker:
// the native open reference stays in this closure (a top-level var would leak to the page's
// global and become a cross-site super-cookie handle — see `farble.standard.js`).
(function () {
  try {
    var MARK = '__aegis_link_gestures__';
    if (window[MARK]) return;
    // Captured BEFORE the pop-under guard replaces window.open. Deliberately NOT reinstalled:
    // the guard's stub must stay reachable for scripted popups, and only the trusted-gesture
    // branch below is allowed past it.
    var nativeOpen = window.open;
    if (typeof nativeOpen !== 'function') return;
    Object.defineProperty(window, MARK, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });

    // Nearest ancestor anchor that actually carries an href. Reads `node.href`, the
    // IDL-resolved absolute URL, so relative hrefs and <base href> resolve correctly instead
    // of being handed to the engine as page-relative junk.
    function hrefFor(node) {
      while (node && node.nodeType !== 1) node = node.parentNode;
      while (node) {
        if (node.tagName === 'A' && node.hasAttribute('href')) return node.href;
        node = node.parentNode;
      }
      return null;
    }

    function openInNewTab(url) {
      var opened = null;
      try {
        // 'noopener' because a modifier-click must not hand the new page a live
        // window.opener to navigate the opener with (window.open abuse).
        opened = nativeOpen.call(window, url, '_blank', 'noopener');
      } catch (e) {}
      if (!opened) {
        // The engine refused the popup. Navigate THIS tab instead, so a modifier-click is
        // never silently a no-op — degrade to today's behaviour rather than to nothing.
        try {
          window.location.href = url;
        } catch (e) {}
      }
    }

    function onGesture(e) {
      // Real input only. A page dispatching a synthetic MouseEvent gets isTrusted === false
      // and falls straight through to the engine's own default handling.
      if (!e.isTrusted) return;
      if (e.defaultPrevented) return;
      var url = hrefFor(e.target);
      if (!url) return;
      // mailto:, tel:, sms:, javascript: and blob: are not pages. Let the engine's own
      // handler deal with them; turning them into a background tab would hand a
      // non-navigable URL to `on_new_window`, which has to substitute about:blank.
      var scheme;
      try {
        scheme = new URL(url, window.location.href).protocol;
      } catch (err) {
        return;
      }
      if (scheme !== 'http:' && scheme !== 'https:') return;

      // Middle-click arrives as auxclick with button === 1. Clicking with any of the three
      // modifier keys means "this is not a navigation of the current page".
      // Shift+click means "new window" in Chrome and Firefox; Aegis is a single-window shell
      // with no window model, so the honest mapping is a new background tab, which is the
      // same target the other two produce.
      var middle = e.type === 'auxclick' && e.button === 1;
      if (!(middle || e.ctrlKey || e.metaKey || e.shiftKey)) return;

      e.preventDefault();
      openInNewTab(url);
    }

    // Capture phase on `document`: this runs before any listener the page registers, so a
    // page cannot stopPropagation its way out of a gesture it did not intend to allow. The
    // listeners are unreferenceable from the page, so they cannot be removed either.
    document.addEventListener('click', onGesture, true);
    document.addEventListener('auxclick', onGesture, true);
  } catch (e) {}
})();