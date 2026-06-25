import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { FingerprintState } from '../../shared/types';

const getState = vi.fn();
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    fingerprint: {
      getState: (...a: any[]) => getState(...a),
      toggleAllowlist: vi.fn(),
      removeAllowlist: vi.fn(),
      clearAllowlist: vi.fn(),
    },
  },
}));

import { useFingerprint } from './useFingerprint';
import { publishSyncChange } from '../lib/syncBus';

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue({ level: 'standard', allowlistedHosts: ['a.com'] } as FingerprintState);
});

describe('useFingerprint', () => {
  it('seeds state from getState on mount', async () => {
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.allowlistedHosts).toEqual(['a.com']));
    expect(getState).toHaveBeenCalledTimes(1);
  });

  it('refetches when a synced fp-allowlist change is published', async () => {
    const { result } = renderHook(() => useFingerprint());
    await waitFor(() => expect(result.current.state.allowlistedHosts).toEqual(['a.com']));
    // A peer-merged change arrives for the fp-allowlist namespace.
    getState.mockResolvedValue({
      level: 'standard',
      allowlistedHosts: ['a.com', 'synced.com'],
    } as FingerprintState);
    act(() => publishSyncChange('fp-allowlist', []));
    await waitFor(() =>
      expect(result.current.state.allowlistedHosts).toEqual(['a.com', 'synced.com']),
    );
    expect(getState).toHaveBeenCalledTimes(2);
  });

  it('ignores sync changes for other namespaces', async () => {
    renderHook(() => useFingerprint());
    await waitFor(() => expect(getState).toHaveBeenCalledTimes(1));
    act(() => publishSyncChange('favorites', []));
    expect(getState).toHaveBeenCalledTimes(1);
  });
});
