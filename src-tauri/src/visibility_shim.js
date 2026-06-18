/* aegis-visibility-shim: keep content pages reporting themselves foreground-visible AND
   window-focused. Opening an in-app overlay/sidebar hides the content webview and moves focus
   to the chrome, firing visibilitychange->hidden and window blur/focus — which malvertising
   scripts use to fire pop-under/redirect bounces (e.g. to google.com). We keep the page
   believing it is visible and focused so those triggers never fire. Element-level focus/blur
   (form fields) is left intact. Tradeoff: pages also can't tell when the tab/window is
   genuinely backgrounded (e.g. a player won't auto-pause) — a conscious choice. */
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
    Object.defineProperty(document, 'hasFocus', {
      configurable: true,
      value: function () { return true; },
    });
  } catch (e) {}
  try {
    Object.defineProperty(window, 'onblur', {
      configurable: true,
      get: function () { return null; },
      set: function () {},
    });
  } catch (e) {}
  try {
    Object.defineProperty(window, 'onfocus', {
      configurable: true,
      get: function () { return null; },
      set: function () {},
    });
  } catch (e) {}
  // Drop the document/window-level events sites use to detect leaving: visibilitychange
  // (document) and window blur/focus. The `this === window` guard means element-level
  // focus/blur (form fields, inputs) is untouched — only window-scope focus is neutralized.
  try {
    var realAdd = EventTarget.prototype.addEventListener;
    EventTarget.prototype.addEventListener = function (type, listener, opts) {
      if (type === 'visibilitychange' && (this === document || this === window)) return;
      if ((type === 'blur' || type === 'focus') && this === window) return;
      return realAdd.call(this, type, listener, opts);
    };
  } catch (e) {}
  // `window` may expose its OWN addEventListener that bypasses EventTarget.prototype (jsdom,
  // and some engines), so wrap the window instance too — otherwise window blur/focus leak
  // through. Element/document listeners still go via the prototype wrapper above.
  try {
    var winAdd = window.addEventListener.bind(window);
    window.addEventListener = function (type, listener, opts) {
      if (type === 'blur' || type === 'focus' || type === 'visibilitychange') return;
      return winAdd(type, listener, opts);
    };
  } catch (e) {}
})();
