// src/hooks/useSaved.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedItem } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { onSyncChange } from '../lib/syncBus';

export interface UseSaved {
  items: SavedItem[];
  isCurrentSaved: boolean;
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  add(input: { url: string; title: string; tags?: string[] }): Promise<void>;
  addCurrent(title: string): Promise<void>;
  removeCurrent(): Promise<void>;
  remove(id: number): Promise<void>;
  update(id: number, partial: { title?: string; tags?: string[] }): Promise<void>;
  renameTag(oldT: string, newT: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;
  /** Directly set items + tagUnion (autopilot dev-only seeding; bypasses async refresh). */
  _setSavedItems(items: SavedItem[], tagUnion: string[]): void;
}

export function useSaved(currentUrl: string): UseSaved {
  const [items, setItems] = useState<SavedItem[]>([]);
  const [isCurrentSaved, setIsCurrentSaved] = useState<boolean>(false);
  const [tagUnion, setTagUnion] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);

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

  const refreshTagUnion = useCallback(async (): Promise<void> => {
    setTagUnion(await aegis.saved.tagUnion());
  }, []);

  useEffect(() => {
    let active = true;
    const loadList = () => {
      void aegis.saved.list().then((list) => {
        if (active) setItems(list);
      });
      void aegis.saved.tagUnion().then((union) => {
        if (active) setTagUnion(union);
      });
    };
    loadList();
    // Refetch (targeted) when sync merges remote saved items — list + tagUnion + the
    // current-url fill state (a synced add/remove can change whether THIS url is saved).
    // `has` is only refreshed here (mount already queries it via the currentUrl effect).
    const off = onSyncChange('saved', () => {
      loadList();
      void aegis.saved.has(urlRef.current).then((saved) => {
        if (active) setIsCurrentSaved(saved);
      });
    });
    return () => {
      active = false;
      off();
    };
  }, []);

  // Drop any active filter tag that no longer exists (e.g. after delete/rename or
  // removing the last item carrying it). Pure updater — StrictMode-safe.
  useEffect(() => {
    setActiveTags((prev) => prev.filter((t) => tagUnion.includes(t)));
  }, [tagUnion]);

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
    async (input: { url: string; title: string; tags?: string[] }): Promise<void> => {
      setItems(await aegis.saved.add(input));
      await refreshHas();
      await refreshTagUnion();
    },
    [refreshHas, refreshTagUnion],
  );

  const addCurrent = useCallback(
    async (title: string): Promise<void> => {
      setItems(await aegis.saved.add({ url: urlRef.current, title }));
      await refreshHas();
      await refreshTagUnion();
    },
    [refreshHas, refreshTagUnion],
  );

  const remove = useCallback(
    async (id: number): Promise<void> => {
      setItems(await aegis.saved.remove(id));
      await refreshHas();
      await refreshTagUnion();
    },
    [refreshHas, refreshTagUnion],
  );

  const removeCurrent = useCallback(async (): Promise<void> => {
    const match = itemsRef.current.find((i) => i.url === urlRef.current);
    if (!match) return;
    setItems(await aegis.saved.remove(match.id));
    await refreshHas();
    await refreshTagUnion();
  }, [refreshHas, refreshTagUnion]);

  const update = useCallback(
    async (id: number, partial: { title?: string; tags?: string[] }): Promise<void> => {
      setItems(await aegis.saved.update(id, partial));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const renameTag = useCallback(
    async (oldT: string, newT: string): Promise<void> => {
      setItems(await aegis.saved.renameTag(oldT, newT));
      // Keep an active filter pointing at the renamed tag (otherwise the tagUnion
      // prune below would silently drop the user's selection). Pure updater.
      setActiveTags((prev) =>
        prev.includes(oldT) ? [...new Set(prev.map((t) => (t === oldT ? newT : t)))] : prev,
      );
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const deleteTag = useCallback(
    async (tag: string): Promise<void> => {
      setItems(await aegis.saved.deleteTag(tag));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  return {
    items,
    isCurrentSaved,
    tagUnion,
    activeTags,
    setActiveTags,
    add,
    addCurrent,
    removeCurrent,
    remove,
    update,
    renameTag,
    deleteTag,
    _setSavedItems: (newItems, newTagUnion) => {
      setItems(newItems);
      setTagUnion(newTagUnion);
    },
  };
}
