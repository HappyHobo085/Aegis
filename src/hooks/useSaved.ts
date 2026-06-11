// src/hooks/useSaved.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedItem } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export interface UseSaved {
  items: SavedItem[];
  isCurrentSaved: boolean;
  add(input: { url: string; title: string }): Promise<void>;
  addCurrent(title: string): Promise<void>;
  removeCurrent(): Promise<void>;
  remove(id: number): Promise<void>;
  update(id: number, title: string): Promise<void>;
}

export function useSaved(currentUrl: string): UseSaved {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [isCurrentSaved, setIsCurrentSaved] = useState<boolean>(false);

  // Read currentUrl + items at call time without re-binding callbacks on every
  // url/list change (mirrors useAdblock's urlRef pattern).
  const urlRef = useRef<string>(currentUrl);
  urlRef.current = currentUrl;
  const itemsRef = useRef<SavedItem[]>(items);
  itemsRef.current = items;

  const refreshHas = useCallback(async (): Promise<void> => {
    const saved = await aegis.saved.has(urlRef.current);
    setIsCurrentSaved(saved);
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.saved.list().then((list) => {
      if (active) setItems(list);
    });
    return () => {
      active = false;
    };
  }, []);

  // Re-query the fill-in state whenever the current url changes.
  useEffect(() => {
    let active = true;
    void aegis.saved.has(currentUrl).then((saved) => {
      if (active) setIsCurrentSaved(saved);
    });
    return () => {
      active = false;
    };
  }, [currentUrl]);

  const add = useCallback(
    async (input: { url: string; title: string }): Promise<void> => {
      setItems(await aegis.saved.add(input));
      await refreshHas();
    },
    [refreshHas],
  );

  const addCurrent = useCallback(
    async (title: string): Promise<void> => {
      setItems(await aegis.saved.add({ url: urlRef.current, title }));
      await refreshHas();
    },
    [refreshHas],
  );

  const remove = useCallback(
    async (id: number): Promise<void> => {
      setItems(await aegis.saved.remove(id));
      await refreshHas();
    },
    [refreshHas],
  );

  const removeCurrent = useCallback(async (): Promise<void> => {
    const match = itemsRef.current.find((i) => i.url === urlRef.current);
    if (!match) return;
    setItems(await aegis.saved.remove(match.id));
    await refreshHas();
  }, [refreshHas]);

  const update = useCallback(async (id: number, title: string): Promise<void> => {
    setItems(await aegis.saved.update(id, { title }));
  }, []);

  return { items, isCurrentSaved, add, addCurrent, removeCurrent, remove, update };
}
