// src/hooks/useFavorites.ts
import { useCallback, useEffect, useState } from 'react';
import type { Favorite } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useFavorites(_currentUrl: string): {
  favorites: Favorite[];
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  add(input: { name: string; url: string; tags: string[] }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void>;
  remove(id: number): Promise<void>;
  reorder(ids: number[]): Promise<void>;
  renameTag(oldT: string, newT: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;
} {
  const [all, setAll] = useState<Favorite[]>([]);
  const [tagUnion, setTagUnion] = useState<string[]>([]);
  const [activeTags, setActiveTags] = useState<string[]>([]);

  // Refresh the tag union after any mutation that can change tags.
  const refreshTagUnion = useCallback(async (): Promise<void> => {
    const union = await aegis.favorites.tagUnion();
    setTagUnion(union);
  }, []);

  useEffect(() => {
    let active = true;
    void aegis.favorites.list().then((items) => {
      if (active) setAll(items);
    });
    void aegis.favorites.tagUnion().then((union) => {
      if (active) setTagUnion(union);
    });
    return () => {
      active = false;
    };
  }, []);

  const add = useCallback(
    async (input: { name: string; url: string; tags: string[] }): Promise<void> => {
      setAll(await aegis.favorites.add(input));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const update = useCallback(
    async (id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void> => {
      setAll(await aegis.favorites.update(id, partial));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const remove = useCallback(async (id: number): Promise<void> => {
    setAll(await aegis.favorites.remove(id));
  }, []);

  const reorder = useCallback(async (ids: number[]): Promise<void> => {
    setAll(await aegis.favorites.reorder(ids));
  }, []);

  const renameTag = useCallback(
    async (oldT: string, newT: string): Promise<void> => {
      setAll(await aegis.favorites.renameTag(oldT, newT));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  const deleteTag = useCallback(
    async (tag: string): Promise<void> => {
      setAll(await aegis.favorites.deleteTag(tag));
      await refreshTagUnion();
    },
    [refreshTagUnion],
  );

  // A favorite passes the filter when it carries EVERY active tag.
  const favorites =
    activeTags.length === 0
      ? all
      : all.filter((f) => activeTags.every((t) => f.tags.includes(t)));

  return {
    favorites,
    tagUnion,
    activeTags,
    setActiveTags,
    add,
    update,
    remove,
    reorder,
    renameTag,
    deleteTag,
  };
}
