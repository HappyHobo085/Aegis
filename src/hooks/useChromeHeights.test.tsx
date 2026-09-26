// src/hooks/useChromeHeights.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, renderHook, screen } from '@testing-library/react';
import { useRef } from 'react';
import { useChromeHeights } from './useChromeHeights';
import { FAVBAR_H, FIND_BAR_H, TABSTRIP_H, TOOLBAR_H, WORKSPACE_BAR_H } from '../lib/layout';

/**
 * The hook measures chrome element heights from the DOM and derives `topInset`, which is what
 * pushes the content webview down so the chrome never overlaps the page.
 *
 * The behaviour worth pinning is the *presence signature* gate. A one-shot "measured once" latch
 * used to mean a chrome element that appeared (or was hidden) after mount was never re-measured,
 * so `topInset` kept reserving space for a bar that was gone — or reserved none for a bar that
 * had appeared, letting it overlap the page. That is exactly the bug that hit the favourites-bar
 * toggle, which is why these tests exist.
 *
 * jsdom has no layout engine, so `getBoundingClientRect()` returns zeros for everything. Each
 * test therefore stubs the rect per element class, and uses a present-but-zero-height case to
 * cover the "element present but not yet painted" fallback.
 */
const SELECTOR_FOR: Record<string, string> = {
  tabstrip: '.tabstrip',
  toolbar: '.toolbar',
  favbar: '.favorites-bar',
  findbar: '.find-bar',
  workspacebar: '.workspace-switcher',
};

/**
 * Height each class should report. A class absent from `present` is not rendered at all; a
 * rendered class that is NOT listed here reports height 0, which is how the "present but not
 * yet painted" fallback is exercised.
 */
const HEIGHTS: Record<string, number> = {
  tabstrip: 40,
  toolbar: 56,
  'favorites-bar': 36,
  'find-bar': 40,
  'workspace-switcher': 32,
};

let container: HTMLDivElement;

function makeContainer(present: string[]): HTMLDivElement {
  const el = document.createElement('div');
  for (const cls of present) {
    const child = document.createElement('div');
    child.className = cls;
    el.appendChild(child);
  }
  return el;
}

beforeEach(() => {
  container = makeContainer(['tabstrip', 'toolbar', 'favorites-bar']);
  // Give every element a class-specific height; anything not listed reports 0 (unpainted).
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const cls = HEIGHTS[this.className];
    const height = cls ?? 0;
    return {
      x: 0,
      y: 0,
      top: 0,
      left: 0,
      right: 0,
      bottom: height,
      width: 0,
      height,
      toJSON: () => ({}),
    } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  container.remove();
});

function renderWith(el: HTMLDivElement) {
  return renderHook(() => useChromeHeights({ current: el }));
}

/**
 * The App.tsx call shape: a `useRef` created ONCE, so the object handed to the hook is
 * referentially STABLE across renders.
 *
 * BUG(F1): the hook keyed its measuring effect on `[containerRef]`. With this shape that
 * dependency never changes, so the effect ran exactly once for the lifetime of the app and
 * every presence change after mount was ignored. `renderWith` above passes a FRESH object
 * literal each render, which accidentally made the dependency unstable and hid the bug —
 * so the re-measure assertions below are written against this stable-ref helper.
 */
function renderWithStableRef(el: HTMLDivElement) {
  const ref: { current: HTMLElement | null } = { current: el };
  return renderHook(() => useChromeHeights(ref));
}

describe('useChromeHeights', () => {
  it('reports 0 for every chrome element when none are in the DOM', () => {
    const { result } = renderWith(makeContainer([]));
    // An absent element takes no space, so it must NOT fall back to the layout constant —
    // reserving space for a bar that is not there is the bug this hook had.
    expect(result.current.tabStripH).toBe(0);
    expect(result.current.toolbarH).toBe(0);
    expect(result.current.favBarH).toBe(0);
    expect(result.current.findBarH).toBe(0);
    expect(result.current.workspaceBarH).toBe(0);
    expect(result.current.topInset).toBe(0);
  });

  it('measures the elements that are present and sums them into topInset', () => {
    const { result } = renderWith(container);
    expect(result.current.tabStripH).toBe(40);
    expect(result.current.toolbarH).toBe(56);
    expect(result.current.favBarH).toBe(36);
    // Not rendered, so 0 rather than the constant.
    expect(result.current.findBarH).toBe(0);
    expect(result.current.workspaceBarH).toBe(0);
    expect(result.current.topInset).toBe(40 + 56 + 36);
  });

  it('falls back to the layout constant when an element is present but reports height 0', () => {
    // `.find-bar` has no entry in HEIGHTS, so the stub returns 0 for it — the
    // "present but not yet painted" case.
    container = makeContainer(['tabstrip', 'toolbar', 'favorites-bar', 'find-bar']);
    const { result } = renderWith(container);
    expect(result.current.findBarH).toBe(FIND_BAR_H);
    expect(result.current.topInset).toBe(40 + 56 + 36 + FIND_BAR_H);
  });

  it('RE-MEASURES when an element appears after mount (the presence-signature gate)', () => {
    // Mount with the find bar and workspace switcher absent.
    const { result, rerender } = renderWithStableRef(container);
    expect(result.current.findBarH).toBe(0);
    expect(result.current.topInset).toBe(40 + 56 + 36);

    // Now they appear. A one-shot "measured once" latch would leave these at 0 and let the
    // overlapping chrome sit on top of the page.
    for (const cls of ['find-bar', 'workspace-switcher']) {
      const child = document.createElement('div');
      child.className = cls;
      container.appendChild(child);
    }
    rerender();

    expect(result.current.findBarH).toBe(FIND_BAR_H);
    expect(result.current.workspaceBarH).toBe(WORKSPACE_BAR_H);
    expect(result.current.topInset).toBe(40 + 56 + 36 + FIND_BAR_H + WORKSPACE_BAR_H);
  });

  it('RE-MEASURES when the favourites bar is hidden again', () => {
    // Stable ref = the App.tsx shape. This is the "Toggle favorites bar" round trip: the
    // bar is unmounted, and `topInset` used to keep reserving its 36px until a restart.
    const { result, rerender } = renderWithStableRef(container);
    expect(result.current.favBarH).toBe(FAVBAR_H);
    expect(result.current.topInset).toBe(40 + 56 + 36);

    container.querySelector(SELECTOR_FOR.favbar)?.remove();
    rerender();

    // Space must be released, or the content sits 36px too low.
    expect(result.current.favBarH).toBe(0);
    expect(result.current.topInset).toBe(40 + 56);
  });

  it('RE-MEASURES a presence change across a real component remount of the bar (stable ref)', () => {
    // Belt-and-braces over the two cases above: drive presence the way App does, by mounting
    // and unmounting a child component, so the toggling element is genuinely a different node
    // each time rather than a hand-mutated DOM.
    function Chrome({ showFavBar }: { showFavBar: boolean }) {
      const host = useRef<HTMLDivElement>(null);
      const heights = useChromeHeights(host);
      return (
        <div ref={host}>
          <div className="tabstrip" />
          <div className="toolbar" />
          {showFavBar && <div className="favorites-bar" />}
          <output data-testid="inset">{heights.topInset}</output>
        </div>
      );
    }
    const { rerender } = render(<Chrome showFavBar />);
    const inset = () => Number(screen.getByTestId('inset').textContent);
    expect(inset()).toBe(40 + 56 + 36);

    rerender(<Chrome showFavBar={false} />);
    expect(inset()).toBe(40 + 56);

    rerender(<Chrome showFavBar />);
    expect(inset()).toBe(40 + 56 + 36);
  });

  it('does not re-measure when the presence signature is unchanged', () => {
    // Heights are CSS-fixed, so an unchanged signature must be a no-op: re-running the
    // measurement would recompute identical numbers and churn `setHeights` on every render.
    const spy = vi.spyOn(Element.prototype, 'getBoundingClientRect');
    const { rerender, result } = renderWithStableRef(container);
    const firstInset = result.current.topInset;
    const callsAfterMount = spy.mock.calls.length;

    rerender();
    rerender();

    expect(spy.mock.calls.length).toBe(callsAfterMount);
    expect(result.current.topInset).toBe(firstInset);
  });

  it('starts from a fallback inset that already matches the measured formula (F33)', () => {
    // BUG(F33): the pre-measure fallback added FIND_BAR_H while the measured `topInset`
    // adds `findBarH` (0 when `.find-bar` is absent), so the FIRST `view.setContentInset`
    // always carried 40px too much. The two formulas must be the same set of terms.
    const { result, unmount } = renderHook(() => useChromeHeights({ current: null }));
    expect(result.current.topInset).toBe(TABSTRIP_H + TOOLBAR_H + FAVBAR_H + WORKSPACE_BAR_H);
    // The always-present individual heights still fall back to their constants.
    expect(result.current.findBarH).toBe(FIND_BAR_H);
    unmount();
  });
});
