// src/hooks/useFingerprint.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { FingerprintState } from '../../shared/types';

const getState = vi.fn();
const toggleAllowlist = vi.fn();
const removeAllowlist = vi.fn();
const clearAllowlist = vi.fn();

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

  it('cleans up (active flag) on unmount without error', async () => {
    const { unmount } = renderHook(() => useFingerprint());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    unmount();
    // No assertion needed — just verify no crash / stale setState after unmount.
  });
});
