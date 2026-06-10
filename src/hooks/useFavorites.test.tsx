// src/hooks/useFavorites.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Favorite } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const reorder = vi.fn();
const renameTag = vi.fn();
const deleteTag = vi.fn();
const tagUnion = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    favorites: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      update: (...a: any[]) => update(...a),
      remove: (...a: any[]) => remove(...a),
      reorder: (...a: any[]) => reorder(...a),
      renameTag: (...a: any[]) => renameTag(...a),
      deleteTag: (...a: any[]) => deleteTag(...a),
      tagUnion: (...a: any[]) => tagUnion(...a),
    },
  },
}));

import { useFavorites } from './useFavorites';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  tags: ['news'],
  position: 0,
  ...over,
});

const seedFavs: Favorite[] = [
  fav({ id: 1, name: 'A', url: 'https://a.example/', tags: ['news'], position: 0 }),
  fav({ id: 2, name: 'B', url: 'https://b.example/', tags: ['dev', 'news'], position: 1 }),
  fav({ id: 3, name: 'C', url: 'https://c.example/', tags: ['dev'], position: 2 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seedFavs);
  tagUnion.mockResolvedValue(['dev', 'news']);
  add.mockResolvedValue(seedFavs);
  update.mockResolvedValue(seedFavs);
  remove.mockResolvedValue(seedFavs);
  reorder.mockResolvedValue(seedFavs);
  renameTag.mockResolvedValue(seedFavs);
  deleteTag.mockResolvedValue(seedFavs);
});

describe('useFavorites', () => {
  it('seeds favorites and tagUnion on mount', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(1);
    expect(tagUnion).toHaveBeenCalledTimes(1);
    expect(result.current.tagUnion).toEqual(['dev', 'news']);
    expect(result.current.activeTags).toEqual([]);
  });

  it('with no active tags, favorites is the full list', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    expect(result.current.favorites.map((f) => f.id)).toEqual([1, 2, 3]);
  });

  it('filters favorites to those having ALL active tags', async () => {
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    act(() => result.current.setActiveTags(['dev']));
    expect(result.current.favorites.map((f) => f.id)).toEqual([2, 3]);
    act(() => result.current.setActiveTags(['dev', 'news']));
    expect(result.current.favorites.map((f) => f.id)).toEqual([2]);
  });

  it('add() calls aegis and refreshes favorites + tagUnion from results', async () => {
    const added: Favorite[] = [...seedFavs, fav({ id: 4, name: 'D', url: 'https://d.example/', tags: ['x'], position: 3 })];
    add.mockResolvedValue(added);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['dev', 'news', 'x']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.add({ name: 'D', url: 'https://d.example/', tags: ['x'] });
    });
    expect(add).toHaveBeenCalledWith({ name: 'D', url: 'https://d.example/', tags: ['x'] });
    expect(result.current.favorites).toHaveLength(4);
    expect(result.current.tagUnion).toEqual(['dev', 'news', 'x']);
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

  it('renameTag() calls aegis and refreshes favorites + tagUnion', async () => {
    const renamed = seedFavs.map((f) => ({ ...f, tags: f.tags.map((t) => (t === 'dev' ? 'engineering' : t)) }));
    renameTag.mockResolvedValue(renamed);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['engineering', 'news']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.renameTag('dev', 'engineering');
    });
    expect(renameTag).toHaveBeenCalledWith('dev', 'engineering');
    expect(result.current.tagUnion).toEqual(['engineering', 'news']);
  });

  it('deleteTag() calls aegis and refreshes favorites + tagUnion', async () => {
    const purged = seedFavs.map((f) => ({ ...f, tags: f.tags.filter((t) => t !== 'dev') }));
    deleteTag.mockResolvedValue(purged);
    tagUnion.mockResolvedValueOnce(['dev', 'news']).mockResolvedValue(['news']);
    const { result } = renderHook(() => useFavorites('https://example.com/'));
    await waitFor(() => expect(result.current.favorites).toHaveLength(3));
    await act(async () => {
      await result.current.deleteTag('dev');
    });
    expect(deleteTag).toHaveBeenCalledWith('dev');
    expect(result.current.tagUnion).toEqual(['news']);
  });
});
