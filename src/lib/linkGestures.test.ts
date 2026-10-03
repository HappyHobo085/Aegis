// Runtime test of the SHIPPED link-gesture layer (src-tauri/src/link_gestures.js). The Rust
// side `include_str!`s these exact bytes and injects them at document-start via
// `initialization_script_for_all_frames` (desktop) / `WebViewCompat.addDocumentStartJavaScript`
// (Android), i.e. into the CONTENT webview's MAIN world — the page's own JS world. So
// executing the real bytes here is the only way to test what a page can do to the layer
// before it runs. Mirrors findShim.test.ts / farbleShim.test.ts; runs in the vitest jsdom
// project.
//
// The layer's whole observable is a TRUSTED pointer event, and `Event.isTrusted` cannot be
// produced by jsdom — every event jsdom synthesises is untrusted, which is exactly the
// property the layer defends against. So the handlers are captured off the real
// `document.addEventListener` calls the layer makes and invoked directly with a hand-built
// event object. That is honest about what is and is not proven here:
//
//   - PROVEN: the wiring (which events, capture phase, `document`), the `isTrusted` BRANCH,
//     href resolution, the scheme filter, `preventDefault`, and that a refused popup
//     degrades to navigating this tab.
//   - NOT PROVEN HERE (a browser platform guarantee, not a jsdom one): that page script
//     cannot set `isTrusted` true. A real engine sets it for real input and leaves it false
//     for `dispatchEvent`, which is why the layer's forgery defence holds.
//
// The layer is installed ONCE for the whole file, because it stamps a non-configurable
// idempotence marker on `window` — exactly as it must in a browser, where the injection also
// happens once per document. That also makes the capture of `window.open` faithful: the
// layer reads whatever `window.open` is at document-start and never touches it again.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const read = (n: string) => readFileSync(join(process.cwd(), 'src-tauri/src', n), 'utf8');
const SHIM = read('link_gestures.js');

// The REAL pop-under guard, lifted out of adblock_inject.rs rather than re-typed here — a
// hand-copied guard would let this file pass against a guard that no longer ships. It is what
// the layer has to survive, so it has to be the shipped bytes.
function popUpGuard(): string {
  const src = read('adblock_inject.rs');
  const m = src.match(/const POPUP_GUARD: &str = r#"([\s\S]*?)"#;/);
  if (!m) throw new Error('POPUP_GUARD not found in adblock_inject.rs');
  return m[1];
}

type Handler = (e: unknown) => void;
const handlers = new Map<string, Handler>();
const registrations: Array<{ type: string; capture: boolean }> = [];

/** Every `window.open` call the layer (or the guard) routed to the "native" function. */
const opened: Array<{ url: string; name: string; features: unknown }> = [];

/** What the captured native `window.open` returns; swapped per test to model a refusal. */
const nativeResult: { result: () => unknown } = { result: () => ({ closed: false }) };

const NATIVE_OPEN = function nativeOpen(url: unknown, name: unknown, features: unknown) {
  opened.push({ url: String(url), name: String(name), features });
  return nativeResult.result();
};

const PAGE = 'http://localhost:3000/page.html';
const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
const originalOpen = window.open;

beforeAll(() => {
  // A deterministic base URL and a stubbed navigation target: assigning `location.href` in
  // jsdom raises "Not implemented: navigation", which would drown the refused-popup
  // assertion in noise. The real `location` descriptor is restored in afterAll.
  Object.defineProperty(globalThis, 'location', {
    value: { href: PAGE },
    writable: true,
    configurable: true,
  });
  // Installed BEFORE the layer, because the layer's whole design is to capture whatever
  // `window.open` is at document-start.
  window.open = NATIVE_OPEN as unknown as typeof window.open;

  const realAdd = document.addEventListener.bind(document);
  document.addEventListener = ((type: string, fn: Handler, capture?: boolean) => {
    registrations.push({ type, capture: capture === true });
    handlers.set(type, fn);
    realAdd(type, fn as EventListener, capture);
  }) as typeof document.addEventListener;

  // Indirect eval => TRUE global scope, the same trick the find/farble shim tests use.
  (0, eval)(SHIM);
});

afterAll(() => {
  window.open = originalOpen;
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
});

beforeEach(() => {
  opened.length = 0;
  nativeResult.result = () => ({ closed: false });
  // The layer never re-reads window.open, so restoring it here only makes the file
  // order-independent for the guard test, which installs the real guard over it.
  window.open = NATIVE_OPEN as unknown as typeof window.open;
  document.head.innerHTML = '';
  document.body.innerHTML = '';
  (globalThis as { location: { href: string } }).location.href = PAGE;
});

/** An anchor in the document, with an optional `href`/`target`/base context. */
function anchor(href: string, target?: string): HTMLAnchorElement {
  const a = document.createElement('a');
  a.setAttribute('href', href);
  if (target) a.setAttribute('target', target);
  const span = document.createElement('span');
  span.textContent = 'link text';
  a.appendChild(span);
  document.body.appendChild(a);
  return a;
}

type Gesture = {
  type?: 'click' | 'auxclick';
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  button?: number;
  trusted?: boolean;
  prevented?: boolean;
  target?: EventTarget | null;
};

/**
 * Fire one of the layer's listeners with a hand-built event.
 * Returns whether the layer CALLED `preventDefault` — the observable that the original
 * navigation was cancelled — which is distinct from whether the event arrived already
 * handled (`gesture.prevented`), since that is an input, not an outcome.
 */
function fire(g: Gesture): boolean {
  let preventedCall = false;
  const e = {
    type: g.type ?? 'click',
    isTrusted: g.trusted ?? true,
    defaultPrevented: g.prevented ?? false,
    target: g.target ?? document.body,
    button: g.button ?? 0,
    ctrlKey: g.ctrl ?? false,
    metaKey: g.meta ?? false,
    shiftKey: g.shift ?? false,
    preventDefault() {
      preventedCall = true;
    },
  };
  handlers.get(e.type)!(e);
  return preventedCall;
}

const targets = () => opened.map((o) => o.url);

describe('link_gestures.js binds both gestures on the capture phase of `document`', () => {
  it('registers exactly a capture-phase click and auxclick listener on document', () => {
    expect(registrations).toEqual([
      { type: 'click', capture: true },
      { type: 'auxclick', capture: true },
    ]);
  });

  it('leaves window.open alone — the pop-under guard must keep owning it', () => {
    // If the layer reassigned window.open, it would sit in front of the guard and the guard
    // would never see a scripted popup again.
    expect(window.open).toBe(NATIVE_OPEN);
  });

  it('publishes nothing enumerable on the page window', () => {
    // The captured native open must stay in the closure; a page-visible handle would be a
    // cross-site super-cookie (the reason farble keeps its seed inside its closure).
    expect(Object.keys(window)).not.toContain('__aegis_link_gestures__');
    const marker = Object.getOwnPropertyDescriptor(window, '__aegis_link_gestures__');
    expect(marker?.enumerable).toBe(false);
    // And a page cannot flip the marker to force a second, double-binding injection.
    expect(marker?.writable).toBe(false);
    expect(marker?.configurable).toBe(false);
  });
});

describe('a modifier-click on a link opens a new BACKGROUND tab instead of navigating', () => {
  it('Ctrl+click opens the link and cancels the navigation', () => {
    const a = anchor('https://other.example/page');
    const prevented = fire({ ctrl: true, target: a });
    expect(targets()).toEqual(['https://other.example/page']);
    expect(prevented).toBe(true);
    // Background tab, not a named window, and no opener handle for the new page.
    expect(opened[0].name).toBe('_blank');
    expect(opened[0].features).toBe('noopener');
  });

  it('Cmd+click (macOS) behaves identically to Ctrl+click', () => {
    const a = anchor('https://other.example/page');
    fire({ meta: true, target: a });
    expect(targets()).toEqual(['https://other.example/page']);
  });

  it('Shift+click opens a new tab (Aegis is single-window, so there is no window to make)', () => {
    const a = anchor('https://other.example/page');
    expect(fire({ shift: true, target: a })).toBe(true);
    expect(targets()).toEqual(['https://other.example/page']);
  });

  it('middle-click opens the link, and reaches that only through auxclick', () => {
    const a = anchor('https://other.example/page');
    expect(fire({ type: 'auxclick', button: 1, target: a })).toBe(true);
    expect(targets()).toEqual(['https://other.example/page']);
  });

  it('finds the anchor when the click lands on a child element inside it', () => {
    const a = anchor('https://other.example/page');
    const child = a.firstElementChild!;
    fire({ ctrl: true, target: child });
    expect(targets()).toEqual(['https://other.example/page']);
  });

  it('resolves a relative href against the page, not against the raw attribute', () => {
    const a = anchor('/relative/path?q=1');
    fire({ ctrl: true, target: a });
    expect(targets()).toEqual(['http://localhost:3000/relative/path?q=1']);
  });

  it('honours a <base href> rather than resolving against the document URL', () => {
    const base = document.createElement('base');
    base.setAttribute('href', 'https://cdn.example/dir/');
    document.head.appendChild(base);
    const a = anchor('sibling');
    fire({ ctrl: true, target: a });
    expect(targets()).toEqual(['https://cdn.example/dir/sibling']);
  });

  it('works for a link that already targets _blank, without opening twice', () => {
    const a = anchor('https://other.example/page', '_blank');
    fire({ ctrl: true, target: a });
    expect(opened).toHaveLength(1);
  });
});

describe('everything that must NOT become a background tab', () => {
  it('an ordinary unmodified click is left entirely to the engine', () => {
    const a = anchor('https://other.example/page');
    expect(fire({ target: a })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('a click on an ordinary middle button event (click, not auxclick) does not open', () => {
    // The engine never fires `click` for a middle button — which is exactly why the layer
    // must bind auxclick. If a future refactor bound only `click`, this still passes while
    // middle-click silently stops working, so the assertion is about the auxclick binding.
    const a = anchor('https://other.example/page');
    expect(fire({ type: 'click', button: 1, target: a })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('a page-forged (untrusted) Ctrl+click opens nothing', () => {
    // The security property: `isTrusted` is set by the engine and cannot be set by page
    // script, so a site cannot mint tabs out of its own dispatchEvent calls.
    const a = anchor('https://other.example/page');
    expect(fire({ ctrl: true, trusted: false, target: a })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('an already-handled event is left alone', () => {
    const a = anchor('https://other.example/page');
    expect(fire({ ctrl: true, prevented: true, target: a })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('a modifier-click on something that is not a link opens nothing', () => {
    const div = document.createElement('div');
    document.body.appendChild(div);
    expect(fire({ ctrl: true, target: div })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it('an anchor with no href is not a link', () => {
    const a = document.createElement('a');
    document.body.appendChild(a);
    expect(fire({ ctrl: true, target: a })).toBe(false);
    expect(opened).toHaveLength(0);
  });

  it.each(['mailto:a@b.example', 'tel:+27123456789', 'javascript:void(0)', 'sms:+1'])(
    'a %s link is handed to the engine, not turned into a tab',
    (href) => {
      const a = anchor(href);
      expect(fire({ ctrl: true, target: a })).toBe(false);
      expect(opened).toHaveLength(0);
    },
  );
});

describe('a refused popup degrades to navigating this tab, never to nothing', () => {
  // The layer captured NATIVE_OPEN at document-start and holds that reference forever, so
  // re-assigning `window.open` in a test would NOT change what the layer calls — a test that
  // did that would be vacuous. The captured reference is the SAME function object here, so
  // its return value is what gets varied: `refuseNative` makes the engine refuse the popup,
  // which is exactly the case the fallback exists for.
  it('navigates this tab when the engine blocks the new window', () => {
    const a = anchor('https://other.example/page');
    nativeResult.result = () => null;
    expect(fire({ ctrl: true, target: a })).toBe(true);
    // It still tried to open a background tab first...
    expect(targets()).toEqual(['https://other.example/page']);
    // ...and the refusal is not a silent no-op: this tab goes to the target.
    expect((globalThis as { location: { href: string } }).location.href).toBe(
      'https://other.example/page',
    );
  });

  it('leaves this tab alone when the popup succeeds', () => {
    const a = anchor('https://other.example/page');
    nativeResult.result = () => ({ closed: false });
    expect(fire({ ctrl: true, target: a })).toBe(true);
    expect(targets()).toEqual(['https://other.example/page']);
    // No fallback navigation, so the page you were reading is not replaced behind the new tab.
    expect((globalThis as { location: { href: string } }).location.href).toBe(PAGE);
  });
});

describe('the pop-under guard stays armed for script while gestures keep working', () => {
  it('a Ctrl+click still opens when the real guard is installed after the layer', () => {
    const guard = popUpGuard();
    // Composition order in Rust: gesture layer FIRST, then the guard — so reproduce exactly
    // that, and prove the layer did not capture the guard's stub.
    window.open = NATIVE_OPEN as unknown as typeof window.open;
    (0, eval)(guard);
    expect(typeof window.open).toBe('function');
    expect(window.open).not.toBe(NATIVE_OPEN);

    const a = anchor('https://other.example/page');
    expect(fire({ ctrl: true, target: a })).toBe(true);
    expect(targets()).toEqual(['https://other.example/page']);

    // The guard is still armed: a SCRIPTED cross-origin popup is refused without ever
    // reaching the native open. This is the assertion that would fail if the layer had
    // replaced window.open instead of reading it.
    const stub = window.open('https://ad-network.example/burial', '_blank');
    expect((stub as unknown as { __aegisBlocked?: boolean })?.__aegisBlocked).toBe(true);
    expect(opened).toHaveLength(1);
  });
});
