// src/hooks/useSafety.test.tsx
//
// The malware-interstitial hook. Two things matter: the `active` flag must stop a
// late `getState()` from setting state after unmount, and the unsubscribe must run —
// a leaked `safety.interstitial` listener would keep a dead component's setState
// reachable for the life of the app.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import type { SafetyInterstitialPayload } from '../../shared/types';

const getState = vi.fn();
const onInterstitial = vi.fn();
const proceed = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    safety: {
      getState: (...a: any[]) => getState(...a),
      onInterstitial: (...a: any[]) => onInterstitial(...a),
      proceed: (...a: any[]) => proceed(...a),
    },
  },
}));

import { useSafety } from './useSafety';

const payload = (over: Partial<SafetyInterstitialPayload> = {}): SafetyInterstitialPayload => ({
  url: 'https://malware.test/',
  reason: 'malware',
  ...over,
});

const urlOf = (result: { current: { interstitial: SafetyInterstitialPayload | null } }) =>
  result.current.interstitial?.url;

beforeEach(() => {
  // mockReset (not clearAllMocks) so an unconsumed "once" value cannot leak forward.
  getState.mockReset().mockResolvedValue(null);
  onInterstitial.mockReset();
  proceed.mockReset().mockResolvedValue(undefined);
  onInterstitial.mockReturnValue(() => {});
});

describe('useSafety', () => {
  it('starts with no interstitial', () => {
    const { result } = renderHook(() => useSafety());
    expect(result.current.interstitial).toBeNull();
  });

  it('subscribes to interstitial events on mount', () => {
    renderHook(() => useSafety());
    expect(onInterstitial).toHaveBeenCalledTimes(1);
    expect(onInterstitial.mock.calls[0][0]).toBeTypeOf('function');
  });

  it('seeds from getState', async () => {
    getState.mockResolvedValue(payload({ url: 'https://seeded.test/' }));
    const { result } = renderHook(() => useSafety());
    await waitFor(() => expect(urlOf(result)).toBe('https://seeded.test/'));
  });

  it('a null getState leaves the interstitial closed', async () => {
    getState.mockResolvedValue(null);
    const { result } = renderHook(() => useSafety());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    expect(result.current.interstitial).toBeNull();
  });

  it('shows the interstitial when an event arrives', async () => {
    const { result } = renderHook(() => useSafety());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    const cb = onInterstitial.mock.calls[0][0] as (p: SafetyInterstitialPayload) => void;
    act(() => cb(payload({ url: 'https://live.test/', reason: 'https-failed' })));
    expect(urlOf(result)).toBe('https://live.test/');
    expect(result.current.interstitial?.reason).toBe('https-failed');
  });

  it('a later event replaces the previous interstitial', async () => {
    const { result } = renderHook(() => useSafety());
    await waitFor(() => expect(getState).toHaveBeenCalled());
    const cb = onInterstitial.mock.calls[0][0] as (p: SafetyInterstitialPayload) => void;
    act(() => cb(payload({ url: 'https://first.test/' })));
    act(() => cb(payload({ url: 'https://second.test/' })));
    expect(urlOf(result)).toBe('https://second.test/');
  });

  it('proceed forwards the url to the core', async () => {
    const { result } = renderHook(() => useSafety());
    await act(async () => {
      await result.current.proceed('https://malware.test/');
    });
    expect(proceed).toHaveBeenCalledWith('https://malware.test/');
  });

  it('unsubscribes on unmount', () => {
    const off = vi.fn();
    onInterstitial.mockReturnValue(off);
    const { unmount } = renderHook(() => useSafety());
    unmount();
    expect(off).toHaveBeenCalledTimes(1);
  });

  // The `active` flag exists solely for this: a getState that resolves after unmount
  // must not set state on a dead component.
  it('a getState that resolves after unmount does not setState', async () => {
    let release!: (v: SafetyInterstitialPayload | null) => void;
    getState.mockReturnValue(
      new Promise<SafetyInterstitialPayload | null>((res) => {
        release = res;
      }),
    );
    // EXPERIMENT: does React still warn on a post-unmount setState? Spy and find out rather
    // than assume, because if it does not, a console.error assertion is itself vacuous.
    const errors: unknown[][] = [];
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => {
      errors.push(a);
    });
    try {
      const { unmount } = renderHook(() => useSafety());
      unmount();
      await act(async () => {
        release(payload({ url: 'https://late.test/' }));
      });
      expect(errors).toEqual([]);
    } finally {
      spy.mockRestore();
    }
  });
});
