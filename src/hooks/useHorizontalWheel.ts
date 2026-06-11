import { useCallback, useRef } from 'react';

/**
 * Returns a callback ref to attach to a horizontally-scrollable strip so a vertical
 * mouse wheel scrolls it sideways when its content overflows. Uses a NON-passive
 * native listener so preventDefault works (React's onWheel is passive). No-op when
 * the strip isn't overflowing.
 *
 * A callback ref (not useRef + useEffect) is used deliberately: the target element
 * may mount/unmount AFTER the host component — e.g. the sidebar tab strip only
 * renders while the sidebar is open, inside an always-mounted Sidebar. React invokes
 * the callback whenever the node attaches/detaches, so the listener is (re)bound
 * exactly when the element exists; a useEffect([]) would bind once at host mount,
 * miss the not-yet-rendered strip, and never re-attach.
 */
export function useHorizontalWheel<T extends HTMLElement>() {
  const cleanupRef = useRef<(() => void) | null>(null);

  return useCallback((node: T | null) => {
    // Detach from any previous node first.
    if (cleanupRef.current) {
      cleanupRef.current();
      cleanupRef.current = null;
    }
    if (!node) return;

    const onWheel = (e: WheelEvent): void => {
      // Respect intentional horizontal wheels (trackpads); only translate vertical ones.
      if (e.deltaY === 0) return;
      if (node.scrollWidth <= node.clientWidth) return; // nothing to scroll
      node.scrollLeft += e.deltaY;
      e.preventDefault();
    };
    node.addEventListener('wheel', onWheel, { passive: false });
    cleanupRef.current = () => node.removeEventListener('wheel', onWheel);
  }, []);
}
