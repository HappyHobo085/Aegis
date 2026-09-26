// src/hooks/useMeasuredHeight.ts
//
// Measure one popover's rendered height so the compositor can inset the content
// webview by exactly that much (see useChromePopover).
//
// A ResizeObserver is safe here — unlike the chrome-height measurement, which
// deliberately avoids observers (useChromeHeights) — because the observed element
// lives in the chrome webview, which fills the window and is never resized by the
// content inset. The loop the chrome comment warns about needs a size feedback
// path from the inset back into the measured element, and there is none. Popover
// heights are also fixed in CSS (never `vh`-relative) so they cannot grow/shrink
// in response to the window. The change guard below makes a redundant callback a
// no-op even if that reasoning ever breaks.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

/**
 * @param active Whether the measured element is (about to be) mounted. Passing
 *   it re-arms the observer when a popover opens, since the element only exists
 *   while the popover is open.
 * @returns A ref to spread onto the popover root, and its measured height in px
 *   (0 while closed / unmeasured).
 */
export function useMeasuredHeight<T extends HTMLElement>(
  active: boolean,
): [RefObject<T | null>, number] {
  const ref = useRef<T | null>(null);
  const [height, setHeight] = useState(0);

  const measure = useCallback(() => {
    const el = ref.current;
    const next = el ? Math.round(el.getBoundingClientRect().height) : 0;
    setHeight((prev) => (prev === next ? prev : next));
  }, []);

  useEffect(() => {
    if (!active) {
      // Closed (or not yet open): drop the reservation immediately so the content
      // springs back without waiting for a render of the (absent) element.
      setHeight(0);
      return;
    }
    measure();
    // jsdom (and very old WebKitGTK) have no ResizeObserver; the single measure()
    // above is the best we can do there.
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(measure);
    if (ref.current) ro.observe(ref.current);
    return () => ro.disconnect();
  }, [active, measure]);

  return [ref, height];
}
