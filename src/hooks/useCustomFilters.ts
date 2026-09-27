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
    // Refetch when the ELEMENT PICKER appends a rule. `customfilters.rs` emits
    // nothing of its own, so without this a Settings > My Filters panel that is
    // already open keeps showing the pre-pick text until it is reopened — the
    // toolbar picker and the settings modal are rendered together, so both can be
    // open at once. `picker.picked` is the only signal the core sends.
    const offPicked = aegis.picker.onPicked(load);
    return () => {
      active = false;
      off();
      offPicked();
    };
  }, []);

  const save = useCallback(async (next: string): Promise<void> => {
    // set returns the stored blob; mirror it back so the box reflects what
    // actually persisted (and what the engine rebuilt from).
    setText(await aegis.customFilters.set(next));
  }, []);

  return { text, save };
}
