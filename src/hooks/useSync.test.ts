// src/hooks/useSync.test.ts
//
// `useSync` owns the highest-sensitivity state machine in the app (E2E keys, the 24-word
// recovery phrase, the account/device list), and it is the only domain hook with no test
// file. Two bugs it had:
//
//   * F2 — the seed fetch was dispatched BEFORE the `sync.state` subscription, so a
//     transition emitted in that window was lost. For this hook the consequence is concrete:
//     `enableNew` returned only the phrase, adopted NO state of its own, and relied entirely
//     on the event, so a lost event stranded the user in the setup view.
//   * F9 — the mutating actions were plain last-resolved-wins with no in-flight guard.
//
// `subscribeBeforeFetch.test.tsx` covers the ordering property for every seeding hook; this
// file covers the hook's own contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SyncDevice, SyncState } from '../../shared/types';
import { onSyncChange } from '../lib/syncBus';

const DISABLED: SyncState = {
  enabled: false,
  status: 'disabled',
  serverUrl: '',
  lastSyncMs: 0,
  lastError: '',
  deviceId: '',
  accountId: '',
  vaultBacking: 'none',
  hasStoredRoot: false,
};

const ENABLED: SyncState = {
  ...DISABLED,
  enabled: true,
  status: 'idle',
  serverUrl: 'https://sync.example',
  deviceId: 'dev-1',
  accountId: 'acct-1',
  vaultBacking: 'keychain',
  hasStoredRoot: true,
};

const PHRASE = 'one two three four five six seven eight nine ten eleven twelve thirteen fourteen';

const stateCallbacks: Array<(s: SyncState) => void> = [];
const changedCallbacks: Array<(c: { namespace: string; changedUuids: string[] }) => void> = [];

const mockSync = {
  getState: vi.fn(),
  enableNew: vi.fn(),
  enableFromPhrase: vi.fn(),
  unlock: vi.fn(),
  disable: vi.fn(),
  syncNow: vi.fn(),
  testConnection: vi.fn(),
  getRecoveryPhrase: vi.fn(),
  listDevices: vi.fn(),
  removeDevice: vi.fn(),
  onState: vi.fn(),
  onChanged: vi.fn(),
  onVaultQuarantined: vi.fn(),
};

vi.mock('../lib/ipcClient', () => ({ aegis: { sync: mockSync } }));

// import after the mock is registered
const { useSync } = await import('./useSync');

/** A promise plus its resolver, so a test can hold an IPC reply open. */
function deferred<T>(): { promise: Promise<T>; resolve(v: T): void; reject(e: unknown): void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    stateCallbacks.length = 0;
    changedCallbacks.length = 0;
    mockSync.getState.mockResolvedValue(DISABLED);
    mockSync.enableNew.mockResolvedValue({ recoveryPhrase: PHRASE });
    mockSync.enableFromPhrase.mockResolvedValue(ENABLED);
    mockSync.unlock.mockResolvedValue(ENABLED);
    mockSync.disable.mockResolvedValue(DISABLED);
    mockSync.syncNow.mockResolvedValue({ ...ENABLED, lastSyncMs: 1234 });
    mockSync.testConnection.mockResolvedValue({ ok: true, latencyMs: 7 });
    mockSync.getRecoveryPhrase.mockResolvedValue({ recoveryPhrase: PHRASE });
    mockSync.listDevices.mockResolvedValue([] as SyncDevice[]);
    mockSync.removeDevice.mockResolvedValue([] as SyncDevice[]);
    mockSync.onState.mockImplementation((cb: (s: SyncState) => void) => {
      stateCallbacks.push(cb);
      return () => {
        const i = stateCallbacks.indexOf(cb);
        if (i !== -1) stateCallbacks.splice(i, 1);
      };
    });
    mockSync.onChanged.mockImplementation(
      (cb: (c: { namespace: string; changedUuids: string[] }) => void) => {
        changedCallbacks.push(cb);
        return () => {
          const i = changedCallbacks.indexOf(cb);
          if (i !== -1) changedCallbacks.splice(i, 1);
        };
      },
    );
  });

  // ── seeding + subscription ────────────────────────────────────────────────

  it('seeds from sync.getState on mount and unsubscribes on unmount', async () => {
    const { result, unmount } = renderHook(() => useSync());
    await act(async () => {});
    expect(mockSync.getState).toHaveBeenCalledTimes(1);
    expect(result.current.state).toEqual(DISABLED);
    expect(stateCallbacks).toHaveLength(1);
    unmount();
    expect(stateCallbacks).toHaveLength(0);
    expect(changedCallbacks).toHaveLength(0);
  });

  it('subscribes BEFORE it fetches, so no transition can be lost (F2)', async () => {
    // Record the dispatch order at call time, which is what decides the order the core
    // processes the two requests in.
    const order: string[] = [];
    mockSync.onState.mockImplementation((cb: (s: SyncState) => void) => {
      order.push('listen');
      stateCallbacks.push(cb);
      return () => {};
    });
    mockSync.getState.mockImplementation(() => {
      order.push('getState');
      return Promise.resolve(DISABLED);
    });
    renderHook(() => useSync());
    await act(async () => {});
    expect(order[0]).toBe('listen');
  });

  it('applies a sync.state event', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    act(() => {
      stateCallbacks.forEach((cb) => cb(ENABLED));
    });
    expect(result.current.state.enabled).toBe(true);
  });

  it('relays a sync.changed event to the per-store bus', async () => {
    const seen: string[] = [];
    const off = onSyncChange('favorites', (uuids) => seen.push(uuids.join(',')));
    renderHook(() => useSync());
    await act(async () => {});
    act(() => {
      changedCallbacks.forEach((cb) => cb({ namespace: 'favorites', changedUuids: ['a', 'b'] }));
    });
    expect(seen).toEqual(['a,b']);
    off();
  });

  // ── enableNew ─────────────────────────────────────────────────────────────

  it('enableNew returns the recovery phrase and leaves the setup view', async () => {
    // The mount seed says "disabled"; the core says "enabled" from the next call on, which
    // is what the engine reports once `enableNew` has committed.
    mockSync.getState.mockImplementationOnce(() => Promise.resolve(DISABLED));
    mockSync.getState.mockImplementation(() => Promise.resolve(ENABLED));

    const { result } = renderHook(() => useSync());
    await act(async () => {});
    expect(result.current.state.enabled).toBe(false);

    let phrase = '';
    await act(async () => {
      phrase = await result.current.enableNew();
    });
    expect(phrase).toBe(PHRASE);
    expect(result.current.state.enabled).toBe(true);
  });

  it('enableNew re-seeds from the core so a MISSED sync.state event cannot strand the UI (F9)', async () => {
    // The failure mode this pins: `enableNew` returns only the phrase, so before the fix it
    // adopted no state at all and depended entirely on the `sync.state` event. Here that
    // event NEVER arrives (the exact F2 loss) — the UI must still leave the setup view.
    mockSync.getState.mockImplementationOnce(() => Promise.resolve(DISABLED));
    mockSync.getState.mockImplementation(() => Promise.resolve(ENABLED));

    const { result } = renderHook(() => useSync());
    await act(async () => {});
    // No stateCallbacks fire at all.
    await act(async () => {
      await result.current.enableNew();
    });
    expect(result.current.state.enabled).toBe(true);
    expect(result.current.state.serverUrl).toBe('https://sync.example');
  });

  it('enableNew forwards an explicit passphrase and omits it otherwise', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    await act(async () => {
      await result.current.enableNew('hunter2');
    });
    expect(mockSync.enableNew).toHaveBeenCalledWith({ passphrase: 'hunter2' });
    await act(async () => {
      await result.current.enableNew();
    });
    expect(mockSync.enableNew).toHaveBeenLastCalledWith(undefined);
  });

  // ── the other actions ─────────────────────────────────────────────────────

  it('enableFromPhrase adopts the returned state', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    await act(async () => {
      await result.current.enableFromPhrase(PHRASE, 'hunter2');
    });
    expect(mockSync.enableFromPhrase).toHaveBeenCalledWith({
      phrase: PHRASE,
      passphrase: 'hunter2',
    });
    expect(result.current.state.enabled).toBe(true);
  });

  it('unlock adopts the returned state', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    await act(async () => {
      await result.current.unlock('hunter2');
    });
    expect(mockSync.unlock).toHaveBeenCalledWith({ passphrase: 'hunter2' });
    expect(result.current.state.status).toBe('idle');
  });

  it('disable adopts the returned state and forwards forget', async () => {
    mockSync.getState.mockResolvedValue(ENABLED);
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    expect(result.current.state.enabled).toBe(true);
    await act(async () => {
      await result.current.disable(true);
    });
    expect(mockSync.disable).toHaveBeenCalledWith({ forget: true });
    expect(result.current.state.enabled).toBe(false);
  });

  it('syncNow adopts the returned state', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    await act(async () => {
      await result.current.syncNow();
    });
    expect(result.current.state.lastSyncMs).toBe(1234);
  });

  it('testConnection is a pass-through and does not touch state', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    let probe: { ok: boolean; latencyMs?: number } | undefined;
    await act(async () => {
      probe = await result.current.testConnection('https://sync.example');
    });
    expect(mockSync.testConnection).toHaveBeenCalledWith('https://sync.example');
    expect(probe).toEqual({ ok: true, latencyMs: 7 });
    expect(result.current.state).toEqual(DISABLED);
  });

  // ── getRecoveryPhrase: the confirm gate (F8) ───────────────────────────────

  it('getRecoveryPhrase refuses without an explicit confirmation and never calls the core', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    // BUG(F8): the hook used to hardcode `{ confirm: true }`, which made the core's
    // "gated on an explicit confirm" contract a bypass.
    await expect(result.current.getRecoveryPhrase(false)).rejects.toThrow(/confirmation/i);
    expect(mockSync.getRecoveryPhrase).not.toHaveBeenCalled();
  });

  it('getRecoveryPhrase sends confirm: true once the caller confirms', async () => {
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    let phrase = '';
    await act(async () => {
      phrase = await result.current.getRecoveryPhrase(true);
    });
    expect(mockSync.getRecoveryPhrase).toHaveBeenCalledWith({ confirm: true });
    expect(phrase).toBe(PHRASE);
  });

  // ── in-flight guard (F9) ──────────────────────────────────────────────────

  it('a superseded action cannot win the state (in-flight guard)', async () => {
    // `unlock` is slow, `disable` is fast. Without a guard the late `unlock` reply would
    // overwrite the newer `disable` and advertise a state the core has already left.
    const slowUnlock = deferred<SyncState>();
    mockSync.unlock.mockReturnValueOnce(slowUnlock.promise);
    mockSync.disable.mockResolvedValue(DISABLED);

    const { result } = renderHook(() => useSync());
    await act(async () => {});

    let unlocking: Promise<void> | undefined;
    await act(async () => {
      unlocking = result.current.unlock('hunter2');
      // Let the unlock request reach the core before the disable goes out.
      await Promise.resolve();
    });
    await act(async () => {
      await result.current.disable(true);
    });
    expect(result.current.state.enabled).toBe(false);

    slowUnlock.resolve(ENABLED);
    await act(async () => {
      await unlocking;
    });
    // Still disabled: the older ticket lost.
    expect(result.current.state.enabled).toBe(false);
    expect(result.current.state.status).toBe('disabled');
  });

  it('the newest action does win when it is the one still in flight', async () => {
    mockSync.unlock.mockResolvedValue(ENABLED);
    const { result } = renderHook(() => useSync());
    await act(async () => {});
    await act(async () => {
      await result.current.unlock('hunter2');
    });
    expect(result.current.state.enabled).toBe(true);
  });
});
