// src/hooks/useVault.test.ts
// TDD: tests written first — mirror useUpdate.test.tsx's structure.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { VaultState, VaultRecord, VaultRecordInput } from '../../shared/types';

// ---- mock ipcClient (vault namespace only) ----
const getState = vi.fn();
const create = vi.fn();
const unlock = vi.fn();
const lock = vi.fn();
const list = vi.fn();
const add = vi.fn();
const update = vi.fn();
const remove = vi.fn();
const search = vi.fn();
const onState = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    vault: {
      getState: (...a: unknown[]) => getState(...a),
      create: (...a: unknown[]) => create(...a),
      unlock: (...a: unknown[]) => unlock(...a),
      lock: (...a: unknown[]) => lock(...a),
      list: (...a: unknown[]) => list(...a),
      add: (...a: unknown[]) => add(...a),
      update: (...a: unknown[]) => update(...a),
      remove: (...a: unknown[]) => remove(...a),
      search: (...a: unknown[]) => search(...a),
      onState: (cb: (s: VaultState) => void) => onState(cb),
    },
  },
}));

import { useVault } from './useVault';

// ---- helpers ----
const vs = (over: Partial<VaultState> = {}): VaultState => ({
  exists: false,
  unlocked: false,
  count: 0,
  undecryptable: 0,
  ...over,
});

const rec = (over: Partial<VaultRecord> = {}): VaultRecord => ({
  uuid: 'abc-123',
  updatedAt: 1000,
  site: 'example.com',
  username: 'user',
  password: 's3cret',
  notes: '',
  ...over,
});

const input: VaultRecordInput = { site: 'example.com', username: 'user', password: 's3cret' };

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(vs());
  create.mockResolvedValue(vs({ exists: true, unlocked: true }));
  unlock.mockResolvedValue(vs({ exists: true, unlocked: true }));
  lock.mockResolvedValue(vs({ exists: true, unlocked: false }));
  list.mockResolvedValue([]);
  add.mockResolvedValue([rec()]);
  update.mockResolvedValue([rec({ site: 'updated.com' })]);
  remove.mockResolvedValue([]);
  search.mockResolvedValue([rec()]);
  onState.mockReturnValue(() => {});
});

describe('useVault', () => {
  // ---- mount behaviour ----
  it('seeds state from aegis.vault.getState on mount', async () => {
    getState.mockResolvedValue(vs({ exists: true }));
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.state.exists).toBe(true));
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('subscribes to aegis.vault.onState on mount', async () => {
    renderHook(() => useVault());
    await waitFor(() => expect(onState).toHaveBeenCalledTimes(1));
  });

  it('starts with the EMPTY state before getState resolves', () => {
    // Don't await — inspect synchronous initial render
    getState.mockReturnValue(new Promise(() => {})); // never resolves
    const { result } = renderHook(() => useVault());
    expect(result.current.state).toEqual(vs());
  });

  it('updates state when onState event fires', async () => {
    let pushed: ((s: VaultState) => void) | undefined;
    onState.mockImplementation((cb: (s: VaultState) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.state.exists).toBe(false));
    await act(async () => {
      pushed!(vs({ exists: true, unlocked: true, count: 3 }));
    });
    expect(result.current.state).toMatchObject({ exists: true, unlocked: true, count: 3 });
  });

  it('unsubscribes on unmount', async () => {
    const unsubscribe = vi.fn();
    onState.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useVault());
    await waitFor(() => expect(onState).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  // ---- create ----
  it('create() calls aegis.vault.create and updates state to unlocked', async () => {
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await act(async () => {
      await result.current.create('masterpassword');
    });
    expect(create).toHaveBeenCalledWith('masterpassword');
    expect(result.current.state).toMatchObject({ exists: true, unlocked: true });
  });

  // ---- unlock ----
  it('unlock(correct) sets state to unlocked', async () => {
    unlock.mockResolvedValue(vs({ exists: true, unlocked: true, count: 2 }));
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await act(async () => {
      await result.current.unlock('correctpassword');
    });
    expect(unlock).toHaveBeenCalledWith('correctpassword');
    expect(result.current.state).toMatchObject({ exists: true, unlocked: true, count: 2 });
  });

  it('unlock(wrong) surfaces the error and state stays locked', async () => {
    unlock.mockRejectedValue(new Error('wrong password'));
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    await expect(
      act(async () => {
        await result.current.unlock('wrongpassword');
      }),
    ).rejects.toThrow('wrong password');
    // state remains locked (getState returned the initial vs())
    expect(result.current.state.unlocked).toBe(false);
  });

  // ---- lock ----
  it('lock() sets state to locked', async () => {
    // start unlocked
    getState.mockResolvedValue(vs({ exists: true, unlocked: true }));
    lock.mockResolvedValue(vs({ exists: true, unlocked: false }));
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(result.current.state.unlocked).toBe(true));
    await act(async () => {
      await result.current.lock();
    });
    expect(lock).toHaveBeenCalledTimes(1);
    expect(result.current.state.unlocked).toBe(false);
  });

  // ---- list ----
  it('list() delegates to aegis.vault.list and returns records', async () => {
    list.mockResolvedValue([rec()]);
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    let records: VaultRecord[] = [];
    await act(async () => {
      records = await result.current.list();
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(records).toHaveLength(1);
    expect(records[0].uuid).toBe('abc-123');
  });

  // ---- add ----
  it('add() calls aegis.vault.add with the input and returns the updated list', async () => {
    add.mockResolvedValue([rec()]);
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    let records: VaultRecord[] = [];
    await act(async () => {
      records = await result.current.add(input);
    });
    expect(add).toHaveBeenCalledWith(input);
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe('example.com');
  });

  // ---- update ----
  it('update() calls aegis.vault.update with uuid + partial fields', async () => {
    const partial = { site: 'updated.com' };
    update.mockResolvedValue([rec({ site: 'updated.com' })]);
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    let records: VaultRecord[] = [];
    await act(async () => {
      records = await result.current.update('abc-123', partial);
    });
    expect(update).toHaveBeenCalledWith('abc-123', partial);
    expect(records[0].site).toBe('updated.com');
  });

  // ---- remove ----
  it('remove() calls aegis.vault.remove and returns the updated list', async () => {
    remove.mockResolvedValue([]);
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    let records: VaultRecord[] = [];
    await act(async () => {
      records = await result.current.remove('abc-123');
    });
    expect(remove).toHaveBeenCalledWith('abc-123');
    expect(records).toHaveLength(0);
  });

  // ---- search ----
  it('search() calls aegis.vault.search and returns filtered records', async () => {
    search.mockResolvedValue([rec()]);
    const { result } = renderHook(() => useVault());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    let records: VaultRecord[] = [];
    await act(async () => {
      records = await result.current.search('example');
    });
    expect(search).toHaveBeenCalledWith('example');
    expect(records).toHaveLength(1);
    expect(records[0].site).toBe('example.com');
  });
});
