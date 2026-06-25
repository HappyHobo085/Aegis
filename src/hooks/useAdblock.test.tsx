// src/hooks/useAdblock.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { AdblockState, BlockedCount } from '../../shared/types';

const getState = vi.fn();
const setEnabled = vi.fn();
const toggleAllowlist = vi.fn();
const onBlockedCount = vi.fn();
const removeAllowlist = vi.fn();
const clearAllowlist = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    adblock: {
      getState: (...a: any[]) => getState(...a),
      setEnabled: (...a: any[]) => setEnabled(...a),
      toggleAllowlist: (...a: any[]) => toggleAllowlist(...a),
      onBlockedCount: (cb: (c: BlockedCount) => void) => onBlockedCount(cb),
      removeAllowlist: (...a: any[]) => removeAllowlist(...a),
      clearAllowlist: (...a: any[]) => clearAllowlist(...a),
    },
  },
}));

import { useAdblock } from './useAdblock';

const baseState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  setEnabled.mockResolvedValue({ ...baseState, enabled: false });
  toggleAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['example.com'] });
  onBlockedCount.mockReturnValue(() => {});
  removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
  clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
});

describe('useAdblock', () => {
  it('seeds state from aegis.adblock.getState on mount', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    expect(getState).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });

  it('subscribes to onBlockedCount and updates page for the matching viewId', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID, page: 7, session: 42 }));
    expect(result.current.page).toBe(7);
  });

  it('ignores onBlockedCount events for a different viewId', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID + 1, page: 7, session: 42 }));
    expect(result.current.page).toBe(0);
  });

  it('mirrors session count from onBlockedCount into state.sessionBlocked', async () => {
    let pushed: ((c: BlockedCount) => void) | undefined;
    onBlockedCount.mockImplementation((cb: (c: BlockedCount) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ viewId: PRIMARY_VIEW_ID, page: 3, session: 99 }));
    expect(result.current.state.sessionBlocked).toBe(99);
  });

  it('setEnabled calls aegis and syncs state from the returned AdblockState', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.setEnabled(false));
    expect(setEnabled).toHaveBeenCalledWith(false);
    expect(result.current.state.enabled).toBe(false);
  });

  it('toggleAllowlist derives the host from currentUrl and syncs returned state', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/page'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.toggleAllowlist());
    expect(toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(result.current.state.allowlistedHosts).toEqual(['example.com']);
  });

  it('toggleAllowlist is a no-op when currentUrl has no parseable host', async () => {
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, ''));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.toggleAllowlist());
    expect(toggleAllowlist).not.toHaveBeenCalled();
  });

  it('unsubscribes from onBlockedCount on unmount', async () => {
    const unsubscribe = vi.fn();
    onBlockedCount.mockReturnValue(unsubscribe);
    const { unmount } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(onBlockedCount).toHaveBeenCalled());
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('removeAllowlist calls aegis with the host and syncs returned state', async () => {
    removeAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: ['kept.com'] });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.removeAllowlist('drop.com'));
    expect(removeAllowlist).toHaveBeenCalledWith('drop.com');
    expect(result.current.state.allowlistedHosts).toEqual(['kept.com']);
  });

  it('clearAllowlist calls aegis and syncs returned (emptied) state', async () => {
    clearAllowlist.mockResolvedValue({ ...baseState, allowlistedHosts: [] });
    const { result } = renderHook(() => useAdblock(PRIMARY_VIEW_ID, 'https://example.com/'));
    await waitFor(() => expect(result.current.state.enabled).toBe(true));
    await act(async () => result.current.clearAllowlist());
    expect(clearAllowlist).toHaveBeenCalledTimes(1);
    expect(result.current.state.allowlistedHosts).toEqual([]);
  });
});
