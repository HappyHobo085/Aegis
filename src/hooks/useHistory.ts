// src/hooks/useHistory.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { HistoryEntry } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useHistory(): {
  entries: HistoryEntry[];
  query: string;
  setQuery(q: string): void;
  search(): Promise<void>;
  remove(id: number): Promise<void>;
  removeForOrigin(origin: string): Promise<number>;
  clear(): Promise<void>;
} {
  const [entries, setEntries] = useState<HistoryEntry[]>([]);
  const [query, setQueryState] = useState<string>('');

  // Read the live query inside refresh()/the onChanged subscription without
  // re-binding the subscription on every keystroke (mirrors useAdblock's urlRef).
  // Also updated eagerly in setQuery so refresh() sees the new value immediately
  // when called in the same synchronous turn as setQuery.
  const queryRef = useRef<string>(query);
  queryRef.current = query;

  const setQuery = useCallback((q: string) => {
    queryRef.current = q;
    setQueryState(q);
  }, []);

  // Monotonic token so only the latest-STARTED refresh may apply its (async) result.
  // Two history.changed events in quick succession (e.g. navigating two pages back to
  // back) spawn concurrent refreshes; without this an older list()/search() resolving
  // last clobbers the panel with stale data, dropping the newest visits until the next
  // change. An interaction test drives exactly this race.
  const refreshSeq = useRef(0);

  const refresh = useCallback(async (): Promise<void> => {
    const seq = ++refreshSeq.current;
    const q = queryRef.current.trim();
    const next = q.length > 0 ? await aegis.history.search(q) : await aegis.history.list();
    if (seq === refreshSeq.current) setEntries(next);
  }, []);

  useEffect(() => {
    // BUG(F2): subscribe BEFORE the seed fetch. `history.onChanged` registers its backend
    // listener only when the `listen` IPC is processed, so a visit recorded while the initial
    // `history.list` was still queued was lost with nothing to refetch it — the panel would
    // not show the page the user had just visited.
    const unsubscribe = aegis.history.onChanged(() => {
      void refresh();
    });
    // Initial load goes through refresh() so it shares the seq-guard (a slow mount
    // fetch can't clobber a fast history.changed refresh, or vice versa).
    void refresh();
    return () => {
      refreshSeq.current++; // invalidate any in-flight refresh on unmount
      unsubscribe();
    };
  }, [refresh]);

  const search = useCallback((): Promise<void> => refresh(), [refresh]);

  const remove = useCallback(
    async (id: number): Promise<void> => {
      await aegis.history.remove(id);
      await refresh();
    },
    [refresh],
  );

  const clear = useCallback(async (): Promise<void> => {
    await aegis.history.clear();
    await refresh();
  }, [refresh]);

  // Deletes every row for one origin INSIDE the core. Do not implement this as a loop over
  // `entries` above: that array is one `list()` page (the core default cap is 200, against
  // 5000 stored rows), so a loop would clear at most that many and report success — while
  // `history.search` filters the full store, so the user could still find the rest.
  const removeForOrigin = useCallback(
    async (origin: string): Promise<number> => {
      const removed = await aegis.history.removeForOrigin(origin);
      await refresh();
      return removed;
    },
    [refresh],
  );

  return { entries, query, setQuery, search, remove, removeForOrigin, clear };
}
