// src/hooks/useSubscriptions.ts
import { useCallback, useEffect, useState } from 'react';
import type { Subscription, ListUpdateResult } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { awaitUpdateResult, UPDATE_RESULT_TIMEOUT_MS } from '../lib/updateResult';

export function useSubscriptions(): {
  subs: Subscription[];
  setEnabled(listId: string, enabled: boolean): Promise<void>;
  add(url: string): Promise<void>;
  remove(listId: string): Promise<void>;
  updateNow(): Promise<ListUpdateResult>;
} {
  const [subs, setSubs] = useState<Subscription[]>([]);

  useEffect(() => {
    let active = true;
    const load = () =>
      void aegis.subs.list().then((items) => {
        if (active) setSubs(items);
      });
    // BUG(F2): subscribe BEFORE the seed fetch. `subs.onChanged` registers its backend listener
    // only when the `listen` IPC is processed, so a `subs.changed` emitted while
    // `subs.list` was still queued was lost — and the hook's own re-read on it is the only
    // thing that ever fixes up the stale metadata.
    const off = aegis.subs.onChanged(load);
    load();
    // `subs.add` and `subs.setEnabled` return the store BEFORE their background
    // fetch runs, so a brand-new row comes back with `lastUpdated: null` and is
    // stale by the time it is rendered. The core rewrites that row on a spawned
    // thread (up to 25s) and then emits `subs.changed`; re-read on it. This hook
    // previously had NO subscription at all, so the metadata stayed stale forever.
    // `updateNow` deliberately keeps its own explicit re-read — it already awaits
    // its own event, and a second refetch there would be a redundant round trip.
    return () => {
      active = false;
      off();
    };
  }, []);

  const setEnabled = useCallback(async (listId: string, enabled: boolean): Promise<void> => {
    setSubs(await aegis.subs.setEnabled(listId, enabled));
  }, []);

  const add = useCallback(async (url: string): Promise<void> => {
    setSubs(await aegis.subs.add(url));
  }, []);

  const remove = useCallback(async (listId: string): Promise<void> => {
    setSubs(await aegis.subs.remove(listId));
  }, []);

  const updateNow = useCallback(async (): Promise<ListUpdateResult> => {
    // The core refresh is non-blocking (the up-to-25s fetch must not freeze the UI thread):
    // `updateNow` only kicks it off and the per-source result arrives via `onUpdateResult`.
    // Bridge that one-shot event back into the promise this hook has always returned, so
    // callers (FilterListsTab) are unchanged. `awaitUpdateResult` owns the settlement
    // rules, including what happens when the event never arrives at all.
    const result = await awaitUpdateResult(
      aegis.lists.onUpdateResult,
      aegis.lists.updateNow,
      UPDATE_RESULT_TIMEOUT_MS,
    );
    // A force-update mutates last-updated/etag/hash on every fetched row, so
    // re-read the list to reflect the fresh metadata in any open manager.
    setSubs(await aegis.subs.list());
    return result;
  }, []);

  return { subs, setEnabled, add, remove, updateNow };
}
