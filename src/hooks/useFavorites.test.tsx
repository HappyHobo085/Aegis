// src/hooks/useFavorites.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Favorite } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const reorder = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    favorites: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      update: (...a: any[]) => update(...a),
      remove: (...a: any[]) => remove(...a),
      reorder: (...a: any[]) => reorder(...a),
    },
  },
}));

import { useFavorites } from './useFavorites';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  position: 0,
  ...over,
});

const seedFavs: Favorite[] = [
  fav({ id: 1, name: 'A', url: 'https://a.example/', position: 0 }),
  fav({ id: 2, name: 'B', url: 'https://b.example/', position: 1 }),
  fav({ id: 3, name: 'C', url: 'https://c.example/', position: 2 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seedFavs);
  add.mockResolvedValue(seedFavs);
  update.mockResolvedValue(seedFavs);
  remove.mockResolvedValue(seedFavs);
  reorder.mockResolvedValue(seedFavs);
});

describe('useFavorites', () => {
  it('seeds favorites on mount', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('favorites is the full list in position order', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(result.current.favorites.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('add() calls aegis with {name,url} and refreshes favorites from the result', async () => {
    const added: Favorite[] = [
      ...seedFavs,
      fav({ id: 4, name: 'D', url: 'https://d.example/', position: 3 }),
    ];
    add.mockResolvedValue(added);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.add({ name: 'D', url: 'https://d.example/' });
    });
    expect(add).toHaveBeenCalledWith({ name: 'D', url: 'https://d.example/' });
    expect(result.current.favorites).toHaveLength(4);
    expect(result.current.favorites.map((f) => f.id)).toEqual([1, 2, 3, 4]);
  });

  it('update() calls aegis with id + partial and refreshes from the result', async () => {
    const updated = [fav({ id: 1, name: 'A2' }), seedFavs[1], seedFavs[2]];
    update.mockResolvedValue(updated);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.update(1, { name: 'A2' });
    });
    expect(update).toHaveBeenCalledWith(1, { name: 'A2' });
    expect(result.current.favorites[0].name).toBe('A2');
  });

  it('remove() calls aegis and refreshes the list', async () => {
    remove.mockResolvedValue([seedFavs[1], seedFavs[2]]);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.remove(1);
    });
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.favorites.map((f) => f.id)).toEqual([2, 3]);
  });

  it('reorder() calls aegis with the id order and refreshes', async () => {
    reorder.mockResolvedValue([seedFavs[2], seedFavs[1], seedFavs[0]]);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.reorder([3, 2, 1]);
    });
    expect(reorder).toHaveBeenCalledWith([3, 2, 1]);
    expect(result.current.favorites.map((f) => f.id)).toEqual([3, 2, 1]);
  });
});
