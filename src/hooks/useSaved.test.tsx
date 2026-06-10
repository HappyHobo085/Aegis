// src/hooks/useSaved.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SavedItem } from '../../shared/types';

const list = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const has = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    saved: {
      list: (...a: any[]) => list(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
      has: (...a: any[]) => has(...a),
    },
  },
}));

import { useSaved } from './useSaved';

const item = (over: Partial<SavedItem> = {}): SavedItem => ({
  id: 1,
  url: 'https://example.com/',
  title: 'Example',
  savedAt: 1000,
  ...over,
});

const seed: SavedItem[] = [
  item({ id: 1, url: 'https://example.com/', title: 'Example', savedAt: 2000 }),
  item({ id: 2, url: 'https://other.example/', title: 'Other', savedAt: 1000 }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  has.mockResolvedValue(false);
  add.mockResolvedValue(seed);
  remove.mockResolvedValue([seed[1]]);
});

describe('useSaved', () => {
  it('seeds items from aegis.saved.list on mount', async () => {
    const { result } = renderHook(() => useSaved('https://example.com/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
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

  it('add(input) calls aegis.saved.add and refreshes items + isCurrentSaved', async () => {
    const fresh: SavedItem[] = [item({ id: 3, url: 'https://new.example/', title: 'New', savedAt: 3000 }), ...seed];
    add.mockResolvedValue(fresh);
    has.mockResolvedValueOnce(false).mockResolvedValue(true);
    const { result } = renderHook(() => useSaved('https://new.example/'));
    await waitFor(() => expect(result.current.items).toHaveLength(2));
    await act(async () => {
      await result.current.add({ url: 'https://new.example/', title: 'New' });
    });
    expect(add).toHaveBeenCalledWith({ url: 'https://new.example/', title: 'New' });
    expect(result.current.items).toHaveLength(3);
    expect(result.current.isCurrentSaved).toBe(true);
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
});
