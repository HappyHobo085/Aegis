// electron/main/pickerHelpers.ts

/**
 * Pure element-picker helpers. appendCosmeticRule builds `host##selector` and
 * appends it to the my-filters blob (newline-joined, no leading blank line).
 * computeSelector is the reference selector algorithm tested in jsdom; the SAME
 * algorithm is embedded (as a string) in PICKER_IIFE, which is what gets injected
 * into the sandboxed content WebContents via executeJavaScript(code, true).
 */

/** A picker selector is only safe to persist as a cosmetic rule if it is
 *  non-empty and contains no line terminators or control characters that
 *  could break out of the single `host##selector` line and inject extra
 *  filter rules. Legitimate selectors (#id, .class, tag:nth-of-type(n) > ...)
 *  contain none of these. The selector is returned by JS running in the
 *  attacker-controlled content page, so this is the main-side trust boundary. */
export function isSafeSelector(selector: string): boolean {
  if (!selector) return false;
  // C0 controls (incl. CR/LF/TAB), DEL, C1 controls, and Unicode line/paragraph separators.
  // eslint-disable-next-line no-control-regex
  return !/[\x00-\x1F\x7F-\x9F\u2028\u2029]/.test(selector);
}

/** Append `${host}##${selector}` to the existing my-filters blob. */
export function appendCosmeticRule(existing: string, host: string, selector: string): string {
  const rule = `${host}##${selector}`;
  if (existing.length === 0) return rule;
  return existing.endsWith('\n') ? `${existing}${rule}` : `${existing}\n${rule}`;
}

/** Index of `el` among its same-tag siblings (1-based, for :nth-of-type). */
function nthOfType(el: Element): number {
  let i = 1;
  let sib = el.previousElementSibling;
  while (sib) {
    if (sib.tagName === el.tagName) i += 1;
    sib = sib.previousElementSibling;
  }
  return i;
}

/**
 * Reference selector: prefer #id; else a class that is unique in the document;
 * else a parent-path of `tag:nth-of-type(n)` segments up to <body>.
 */
export function computeSelector(el: Element): string {
  if (el.id) return `#${el.id}`;
  for (const cls of Array.from(el.classList)) {
    if (el.ownerDocument.querySelectorAll(`.${cls}`).length === 1) return `.${cls}`;
  }
  const parts: string[] = [];
  let node: Element | null = el;
  while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
    if (node.id) {
      parts.unshift(`#${node.id}`);
      break;
    }
    const nth = nthOfType(node);
    parts.unshift(
      nth > 1
        ? `${node.tagName.toLowerCase()}:nth-of-type(${nth})`
        : node.tagName.toLowerCase(),
    );
    node = node.parentElement;
  }
  return parts.join(' > ');
}

/**
 * The injected picker. Overlays a hover highlight, resolves with a computed CSS
 * selector on the next click (capture phase, default prevented), or null on Esc.
 * It is a self-invoking expression (executeJavaScript evaluates an expression and
 * returns the awaited Promise). The selector algorithm mirrors computeSelector.
 */
export const PICKER_IIFE = `(() => new Promise((resolve) => {
  const prev = document.getElementById('__aegis_picker_overlay__');
  if (prev) prev.remove();
  const overlay = document.createElement('div');
  overlay.id = '__aegis_picker_overlay__';
  overlay.style.cssText = 'position:fixed;z-index:2147483647;pointer-events:none;border:2px solid #7c5cff;background:rgba(124,92,255,0.2);top:0;left:0;width:0;height:0;';
  document.documentElement.appendChild(overlay);
  function nthOfType(el) {
    let i = 1, sib = el.previousElementSibling;
    while (sib) { if (sib.tagName === el.tagName) i += 1; sib = sib.previousElementSibling; }
    return i;
  }
  function selectorFor(el) {
    if (el.id) return '#' + el.id;
    for (const cls of Array.from(el.classList)) {
      if (document.querySelectorAll('.' + cls).length === 1) return '.' + cls;
    }
    const parts = [];
    let node = el;
    while (node && node.tagName !== 'BODY' && node.tagName !== 'HTML') {
      if (node.id) { parts.unshift('#' + node.id); break; }
      const nth = nthOfType(node);
      parts.unshift(nth > 1 ? node.tagName.toLowerCase() + ':nth-of-type(' + nth + ')' : node.tagName.toLowerCase());
      node = node.parentElement;
    }
    return parts.join(' > ');
  }
  let current = null;
  function onMove(e) {
    current = e.target;
    if (!current || current === overlay) return;
    const r = current.getBoundingClientRect();
    overlay.style.top = r.top + 'px';
    overlay.style.left = r.left + 'px';
    overlay.style.width = r.width + 'px';
    overlay.style.height = r.height + 'px';
  }
  function cleanup() {
    document.removeEventListener('mousemove', onMove, true);
    document.removeEventListener('click', onClick, true);
    document.removeEventListener('keydown', onKey, true);
    overlay.remove();
    delete window.__aegisPickerArmed;
  }
  function onClick(e) {
    e.preventDefault();
    e.stopPropagation();
    const target = e.target;
    cleanup();
    resolve(target && target !== document.documentElement ? selectorFor(target) : null);
  }
  function onKey(e) {
    if (e.key === 'Escape') { cleanup(); resolve(null); }
  }
  document.addEventListener('mousemove', onMove, true);
  document.addEventListener('click', onClick, true);
  document.addEventListener('keydown', onKey, true);
  window.__aegisPickerArmed = true;
}))()`;
