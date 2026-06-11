// src/hooks/useSaved.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SavedItem } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const has = vi.fn();
const update = vi.fn();
const renameTag = vi.fn();
const deleteTag = vi.fn();
const tagUnion = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    saved: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
      has: (...a: any[]) => has(...a),
      update: (...a: any[]) => update(...a),
      renameTag: (...a: any[]) => renameTag(...a),
      deleteTag: (...a: any[]) => deleteTag(...a),
      tagUnion: (...a: any[]) => tagUnion(...a),
    },
  },
}));

import { useSaved } from './useSaved';

const item = (over: Partial<SavedItem> = {}): SavedItem => ({
  id: 1,
  url: 'https://example.com/',
  title: 'Example',
  tags: [],
  savedAt: 1000,
  ...over,
});

const seed: SavedItem[] = [
  item({ id: 1, url: 'https://example.com/', title: 'Example', tags: ['news', 'tech'], savedAt: 2000 }),
  item({ id: 2, url: 'https://other.example/', title: 'Other', tags: ['tech'], savedAt: 1000 }),
];

const seedUnion = ['news', 'tech'];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  has.mockResolvedValue(false);
  add.mockResolvedValue(seed);
  remove.mockResolvedValue([seed[1]]);
  update.mockResolvedValue(seed);
  renameTag.mockResolvedValue(seed);
  deleteTag.mockResolvedValue(seed);
  tagUnion.mockResolvedValue(seedUnion);
});

describe('useSaved', () => {
  it('seeds items from aegis.saved.list on mount', async () => {
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('seeds tagUnion from aegis.saved.tagUnion on mount', async () => {
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.tagUnion).toEqual(seedUnion));
    expect(tagUnion).toHaveBeenCalledTimes(1);
  });

  it('exposes activeTags state with a setter', async () => {
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.tagUnion).toEqual(seedUnion));
    expect(result.current.activeTags).toEqual([]);
    act(() => {
      result.current.setActiveTags(['tech']);
    });
    expect(result.current.activeTags).toEqual(['tech']);
  });

  it('drops an active tag once it disappears from tagUnion', async () => {
    // deleteTag shrinks the union; the prune effect should drop the now-gone tag
    // from activeTags while keeping ones that still exist.
    deleteTag.mockResolvedValue(seed);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['tech']);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.tagUnion).toEqual(seedUnion));
    act(() => {
      result.current.setActiveTags(['news', 'tech']);
    });
    expect(result.current.activeTags).toEqual(['news', 'tech']);
    await act(async () => {
      await result.current.deleteTag('news');
    });
    await waitFor(() => expect(result.current.tagUnion).toEqual(['tech']));
    expect(result.current.activeTags).toEqual(['tech']);
  });

  it('tracks isCurrentSaved via aegis.saved.has(currentUrl)', async () => {
    has.mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    expect(has).toHaveBeenCalledWith('https://example.com/');
  });

  it('re-queries has() when currentUrl changes', async () => {
    has.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const { result, rerender } = renderHook(({ url }) => useSaved(url), {
      initialProps: { url: 'https://example.com/' },
    });
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    rerender({ url: 'https://unsaved.example/' });
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(false));
    expect(has).toHaveBeenLastCalledWith('https://unsaved.example/');
  });

  it('add(input) calls aegis.saved.add and refreshes items + isCurrentSaved + tagUnion', async () => {
    const fresh: SavedItem[] = [
      item({ id: 3, url: 'https://new.example/', title: 'New', tags: ['blog'], savedAt: 3000 }),
      ...seed,
    ];
    add.mockResolvedValue(fresh);
    has.mockResolvedValueOnce(false).mockResolvedValue(true);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['blog', 'news', 'tech']);
    const { result } = renderHook(() => useSaved('https://new.example/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.add({ url: 'https://new.example/', title: 'New', tags: ['blog'] });
    });
    expect(add).toHaveBeenCalledWith({ url: 'https://new.example/', title: 'New', tags: ['blog'] });
    expect(result.current.items).toHaveLength(3);
    expect(result.current.isCurrentSaved).toBe(true);
    expect(result.current.tagUnion).toEqual(['blog', 'news', 'tech']);
  });

  it('addCurrent(title) saves the current url with the given title', async () => {
    add.mockResolvedValue(seed);
    has.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.addCurrent('Example Title');
    });
    expect(add).toHaveBeenCalledWith({ url: 'https://example.com/', title: 'Example Title' });
    expect(result.current.isCurrentSaved).toBe(true);
  });

  it('removeCurrent() removes the SavedItem whose url === currentUrl', async () => {
    has.mockResolvedValueOnce(true).mockResolvedValue(false);
    remove.mockResolvedValue([seed[1]]);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.isCurrentSaved).toBe(true));
    await act(async () => {
      await result.current.removeCurrent();
    });
    // id 1 is the item whose url === the current url
    expect(remove).toHaveBeenCalledWith(1);
    expect(result.current.items.map((i) => i.id)).toEqual([2]);
    expect(result.current.isCurrentSaved).toBe(false);
  });

  it('removeCurrent() is a no-op when the current url is not saved', async () => {
    has.mockResolvedValue(false);
    const { result } = renderHook(() => useSaved('https://nope.example/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.removeCurrent();
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it('remove(id) removes by id and refreshes items + isCurrentSaved', async () => {
    remove.mockResolvedValue([seed[0]]);
    has.mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.remove(2);
    });
    expect(remove).toHaveBeenCalledWith(2);
    expect(result.current.items.map((i) => i.id)).toEqual([1]);
  });

  it('update(id, partial) calls aegis.saved.update with title + tags and refreshes items', async () => {
    const updated: SavedItem[] = [
      item({ id: 1, url: 'https://example.com/', title: 'Renamed', tags: ['fresh'], savedAt: 2000 }),
      seed[1],
    ];
    update.mockResolvedValue(updated);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.update(1, { title: 'Renamed', tags: ['fresh'] });
    });
    expect(update).toHaveBeenCalledWith(1, { title: 'Renamed', tags: ['fresh'] });
    expect(result.current.items[0].title).toBe('Renamed');
    expect(result.current.items[0].tags).toEqual(['fresh']);
  });

  it('update(id, partial) refreshes tagUnion', async () => {
    update.mockResolvedValue(seed);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['fresh', 'tech']);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.tagUnion).toEqual(seedUnion));
    await act(async () => {
      await result.current.update(1, { tags: ['fresh'] });
    });
    expect(result.current.tagUnion).toEqual(['fresh', 'tech']);
  });

  it('renameTag(old, new) calls aegis.saved.renameTag and refreshes items + tagUnion', async () => {
    const renamed: SavedItem[] = [
      item({ id: 1, url: 'https://example.com/', title: 'Example', tags: ['news', 'technology'], savedAt: 2000 }),
      item({ id: 2, url: 'https://other.example/', title: 'Other', tags: ['technology'], savedAt: 1000 }),
    ];
    renameTag.mockResolvedValue(renamed);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['news', 'technology']);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.renameTag('tech', 'technology');
    });
    expect(renameTag).toHaveBeenCalledWith('tech', 'technology');
    expect(result.current.items[0].tags).toEqual(['news', 'technology']);
    expect(result.current.tagUnion).toEqual(['news', 'technology']);
  });

  it('renameTag remaps an active filter to the new tag name (does not drop it)', async () => {
    const renamed: SavedItem[] = [
      item({ id: 1, url: 'https://example.com/', title: 'Example', tags: ['technology'], savedAt: 2000 }),
    ];
    renameTag.mockResolvedValue(renamed);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['technology']);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.tagUnion).toEqual(seedUnion));
    act(() => {
      result.current.setActiveTags(['tech']);
    });
    expect(result.current.activeTags).toEqual(['tech']);
    await act(async () => {
      await result.current.renameTag('tech', 'technology');
    });
    // The active filter follows the rename instead of being silently dropped.
    expect(result.current.activeTags).toEqual(['technology']);
  });

  it('deleteTag(tag) calls aegis.saved.deleteTag and refreshes items + tagUnion', async () => {
    const pruned: SavedItem[] = [
      item({ id: 1, url: 'https://example.com/', title: 'Example', tags: ['news'], savedAt: 2000 }),
      item({ id: 2, url: 'https://other.example/', title: 'Other', tags: [], savedAt: 1000 }),
    ];
    deleteTag.mockResolvedValue(pruned);
    tagUnion.mockResolvedValueOnce(seedUnion).mockResolvedValue(['news']);
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.deleteTag('tech');
    });
    expect(deleteTag).toHaveBeenCalledWith('tech');
    expect(result.current.items[1].tags).toEqual([]);
    expect(result.current.tagUnion).toEqual(['news']);
  });
});
