// src/hooks/useHistory.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { HistoryEntry } from '../../shared/types';

const list = vi.fn();
const search = vi.fn();
const remove = vi.fn();
const clear = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    history: {
      list: (...a: any[]) => list(...a),
      search: (...a: any[]) => search(...a),
      remove: (...a: any[]) => remove(...a),
      clear: (...a: any[]) => clear(...a),
      onChanged: (cb: () => void) => onChanged(cb),
    },
  },
}));

import { useHistory } from './useHistory';

const entry = (id: number, url: string, title: string, visitedAt: number): HistoryEntry => ({
  id,
  url,
  title,
  visitedAt,
});

const seed: HistoryEntry[] = [
  entry(2, 'https://b.example/', 'B', 2000),
  entry(1, 'https://a.example/', 'A', 1000),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  search.mockResolvedValue([entry(2, 'https://b.example/', 'B', 2000)]);
  remove.mockResolvedValue(undefined);
  clear.mockResolvedValue(undefined);
  onChanged.mockReturnValue(() => {});
});

describe('useHistory', () => {
  it('seeds entries from aegis.history.list on mount', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.entries[0].title).toBe('B');
  });

  it('exposes the query and setQuery for the search box', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    act(() => result.current.setQuery('b'));
    expect(result.current.query).toBe('b');
  });

  it('search(q) with a non-empty query calls aegis.history.search and replaces entries', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    await act(async () => {
      result.current.setQuery('b');
      await result.current.search();
    });
    expect(search).toHaveBeenCalledWith('b');
    expect(result.current.entries).toHaveLength(1);
    expect(result.current.entries[0].url).toBe('https://b.example/');
  });

  it('search() with an empty/whitespace query re-lists instead of searching', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    await act(async () => {
      result.current.setQuery('   ');
      await result.current.search();
    });
    expect(search).not.toHaveBeenCalled();
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('remove(id) calls aegis.history.remove then re-lists', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    list.mockResolvedValue([entry(2, 'https://b.example/', 'B', 2000)]);
    await act(async () => result.current.remove(1));
    expect(remove).toHaveBeenCalledWith(1);
    await waitFor(() => expect(result.current.entries).toHaveLength(1));
  });

  it('clear() calls aegis.history.clear then re-lists', async () => {
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    list.mockClear();
    list.mockResolvedValue([]);
    await act(async () => result.current.clear());
    expect(clear).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(result.current.entries).toHaveLength(0));
  });

  it('re-fetches when aegis.history.onChanged fires (respecting the active query)', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    list.mockClear();
    list.mockResolvedValue([entry(3, 'https://c.example/', 'C', 3000), ...seed]);
    act(() => pushed!());
    await waitFor(() => expect(result.current.entries).toHaveLength(3));
    expect(list).toHaveBeenCalledTimes(1);
  });

  it('onChanged re-runs the active search when a query is set', async () => {
    let pushed: (() => void) | undefined;
    onChanged.mockImplementation((cb: () => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useHistory());
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    await act(async () => {
      result.current.setQuery('b');
      await result.current.search();
    });
    search.mockClear();
    list.mockClear();
    act(() => pushed!());
    await waitFor(() => expect(search).toHaveBeenCalledWith('b'));
    expect(list).not.toHaveBeenCalled();
  });

  it('unsubscribes from onChanged on unmount', async () => {
    const unsubscribe = vi.fn();
    onChanged.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useHistory());
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
