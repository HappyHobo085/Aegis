// src/hooks/useCustomFilters.ts
import { useCallback, useEffect, useState } from 'react';
import { aegis } from '../lib/ipcClient';

export function useCustomFilters(): {
  text: string;
  save(text: string): Promise<void>;
} {
  const [text, setText] = useState<string>('');

  useEffect(() => {
    let active = true;
    void aegis.customFilters.get().then((stored) => {
      if (active) setText(stored);
    });
    return () => {
      active = false;
    };
  }, []);

  const save = useCallback(async (next: string): Promise<void> => {
    // set returns the stored blob; mirror it back so the box reflects what
    // actually persisted (and what the engine rebuilt from).
    setText(await aegis.customFilters.set(next));
  }, []);

  return { text, save };
}
