import { useEffect, useRef } from 'react';

/**
 * Attach to a horizontally-scrollable strip so a vertical mouse wheel scrolls it
 * sideways when its content overflows. Uses a non-passive native listener so
 * preventDefault works (React's onWheel is passive). No-op when not overflowing.
 */
export function useHorizontalWheel<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      // Respect intentional horizontal wheels (trackpads); only translate vertical ones.
      if (e.deltaY === 0) return;
      if (el.scrollWidth <= el.clientWidth) return; // nothing to scroll
      el.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);
  return ref;
}
