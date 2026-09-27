// src/hooks/useSubscriptions.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { Subscription, ListUpdateResult } from '../../shared/types';

const list = vi.fn();
const setEnabled = vi.fn();
const add = vi.fn();
const remove = vi.fn();
const updateNow = vi.fn();
const onUpdateResult = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    subs: {
      list: (...a: any[]) => list(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      add: (...a: any[]) => add(...a),
      remove: (...a: any[]) => remove(...a),
      onChanged: (...a: any[]) => onChanged(...a),
    },
    lists: {
      updateNow: (...a: any[]) => updateNow(...a),
      onUpdateResult: (...a: any[]) => onUpdateResult(...a),
    },
  },
}));

/** Resolve the most recent onUpdateResult subscriber with `r` (simulate the core event). */
function emitUpdateResult(r: ListUpdateResult): void {
  const cb = onUpdateResult.mock.calls.at(-1)?.[0] as (result: ListUpdateResult) => void;
  cb(r);
}

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
  updateNow.mockResolvedValue(undefined);
  onUpdateResult.mockReturnValue(() => {});
  onChanged.mockReturnValue(() => {});
});

/** Fire `subs.changed` the way `subs.rs:196` does, after the hook subscribed. */
function emitSubsChanged(): void {
  const cb = onChanged.mock.calls.at(-1)?.[0] as (() => void) | undefined;
  if (!cb) throw new Error('useSubscriptions never subscribed to subs.changed');
  cb();
}

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

  it('updateNow() starts the update and resolves with the result delivered via the event', async () => {
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    let res: ListUpdateResult | undefined;
    await act(async () => {
      const p = result.current.updateNow();
      // The hook kicked off the (non-blocking) core update and subscribed for the result;
      // deliver it via the event → the promise resolves.
      emitUpdateResult({ perSource: [], lastUpdated: 123 });
      res = await p;
    });
    expect(updateNow).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ perSource: [], lastUpdated: 123 });
  });

  it('refreshes the subscription list after the update result arrives', async () => {
    const refreshed = seed.map((s) => sub({ ...s, lastUpdated: 9999 }));
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      const p = result.current.updateNow();
      emitUpdateResult({ perSource: [], lastUpdated: 123 });
      await p;
    });
    expect(list).toHaveBeenCalledTimes(2);
    expect(result.current.subs.every((s) => s.lastUpdated === 9999)).toBe(true);
  });

  // ---- subs.changed (added 2026-09-27) ----
  //
  // Until then this hook had NO `on(...)` subscription at all, which is why the core's
  // `subs.changed` event reached nobody. `subs.add` and `subs.setEnabled` return the
  // store as it is BEFORE their background fetch runs (`subs.rs:172` returns
  // `jsonstore::live(items)` immediately, with `lastUpdated: null` for a new row at
  // `subs.rs:338-343`); the core then rewrites the row on a spawned thread up to 25s
  // later and emits at `subs.rs:196`. So the hook's copy was stale by design, forever.

  it('subscribes to subs.changed on mount', () => {
    renderHook(() => useSubscriptions());
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('re-reads the list when subs.changed fires (a background fetch finished)', async () => {
    const refreshed = seed.map((s) => sub({ ...s, lastUpdated: 9999, hash: 'abc' }));
    list.mockResolvedValueOnce(seed).mockResolvedValue(refreshed);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    expect(list).toHaveBeenCalledTimes(1);

    await act(async () => {
      emitSubsChanged();
    });

    await waitFor(() =>
      expect(result.current.subs.every((s) => s.lastUpdated === 9999)).toBe(true),
    );
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('add() can land a row whose lastUpdated is still null, and subs.changed repairs it', async () => {
    // `subs.rs:338-343` deliberately returns the PRE-fetch row, so a brand-new
    // subscription comes back with `lastUpdated: null`. That intermediate state is the
    // defect; the event is the repair. Both halves are asserted, because a test that only
    // checked the final state would pass against code that never went stale.
    const pending = [
      ...seed,
      sub({ listId: 'custom', url: 'https://lists.example/custom.txt', lastUpdated: null }),
    ];
    add.mockResolvedValue(pending);
    const { result } = renderHook(() => useSubscriptions());
    await waitFor(() => expect(result.current.subs).toHaveLength(2));
    await act(async () => {
      await result.current.add('https://lists.example/custom.txt');
    });
    expect(result.current.subs[2].lastUpdated).toBeNull();

    const repaired = pending.map((s) =>
      s.listId === 'custom' ? sub({ ...s, lastUpdated: 42 }) : s,
    );
    list.mockResolvedValue(repaired);
    await act(async () => {
      emitSubsChanged();
    });
    await waitFor(() => expect(result.current.subs[2].lastUpdated).toBe(42));
  });

  it('unsubscribes from subs.changed on unmount', () => {
    const off = vi.fn();
    onChanged.mockReturnValueOnce(off);
    const { unmount } = renderHook(() => useSubscriptions());
    expect(onChanged).toHaveBeenCalledTimes(1);
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });
});
