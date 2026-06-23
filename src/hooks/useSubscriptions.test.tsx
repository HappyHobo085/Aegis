// src/hooks/useSubscriptions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Subscription, ListUpdateResult } from '../../shared/types';

const list = vi.fn();
const setEnabled = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const updateNow = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    subs: {
      list: (...a: any[]) => list(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
    },
    lists: { updateNow: (...a: any[]) => updateNow(...a) },
  },
}));

import { useSubscriptions } from './useSubscriptions';

const sub = (over: Partial<Subscription> = {}): Subscription => ({
  listId: 'easylist',
  url: 'https://example.com/easylist.txt',
  enabled: true,
  lastUpdated: 1000,
  etag: null,
  hash: null,
  ...over,
});

const seed: Subscription[] = [
  sub({ listId: 'easylist', url: 'https://example.com/easylist.txt', enabled: true }),
  sub({ listId: 'easyprivacy', url: 'https://example.com/easyprivacy.txt', enabled: false }),
];

beforeEach(() => {
  vi.clearAllMocks();
  list.mockResolvedValue(seed);
  setEnabled.mockResolvedValue(seed);
  add.mockResolvedValue(seed);
  remove.mockResolvedValue(seed);
  updateNow.mockResolvedValue({ perSource: [], lastUpdated: 123 } as ListUpdateResult);
});

describe('useSubscriptions', () => {
  it('seeds subs from aegis.subs.list on mount', async () => {
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.subs.map((s) => s.listId)).toEqual(['easylist', 'easyprivacy']);
  });

  it('setEnabled() calls aegis with id + enabled and refreshes from the result', async () => {
    const flipped = [
      seed[0],
      sub({ listId: 'easyprivacy', url: 'https://example.com/easyprivacy.txt', enabled: true }),
    ];
    setEnabled.mockResolvedValue(flipped);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.setEnabled('easyprivacy', true);
    });
    expect(setEnabled).toHaveBeenCalledWith('easyprivacy', true);
    expect(result.current.subs[1].enabled).toBe(true);
  });

  it('add() calls aegis with the url and refreshes from the result', async () => {
    const added = [
      ...seed,
      sub({ listId: 'custom', url: 'https://lists.example/custom.txt', enabled: true }),
    ];
    add.mockResolvedValue(added);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.add('https://lists.example/custom.txt');
    });
    expect(add).toHaveBeenCalledWith('https://lists.example/custom.txt');
    expect(result.current.subs).toHaveLength(3);
    expect(result.current.subs[2].listId).toBe('custom');
  });

  it('remove() calls aegis with the listId and refreshes from the result', async () => {
    remove.mockResolvedValue([seed[0]]);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.remove('easyprivacy');
    });
    expect(remove).toHaveBeenCalledWith('easyprivacy');
    expect(result.current.subs.map((s) => s.listId)).toEqual(['easylist']);
  });

  it('updateNow() delegates to aegis.lists.updateNow and returns its result', async () => {
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    let res: ListUpdateResult | undefined;
    await act(async () => {
      res = await result.current.updateNow();
    });
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ perSource: [], lastUpdated: 123 });
  });

  it('refreshes the subscription list after updateNow', async () => {
    const refreshed = seed.map((s) => sub({ ...s, lastUpdated: 9999 }));
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.updateNow();
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.subs.every((s) => s.lastUpdated === 9999)).toBe(true);
  });
});
