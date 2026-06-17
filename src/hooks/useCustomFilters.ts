// src/hooks/useCustomFilters.ts
import { useCallback, useEffect, useState } from 'react';
import { aegis } from '../lib/ipcClient';
import { onSyncChange } from '../lib/syncBus';

export function useCustomFilters(): {
  text: string;
  save(text: string): Promise<void>;
} {
  const [text, setText] = useState<string>('');

  useEffect(() => {
    let active = true;
    const load = () =>
      void aegis.customFilters.get().then((stored) => {
        if (active) setText(stored);
      });
    load();
    // Refetch when sync merges a remote custom-filter change.
    const off = onSyncChange('customFilters', load);
    return () => {
      active = false;
      off();
    };
  }, []);

  const save = useCallback(async (next: string): Promise<void> => {
    // set returns the stored blob; mirror it back so the box reflects what
    // actually persisted (and what the engine rebuilt from).
    setText(await aegis.customFilters.set(next));
  }, []);

  return { text, save };
}
