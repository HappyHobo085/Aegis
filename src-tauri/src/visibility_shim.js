/* aegis-visibility-shim: keep content pages reporting themselves foreground-visible.
   An in-app overlay (Settings/Downloads/sidebar) hides the content webview, which would
   otherwise fire visibilitychange->hidden and arm malvertising pop-under/redirect scripts.
   Keeping the page "visible" defuses that trigger. Tradeoff: pages also believe they are
   visible when genuinely backgrounded (e.g. video won't auto-pause) — a conscious choice. */
(function () {
  try {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: function () { return 'visible'; },
    });
  } catch (e) {}
  try {
    Object.defineProperty(document, 'hidden', {
      configurable: true,
      get: function () { return false; },
    });
  } catch (e) {}
  try {
    Object.defineProperty(document, 'onvisibilitychange', {
      configurable: true,
      get: function () { return null; },
      set: function () {},
    });
  } catch (e) {}
  try {
    var realAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'visibilitychange' && (this === document || this === window)) return;
      return realAdd.call(this, type, listener, opts);
    };
  } catch (e) {}
})();
