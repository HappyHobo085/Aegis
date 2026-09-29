// src/hooks/useFingerprint.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FingerprintState } from '../../shared/types';

const getState = vi.fn();
const toggleAllowlist = vi.fn();
const removeAllowlist = vi.fn();
const clearAllowlist = vi.fn();
// The real `onSyncChange` returns a closure that deletes the listener from a module-local
// Set. Nothing outside the module can see that, so without this mock the hook's
// unsubscribe is unreachable and the teardown below could not assert anything.
const unsubscribeSync = vi.fn();
// A REST parameter, not a fixed one: `vi.fn((ns, fn) => …)` infers a two-argument mock, and
// the mock factory below then cannot spread its `any[]` into it (TS2556). A rest parameter
// keeps the call site honest without breaking the factory.
const onSyncChange = vi.fn((..._a: unknown[]) => unsubscribeSync);

vi.mock('../lib/syncBus', () => ({
  onSyncChange: (...a: any[]) => onSyncChange(...a),
}));

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    fingerprint: {
      getState: (...a: any[]) => getState(...a),
      toggleAllowlist: (...a: any[]) => toggleAllowlist(...a),
      removeAllowlist: (...a: any[]) => removeAllowlist(...a),
      clearAllowlist: (...a: any[]) => clearAllowlist(...a),
    },
  },
}));

import { useFingerprint } from './useFingerprint';

const baseState: FingerprintState = {
  level: 'off',
  allowlistedHosts: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  toggleAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['foo.com'] });
  removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
  clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
  onSyncChange.mockReturnValue(unsubscribeSync);
});

describe('useFingerprint', () => {
  it('seeds state from aegis.fingerprint.getState on mount', async () => {
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.level).toBe('off'));
    expect(getState).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });

  it('toggleAllowlist calls aegis with the host and syncs returned state', async () => {
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.level).toBe('off'));
    await act(async () => result.current.toggleAllowlist('foo.com'));
    expect(toggleAllowlist).toHaveBeenCalledWith('foo.com');
    expect(result.current.state.allowlistedHosts).toEqual(['foo.com']);
  });

  it('removeAllowlist calls aegis with the host and syncs returned state', async () => {
    removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['kept.com'] });
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.level).toBe('off'));
    await act(async () => result.current.removeAllowlist('drop.com'));
    expect(removeAllowlist).toHaveBeenCalledWith('drop.com');
    expect(result.current.state.allowlistedHosts).toEqual(['kept.com']);
  });

  it('clearAllowlist calls aegis and syncs returned (emptied) state', async () => {
    clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.level).toBe('off'));
    await act(async () => result.current.clearAllowlist());
    expect(clearAllowlist).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });

  it('subscribes to the fp-allowlist sync channel, and unsubscribes on unmount', async () => {
    const { unmount } = renderHook(() => useFingerprint());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    // The fp-allowlist is a syncable store, so a peer merge has to refresh this tab live.
    // Both halves are asserted: a hook that never subscribed would leave a leaked
    // listener, and a hook that never unsubscribed would refresh a closed tab forever.
    expect(onSyncChange).toHaveBeenCalledWith('fp-allowlist', expect.any(Function));
    expect(unsubscribeSync).not.toHaveBeenCalled();

    unmount();
    expect(unsubscribeSync).toHaveBeenCalledTimes(1);
  });

  it('reloads from the sync channel when a peer merges the allowlist', async () => {
    let notify: (() => void) | null = null;
    onSyncChange.mockImplementation((..._a: unknown[]) => {
      notify = _a[1] as () => void;
      return unsubscribeSync;
    });
    getState
      .mockResolvedValueOnce({ ...baseState, allowlistedHosts: [] })
      .mockResolvedValueOnce({ ...baseState, allowlistedHosts: ['peer.example'] });

    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    expect(result.current.state.allowlistedHosts).toEqual([]);

    act(() => notify?.());
    await waitFor(() => expect(result.current.state.allowlistedHosts).toEqual(['peer.example']));
  });
});
