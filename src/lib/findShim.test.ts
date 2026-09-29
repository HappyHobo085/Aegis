// Runtime test of the SHIPPED find-in-page shim JS (src-tauri/src/find_shim.js). The Rust
// side include_str!'s this exact file and injects it with `WKWebView::evaluateJavaScript`
// — that is, into the content webview's MAIN world, the page's own JS world. So
// `window` in here is a page's `window`, and executing the real bytes here is the only
// way to test what a page can do to the shim before it runs.
//
// Mirrors webrtcShim.test.ts / farbleShim.test.ts. Runs in the vitest jsdom project.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The vitest suite runs from the repo root, so anchor on cwd (import.meta.url resolves
// root-relative under vitest's transform).
const read = (name: string) => readFileSync(join(process.cwd(), 'src-tauri/src', name), 'utf8');
const SHIM = read('find_shim.js');

/** The ownership marker the shim stamps on the function it installs. */
const OWNER = '__aegis_owned__';

/** The sentinel shape `find_mac.rs::parse_sentinel` reads. */
const SENTINEL = /^AEGISFIND:(\d+):(-?\d+)$/;

/**
 * Evaluate the shim in TRUE GLOBAL scope.
 *
 * The shim is an IIFE that reads and writes `window`, and a page's script (the thing
 * we are simulating a collision with) also runs in global scope — so `eval` inside a
 * function body would not reproduce the environment. An indirect eval is the standard
 * way to get "global scope" rather than "this module's scope", and it is the same
 * trick the farble/webrtc shim tests use.
 */
function installShim(): void {
  (0, eval)(SHIM);
}

type AnyFn = ((...a: unknown[]) => unknown) & Record<string, unknown>;

const w = globalThis as unknown as { __aegisFind?: AnyFn };

describe("find_shim.js runs in the page's own world, so it must own its global", () => {
  beforeEach(() => {
    delete w.__aegisFind;
    document.body.innerHTML = '';
    document.title = 'page';
  });
  afterEach(() => {
    delete w.__aegisFind;
    vi.restoreAllMocks();
  });

  it('installs a callable __aegisFind with a real sentinel', () => {
    document.body.innerHTML = '<p>the quick brown fox</p>';
    installShim();

    expect(typeof w.__aegisFind).toBe('function');
    const s = w.__aegisFind?.('quick', false, 'next', false);
    expect(String(s)).toMatch(SENTINEL);
    // One occurrence of "quick" in the body above.
    expect(String(s)).toBe('AEGISFIND:1:0');
  });

  it('overwrites a page that squatted on __aegisFind before the shim ran', () => {
    // The attack: a page defines the global first, so the shim's idempotence guard
    // used to bail and the page's function received the user's query verbatim.
    const stolen: string[] = [];
    w.__aegisFind = ((query: unknown) => {
      stolen.push(String(query));
      return 'AEGISFIND:999:999';
    }) as AnyFn;

    document.body.innerHTML = '<p>findable text</p>';
    installShim();

    // The shim took the global back…
    expect(String(w.__aegisFind?.('findable', false, 'next', false))).toBe('AEGISFIND:1:0');
    // …and the squatter was never asked anything.
    expect(stolen).toEqual([]);
  });

  it('still short-circuits on its OWN re-injection', () => {
    installShim();
    const first = w.__aegisFind;
    expect(first?.[OWNER]).toBe(true);

    // Re-injection is a no-op: the same function object is still installed, so the
    // per-closure state (matches, activeIndex) survives a second evaluate. Without
    // this the guard would be doing nothing at all.
    installShim();
    expect(w.__aegisFind).toBe(first);
  });

  it('is unaffected by a page that sets a non-function global', () => {
    w.__aegisFind = 'not a function' as unknown as AnyFn;
    installShim();
    expect(typeof w.__aegisFind).toBe('function');
  });

  it("fails open to AEGISFIND:0:0 on an empty query, per the shim's contract", () => {
    installShim();
    expect(String(w.__aegisFind?.('', false, 'next', false))).toBe('AEGISFIND:0:0');
  });
});
