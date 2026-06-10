// src/hooks/useSubscriptions.ts
import { useCallback, useEffect, useState } from 'react';
import type { Subscription, ListUpdateResult } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

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
    void aegis.subs.list().then((items) => {
      if (active) setSubs(items);
    });
    return () => {
      active = false;
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
    const result = await aegis.lists.updateNow();
    // A force-update mutates last-updated/etag/hash on every fetched row, so
    // re-read the list to reflect the fresh metadata in any open manager.
    setSubs(await aegis.subs.list());
    return result;
  }, []);

  return { subs, setEnabled, add, remove, updateNow };
}
