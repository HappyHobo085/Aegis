import { describe, it, expect } from 'vitest';
import { computeContentLayout, computeSplitLayout, clampResizeDelta } from './contentLayout';
import type { PaneRect } from './contentLayout';
import type { SplitLayout } from '../../shared/types';

/** A `SplitLayout` from a list of `[tabId, x, y, width, height]` fractions. */
const layout = (...panes: [number, number, number, number, number][]): SplitLayout => ({
  panes: panes.map(([tabId, x, y, width, height]) => ({ tabId, x, y, width, height })),
  focusedPaneId: panes[0]?.[0] ?? 0,
});

/** The pixel content area used by every `computeSplitLayout` case below. */
const AREA = { x: 0, y: 0, width: 1000, height: 800 };

describe('computeContentLayout', () => {
  it('nothing open → content shown, no inset', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: false, sidebar: false, width: 280 });
  });

  it('a full overlay rides the chrome over the content', () => {
    expect(
      computeContentLayout({
        fullOverlay: true,
        sidebar: false,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  it('the sidebar insets the content (overlay rides true, sidebar inset true)', () => {
    expect(
      computeContentLayout({
        fullOverlay: false,
        sidebar: true,
        sidebarWidth: 300,
      }),
    ).toEqual({ overlay: true, sidebar: true, width: 300 });
  });

  it('a full overlay suppresses the sidebar inset (overlay wins)', () => {
    expect(
      computeContentLayout({
        fullOverlay: true,
        sidebar: true,
        sidebarWidth: 280,
      }),
    ).toEqual({ overlay: true, sidebar: false, width: 280 });
  });

  // Chrome popovers (omnibox, site info, shield, zoom) are NOT part of this
  // derivation any more: they inset the content top by their own measured height
  // (useChromePopover) so the page stays visible behind them, instead of riding a
  // boolean that blanks the whole content webview.
  it('knows nothing about popovers — only fullOverlay and sidebar reach the content layout', () => {
    expect(
      Object.keys(
        computeContentLayout({
          fullOverlay: false,
          sidebar: false,
          sidebarWidth: 320,
        }),
      ).sort(),
    ).toEqual(['overlay', 'sidebar', 'width']);
  });
});

// --- computeSplitLayout ----------------------------------------------------
// Previously untested: the file's only spec covered `computeContentLayout`, so
// this whole pixel-geometry section ran at 0%. A bug here is a visible split-view
// layout bug — a handle in the wrong place, or a pane sized wrong.

describe('computeSplitLayout panes', () => {
  it('maps fractional coordinates onto the pixel content area', () => {
    // 0.5 * 1000 = 500 wide, 1 * 800 = 800 tall. `paneId` mirrors `SplitPane.tabId`
    // so the caller can map a rect back to its tab.
    const { panes } = computeSplitLayout(layout([1, 0, 0, 0.5, 1]), AREA);
    expect(panes).toEqual([{ x: 0, y: 0, width: 500, height: 800, paneId: 1 }]);
  });

  it('offsets by the content area origin, so panes sit below the chrome', () => {
    // App.tsx passes y = chrome.topInset, so a non-zero y must be honoured.
    const { panes } = computeSplitLayout(layout([3, 0, 0, 1, 1]), {
      x: 0,
      y: 64,
      width: 1000,
      height: 736,
    });
    expect(panes[0]).toMatchObject({ x: 0, y: 64, width: 1000, height: 736 });
  });

  it('rounds pane width and height to whole pixels (nearest, not truncated)', () => {
    // 0.5555 * 1000 = 555.5 -> 556 (Math.round rounds half up); a truncating
    // implementation would give 555 and the pane would not fill its share.
    const { panes } = computeSplitLayout(layout([1, 0, 0, 0.5555, 0.4444]), AREA);
    expect(panes[0].width).toBe(556);
    // 0.4444 * 800 = 355.52 -> 356, again nearest rather than truncated.
    expect(panes[0].height).toBe(356);
  });

  it('returns no panes for an empty layout', () => {
    expect(computeSplitLayout(layout(), AREA)).toEqual({ panes: [], handles: [] });
  });
});

describe('computeSplitLayout handles', () => {
  it('puts a VERTICAL handle on the shared edge of two side-by-side panes', () => {
    // Same y origin and height, and a's right edge lands on b's left edge, so the
    // separator runs top-to-bottom.
    const { handles } = computeSplitLayout(layout([1, 0, 0, 0.5, 1], [2, 0.5, 0, 0.5, 1]), AREA);
    expect(handles).toEqual([
      {
        x: 497, // 0 + 500 - HANDLE_THICKNESS/2
        y: 0,
        width: 6,
        height: 800,
        orientation: 'vertical',
        leftPaneId: 1,
        rightPaneId: 2,
      },
    ]);
  });

  it('puts a HORIZONTAL handle on the shared edge of two stacked panes', () => {
    const { handles } = computeSplitLayout(layout([7, 0, 0, 1, 0.5], [9, 0, 0.5, 1, 0.5]), AREA);
    expect(handles).toEqual([
      {
        x: 0,
        y: 397, // 0 + 400 - HANDLE_THICKNESS/2
        width: 1000,
        height: 6,
        orientation: 'horizontal',
        leftPaneId: 7,
        rightPaneId: 9,
      },
    ]);
  });

  it('emits one handle per ADJACENT pair, in (i, j) order', () => {
    // Three panes in a row: (0,1) and (1,2) are adjacent, (0,2) is not, so exactly
    // two handles — and `leftPaneId`/`rightPaneId` name the real neighbours.
    const { handles } = computeSplitLayout(
      layout([10, 0, 0, 1 / 3, 1], [11, 1 / 3, 0, 1 / 3, 1], [12, 2 / 3, 0, 1 / 3, 1]),
      AREA,
    );
    expect(handles.map((h) => [h.leftPaneId, h.rightPaneId, h.orientation])).toEqual([
      [10, 11, 'vertical'],
      [11, 12, 'vertical'],
    ]);
    // 1/3 * 1000 = 333.33…, and pane x is NOT rounded, so the second handle's x
    // is fractional too. Assert it approximately rather than inventing an integer.
    expect(handles[0].x).toBeCloseTo(330, 6);
    expect(handles[1].x).toBeCloseTo(663.3333333, 6);
  });

  it('emits NO handle for panes that only touch at a corner', () => {
    // Top-left and bottom-right of a 2x2 grid share neither an edge along x nor
    // along y. A naive "any two panes get a handle" implementation would put one
    // here, diagonally across the gap.
    const { handles } = computeSplitLayout(
      layout([1, 0, 0, 0.5, 0.5], [2, 0.5, 0.5, 0.5, 0.5]),
      AREA,
    );
    expect(handles).toEqual([]);
  });

  it('emits no handle for a single pane', () => {
    expect(computeSplitLayout(layout([1, 0, 0, 1, 1]), AREA).handles).toEqual([]);
  });

  it('keeps the handle inside the content area when the area is offset', () => {
    const { handles } = computeSplitLayout(layout([1, 0, 0, 0.5, 1], [2, 0.5, 0, 0.5, 1]), {
      x: 10,
      y: 20,
      width: 1000,
      height: 800,
    });
    expect(handles).toHaveLength(1);
    expect(handles[0]).toMatchObject({ x: 507, y: 20 });
  });
});

// --- clampResizeDelta ------------------------------------------------------
// The arguments here are NOT the same units, and that is the whole story — see
// the "KNOWN BUG" block at the end. The unambiguous paths are pinned first.

const pane = (paneId: number, width: number, height: number): PaneRect => ({
  x: 0,
  y: 0,
  width,
  height,
  paneId,
});

describe('clampResizeDelta — guard clauses and the unclamped case', () => {
  it('returns 0 when either pane id is not among the rects', () => {
    const rects = [pane(1, 600, 600), pane(2, 600, 600)];
    expect(clampResizeDelta(0.1, 'vertical', rects, 1, 99, 1200)).toBe(0);
    expect(clampResizeDelta(0.1, 'vertical', rects, 99, 2, 1200)).toBe(0);
  });

  it('passes the delta straight through when neither pane is near a bound', () => {
    // 600px each in a 1200px area: min 200, max 960, so nothing fires and the
    // caller's fraction arithmetic stays valid.
    const rects = [pane(1, 600, 600), pane(2, 600, 600)];
    // `toBeCloseTo`, not `toBe`: the current implementation returns `delta`
    // verbatim, but a fix that recomputes the clamped position introduces ~1 ULP
    // of float noise (0.050000000000000044). These tests pin BEHAVIOUR, so they
    // must survive that.
    expect(clampResizeDelta(0.05, 'vertical', rects, 1, 2, 1200)).toBeCloseTo(0.05, 9);
    expect(clampResizeDelta(-0.05, 'vertical', rects, 1, 2, 1200)).toBeCloseTo(-0.05, 9);
  });

  it('clamps on WIDTH for a vertical handle and on HEIGHT for a horizontal one', () => {
    // Same rects, deliberately asymmetric: 600px wide, but 60px vs 900px tall.
    // Reading the wrong axis changes the answer, so this pins which is which.
    //
    // Only the DISCRIMINATION is asserted, never the magnitude: the magnitude is
    // in the buggy unit (see the KNOWN BUG block), so pinning a number here would
    // make this test break on the fix instead of only on a regression. The heights
    // are chosen so exactly ONE of the four sequential clamps can fire — they each
    // overwrite `clamped`, so a two-trigger fixture returns the last one's value.
    const rects = [pane(1, 600, 60), pane(2, 600, 900)];
    // Vertical reads width (600/600): nothing is near min or max, so it passes through.
    expect(clampResizeDelta(0.01, 'vertical', rects, 1, 2, 1200)).toBeCloseTo(0.01, 9);
    // Horizontal reads height (60/900): the 60px pane is under the minimum.
    expect(clampResizeDelta(0.01, 'horizontal', rects, 1, 2, 1200)).not.toBe(0.01);
  });

  it('scales the maximum with the content area (80% of it)', () => {
    // A 900px left pane is over the 80% maximum of a 1000px area, but well under
    // the 1600px maximum of a 2000px one. Asserted as clamped / not-clamped
    // rather than by value, for the same unit reason as the test above. (An
    // arithmetic fixture, not a physical layout: the 250px right pane is above
    // the 200px minimum in both, so no second clamp overwrites the first.)
    const rects = [pane(1, 900, 100), pane(2, 250, 100)];
    expect(clampResizeDelta(0.01, 'vertical', rects, 1, 2, 1000)).not.toBe(0.01);
    expect(clampResizeDelta(0.01, 'vertical', rects, 1, 2, 2000)).toBeCloseTo(0.01, 9);
  });
});

describe('clampResizeDelta — KNOWN BUG (clamp bounds and delta are in different units)', () => {
  // MEASURED, not reasoned. `App.tsx:578` calls this with
  //   fractionDelta = pixelDelta / window.innerWidth     (a FRACTION, ~0.008 for a
  //   10px drag on a 1200px window)
  // while `paneRects` are PIXELS and `MIN_PANE_SIZE` (200) and
  // `max = floor(contentSize * 0.8)` are PIXELS too. The return value is then
  // added to a FRACTION at App.tsx:590-602. The units only agree while no clamp
  // fires. As soon as one does, the returned value is in pixels and is added to a
  // fraction. Measured outcomes in a 1200px window for a +10px drag:
  //
  //   split     clamped      what the user gets        should get
  //   50/50      0.00833     0.508 / 0.492             OK
  //   25/75      0.00833     0.258 / 0.742             OK
  //   10/90      0           0.100 / 0.900  (no-op)    0.167 / 0.833 (left is under MIN_PANE_SIZE)
  //   90/10   -120           0.050 / 0.950             0.833 / 0.167
  //   95/05   -180           0.050 / 0.950             0.833 / 0.167
  //   15/85    120           0.950 / 0.050             0.167 / 0.833
  //
  // So: a handle next to a pane under ~17% (or over 80%) either does nothing at
  // all or slams the split to 5/95 on a 10px drag.
  //
  // These are `it.fails`: they PASS while the bug is present and go RED the
  // moment someone fixes it, which is the signal to delete them and drop the
  // qualifier. The fix is to work in fractions throughout — `min =
  // MIN_PANE_SIZE / contentSize`, `max = 0.8` — not to rescale the return value.
  const CONTENT = 1200;
  const DRAG = 10 / CONTENT; // App.tsx: fractionDelta for a 10px drag
  const MIN_FRAC = 200 / CONTENT; // 0.16667

  const split = (leftFrac: number, rightFrac: number) => [
    pane(1, Math.round(leftFrac * CONTENT), 1200),
    pane(2, Math.round(rightFrac * CONTENT), 1200),
  ];

  it.fails('grows an under-minimum left pane instead of dropping the drag', () => {
    // 120px left pane is below MIN_PANE_SIZE, so the clamp should hold it at
    // 200px == MIN_FRAC. Today it returns 0 and App.tsx:586 bails, so the handle
    // is simply dead.
    expect(clampResizeDelta(DRAG, 'vertical', split(0.1, 0.9), 1, 2, CONTENT)).toBeCloseTo(
      MIN_FRAC - 0.1,
      6,
    );
  });

  it.fails('shrinks an over-maximum right pane instead of inverting the split', () => {
    // 1080px right pane is over max (960px == 0.8), so it should be held at 0.8.
    // Today it returns -120, which the caller applies as a fraction, taking the
    // split to 0.05/0.95.
    expect(clampResizeDelta(DRAG, 'vertical', split(0.9, 0.1), 1, 2, CONTENT)).toBeCloseTo(
      0.1 - MIN_FRAC,
      6,
    );
  });

  it.fails('holds BOTH panes inside [min, 1-min] rather than collapsing to 0.05/0.95', () => {
    // The reachable bound is 1 - MIN_FRAC, NOT 0.8: a two-pane split always sums
    // to 1, so bounding the left pane to [0.16667, 0.8] is unsatisfiable whenever
    // min + 0.8 < 1. Deriving the maximum from the minimum is what makes the two
    // bounds simultaneously satisfiable.
    const rects = split(0.05, 0.95);
    const clamped = clampResizeDelta(DRAG, 'vertical', rects, 1, 2, CONTENT);
    const newLeft = Math.max(0.05, Math.min(0.95, 0.05 + clamped));
    const newRight = Math.max(0.05, Math.min(0.95, 0.95 - clamped));
    expect(newLeft).toBeCloseTo(MIN_FRAC, 9);
    expect(newRight).toBeCloseTo(1 - MIN_FRAC, 9);
  });
});
