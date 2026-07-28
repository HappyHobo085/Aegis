// Aegis find-in-page JS shim (macOS).
//
// Injected into the content WKWebView at tab spawn via `evaluateJavaScript`.
// Provides real match count, highlight-all, and active match index — filling
// the gap left by `WKFindResult` which only exposes a boolean `matchFound`.
//
// The shim defines `window.__aegisFind(query, caseSensitive, direction, close)`
// which returns a sentinel string `AEGISFIND:{matchCount}:{activeMatchIndex}`
// and also sets `document.title` to the sentinel (restored after a brief delay
// for any title observers). FAIL-OPEN: any internal error returns
// `AEGISFIND:0:0`.
//
// Injected via `include_str!` in find_mac.rs. Idempotent — re-injection is a
// no-op if `__aegisFind` already exists on `window`.
(function () {
  if (window.__aegisFind) return;

  var HIGHLIGHT_CLASS = '__aegis-find-hl';
  var ACTIVE_CLASS = '__aegis-find-active';
  var matches = [];
  var activeIndex = -1;

  function clearHighlights() {
    var els = document.querySelectorAll('.' + HIGHLIGHT_CLASS);
    for (var i = 0; i < els.length; i++) els[i].remove();
    matches = [];
    activeIndex = -1;
  }

  // Get the container that holds all highlight overlays. Created once, scrolls
  // with the page (absolute-positioned inside the body).
  var container = null;
  function getContainer() {
    if (!container || !container.parentNode) {
      container = document.createElement('div');
      container.style.cssText =
        'position:absolute;top:0;left:0;width:0;height:0;pointer-events:none;z-index:2147483646;';
      (document.body || document.documentElement).appendChild(container);
    }
    return container;
  }

  // Highlight a single Range. May produce multiple overlay rects (line-break).
  function highlightRange(range, isActive) {
    var rects = range.getClientRects();
    var c = getContainer();
    for (var i = 0; i < rects.length; i++) {
      var r = rects[i];
      if (r.width === 0 || r.height === 0) continue;
      var div = document.createElement('div');
      div.className = HIGHLIGHT_CLASS + (isActive ? ' ' + ACTIVE_CLASS : '');
      div.style.cssText =
        'position:absolute;pointer-events:none;' +
        'background:' +
        (isActive ? 'rgba(255,140,0,0.45)' : 'rgba(255,255,0,0.3)') +
        ';' +
        'border-radius:1px;' +
        'left:' +
        (r.left + window.pageXOffset) +
        'px;' +
        'top:' +
        (r.top + window.pageYOffset) +
        'px;' +
        'width:' +
        r.width +
        'px;' +
        'height:' +
        r.height +
        'px;';
      c.appendChild(div);
    }
  }

  // Walk visible text nodes via TreeWalker, collect ranges matching `query`.
  function findMatches(query, caseSensitive) {
    if (!query || !document.body) return [];
    var results = [];
    var tw = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_TEXT,
      null,
      false
    );
    var node;
    while ((node = tw.nextNode())) {
      var text = node.textContent;
      if (!text) continue;
      // Skip hidden parents.
      var par = node.parentElement;
      if (par) {
        var cs = window.getComputedStyle(par);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
      }
      var search = caseSensitive ? text : text.toLowerCase();
      var needle = caseSensitive ? query : query.toLowerCase();
      var start = 0;
      while (true) {
        var idx = search.indexOf(needle, start);
        if (idx === -1) break;
        results.push({ node: node, start: idx, end: idx + needle.length });
        start = idx + 1;
      }
    }
    return results;
  }

  function sentinel(count, idx) {
    return 'AEGISFIND:' + count + ':' + idx;
  }

  function emitSentinel(count, idx) {
    var s = sentinel(count, idx);
    var orig = document.title;
    document.title = s;
    setTimeout(function () {
      try {
        document.title = orig;
      } catch (_) {}
    }, 300);
    return s;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  window.__aegisFind = function (query, caseSensitive, direction, close) {
    try {
      if (close || !query) {
        clearHighlights();
        return emitSentinel(0, 0);
      }

      matches = findMatches(query, caseSensitive);
      var count = matches.length;

      clearHighlights();

      if (count === 0) return emitSentinel(0, 0);

      // Advance / retreat the active index.
      if (direction === 'forward') {
        activeIndex = (activeIndex + 1) % count;
      } else if (direction === 'backward') {
        activeIndex = (activeIndex - 1 + count) % count;
      } else {
        activeIndex = 0;
      }

      // Highlight every match.
      for (var i = 0; i < count; i++) {
        try {
          var range = document.createRange();
          range.setStart(matches[i].node, matches[i].start);
          range.setEnd(matches[i].node, matches[i].end);
          highlightRange(range, i === activeIndex);
        } catch (_) {}
      }

      // Scroll active match into view.
      try {
        var ar = document.createRange();
        ar.setStart(matches[activeIndex].node, matches[activeIndex].start);
        ar.setEnd(matches[activeIndex].node, matches[activeIndex].end);
        var rect = ar.getBoundingClientRect();
        if (rect.top < 0 || rect.bottom > window.innerHeight) {
          ar.scrollIntoView({ block: 'center', behavior: 'smooth' });
        }
      } catch (_) {}

      return emitSentinel(count, activeIndex);
    } catch (_) {
      return emitSentinel(0, 0);
    }
  };
})();
