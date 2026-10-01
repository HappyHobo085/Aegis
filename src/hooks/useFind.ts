// src/hooks/useFind.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FindState, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const emptyFindState = (viewId: ViewId): FindState => ({
  viewId,
  query: '',
  matchCount: 0,
  activeMatchIndex: 0,
});

/**
 * Owns find-in-page UI state for the active view.
 *
 * - Subscribes to `aegis.find.onState`, applying updates only for the given `activeViewId`.
 * - On tab switch (`activeViewId` changes) resets state to empty and calls
 *   `aegis.find.close` for the old view so highlights don't linger on background tabs.
 * - `setQuery` is debounced ~120 ms before calling `aegis.find.start` so rapid keystrokes
 *   don't restart the native search on every character.
 */
export function useFind(activeViewId: ViewId): {
  open: boolean;
  state: FindState;
  show(): void;
  close(): void;
  setQuery(q: string): void;
  next(): void;
  prev(): void;
} {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<FindState>(() => emptyFindState(activeViewId));

  // Track the previous viewId so we can call close() for the old view when switching tabs.
  const prevViewIdRef = useRef<ViewId>(activeViewId);

  // Debounce timer handle for setQuery.
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // On tab switch: reset state, close the bar, and close the find session on the outgoing view.
  useEffect(() => {
    const prev = prevViewIdRef.current;
    if (prev !== activeViewId) {
      prevViewIdRef.current = activeViewId;
      // Cancel any pending debounced find.start for the OUTGOING view first. Without this a
      // `find.start(prev, q)` queued <120ms before the switch would fire AFTER `find.close(prev)`
      // and silently re-open a find session (with live highlights) on the background tab —
      // invisible in the UI because the onState filter at :54 drops events for other views.
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
      setState(emptyFindState(activeViewId));
      setOpen(false);
      void aegis.find.close(prev);
    }
  }, [activeViewId]);

  // Subscribe to live find state updates.
  useEffect(() => {
    const unsubscribe = aegis.find.onState((s) => {
      if (s.viewId !== activeViewId) return;
      setState(s);
    });
    return unsubscribe;
  }, [activeViewId]);

  // Clean up any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
    };
  }, []);

  const show = useCallback(() => {
    setOpen(true);
  }, []);

  const close = useCallback(() => {
    // Cancel a pending debounced `find.start` FIRST, for the same reason the tab-switch
    // effect above does. Escape goes straight to `close()` (`FindBar`'s key handler, with
    // no query check), so pressing it within 120 ms of typing used to call
    // `find.close(activeViewId)` and then, 120 ms later, `find.start(activeViewId, q)` —
    // starting a live find session WITH highlights on a bar the user had already dismissed,
    // with nothing left on screen to clear them. The tab-switch effect already carries this
    // comment and this fix; `close()` was the one path that reached the same hazard and did
    // not take it.
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    setOpen(false);
    void aegis.find.close(activeViewId);
  }, [activeViewId]);

  const setQuery = useCallback(
    (q: string) => {
      // Update state immediately so the input reflects the typed value.
      setState((prev) => ({ ...prev, query: q }));

      // Debounce the actual search call.
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
      }
      debounceRef.current = setTimeout(() => {
        debounceRef.current = null;
        void aegis.find.start(activeViewId, q, undefined);
      }, 120);
    },
    [activeViewId],
  );

  const next = useCallback(() => {
    void aegis.find.next(activeViewId);
  }, [activeViewId]);

  const prev = useCallback(() => {
    void aegis.find.prev(activeViewId);
  }, [activeViewId]);

  return { open, state, show, close, setQuery, next, prev };
}
