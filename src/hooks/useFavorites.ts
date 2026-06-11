// src/hooks/useFavorites.ts
import { useCallback, useEffect, useState } from 'react';
import type { Favorite } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export function useFavorites(_currentUrl: string): {
  favorites: Favorite[];
  add(input: { name: string; url: string }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string }): Promise<void>;
  remove(id: number): Promise<void>;
  reorder(ids: number[]): Promise<void>;
} {
  const [favorites, setFavorites] = useState<Favorite[]>([]);

  useEffect(() => {
    let active = true;
    void aegis.favorites.list().then((items) => {
      if (active) setFavorites(items);
    });
    return () => {
      active = false;
    };
  }, []);

  const add = useCallback(async (input: { name: string; url: string }): Promise<void> => {
    setFavorites(await aegis.favorites.add(input));
  }, []);

  const update = useCallback(
    async (id: number, partial: { name?: string; url?: string }): Promise<void> => {
      setFavorites(await aegis.favorites.update(id, partial));
    },
    [],
  );

  const remove = useCallback(async (id: number): Promise<void> => {
    setFavorites(await aegis.favorites.remove(id));
  }, []);

  const reorder = useCallback(async (ids: number[]): Promise<void> => {
    setFavorites(await aegis.favorites.reorder(ids));
  }, []);

  return { favorites, add, update, remove, reorder };
}
