// src/hooks/useMeasuredRect.ts
//
// Measure one popover's rendered rectangle so the surface can be placed exactly over it.
//
// This is `useMeasuredHeight`'s successor and the reason is geometric, not cosmetic: the
// popover surface needs a POSITION, not just a height. `useMeasuredHeight` existed only to
// inset the content webview by the tallest registered popover, which is the mechanism this
// whole feature removes — so the two coexist for now and `useMeasuredHeight` goes when the
// last popover stops registering an inset (popover-surface Phase 4).
//
// A ResizeObserver is safe here for the same reason it was safe there: the observed element
// lives in the chrome webview, which fills the window and is NOT resized by the surface's
// rect. The loop the chrome comment warns about needs a size feedback path from the popover
// back into the measured element, and there is none — the surface is a sibling webview, not
// a parent. Popover sizes are fixed in CSS (never `vh`-relative) so they cannot grow with
// the window either. The change guard makes a redundant callback a no-op even if that
// reasoning ever breaks.
//
// The guard changed shape with the return value: "height differs" is not enough once a
// position is part of the answer, because a popover can move without resizing (the omnibox
// dropdown follows the caret's row, not the caret's pixel). Hence a rect comparison.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/** Whole pixels, because the surface's rect goes to `set_position`/`set_size` and to a GTK
 *  allocation — sub-pixel values would be rounded twice and land a pixel off. */
export interface MeasuredRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** The zero rect: a closed popover reserves nothing. Also what an absent element measures. */
export const EMPTY_RECT: MeasuredRect = { x: 0, y: 0, width: 0, height: 0 };

function sameRect(a: MeasuredRect, b: MeasuredRect): boolean {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectOf(el: Element | null): MeasuredRect {
  if (!el) return EMPTY_RECT;
  const r = el.getBoundingClientRect();
  return {
    x: Math.round(r.x),
    y: Math.round(r.y),
    width: Math.round(r.width),
    height: Math.round(r.height),
  };
}

/**
 * @param active Whether the measured element is (about to be) mounted. Passing it re-arms
 *   the observer when a popover opens, since the element only exists while it is open.
 * @returns A ref to spread onto the popover root, and its rectangle in whole px
 *   (`EMPTY_RECT` while closed / unmeasured).
 */
export function useMeasuredRect<T extends HTMLElement>(
  active: boolean,
): [RefObject<T | null>, MeasuredRect] {
  const ref = useRef<T | null>(null);
  const [rect, setRect] = useState<MeasuredRect>(EMPTY_RECT);

  const measure = useCallback(() => {
    const next = rectOf(ref.current);
    setRect((prev) => (sameRect(prev, next) ? prev : next));
  }, []);

  useEffect(() => {
    if (!active) {
      // Closed (or not yet open): drop the reservation immediately so the surface parks
      // without waiting for a render of the (absent) element.
      setRect(EMPTY_RECT);
      return;
    }
    measure();
    // jsdom (and very old WebKitGTK) have no ResizeObserver; the single measure() above is
    // the best we can do there.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [active, measure]);

  return [ref, rect];
}
