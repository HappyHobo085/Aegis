import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { WebrtcExemptState } from '../../shared/types';

// Declared here, NOT imported from `aegisMock`: a `vi.mock` factory is hoisted above the
// imports, so it cannot close over an imported binding (that is
// `ReferenceError: Cannot access '__vi_import_N__' before initialization`). Declaring the
// spies above the factory — the same shape `useFingerprint.test.tsx` uses — is what lets the
// test both mock and assert on the transport.
const getExemptHosts = vi.fn();
const toggleExempt = vi.fn();
const removeExempt = vi.fn();
const clearExempt = vi.fn();
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    webrtc: {
      getExemptHosts: (...a: unknown[]) => getExemptHosts(...a),
      toggleExempt: (...a: unknown[]) => toggleExempt(...a),
      removeExempt: (...a: unknown[]) => removeExempt(...a),
      clearExempt: (...a: unknown[]) => clearExempt(...a),
    },
  },
}));

import { useWebrtcExempt } from './useWebrtcExempt';

const state = (exemptHosts: string[]): WebrtcExemptState => ({ exemptHosts });

beforeEach(() => {
  vi.clearAllMocks();
  getExemptHosts.mockResolvedValue(state([]));
  toggleExempt.mockResolvedValue(state([]));
  removeExempt.mockResolvedValue(state([]));
  clearExempt.mockResolvedValue(state([]));
});

describe('useWebrtcExempt', () => {
  it('seeds from the core on mount', async () => {
    getExemptHosts.mockResolvedValue(state(['a.test']));
    const { result } = renderHook(() => useWebrtcExempt());
    // The seed resolves through a promise, so the first render must NOT already claim it.
    expect(result.current.state).toEqual({ exemptHosts: [] });
    await waitFor(() => expect(result.current.state.exemptHosts).toEqual(['a.test']));
  });

  it('toggles, removes and clears, taking the core reply as the new state', async () => {
    toggleExempt.mockResolvedValue(state(['b.test']));
    const { result } = renderHook(() => useWebrtcExempt());
    await waitFor(() => expect(getExemptHosts).toHaveBeenCalled());

    result.current.toggleExempt('b.test');
    await waitFor(() => expect(result.current.state.exemptHosts).toEqual(['b.test']));
    expect(toggleExempt).toHaveBeenCalledWith('b.test');

    result.current.removeExempt('b.test');
    await waitFor(() => expect(removeExempt).toHaveBeenCalledWith('b.test'));
    expect(result.current.state.exemptHosts).toEqual([]);

    result.current.clearExempt();
    await waitFor(() => expect(clearExempt).toHaveBeenCalled());
  });

  it('keeps the mutators referentially stable, so they are safe effect deps', () => {
    const { result, rerender } = renderHook(() => useWebrtcExempt());
    const first = {
      toggle: result.current.toggleExempt,
      remove: result.current.removeExempt,
      clear: result.current.clearExempt,
    };
    rerender();
    expect(result.current.toggleExempt).toBe(first.toggle);
    expect(result.current.removeExempt).toBe(first.remove);
    expect(result.current.clearExempt).toBe(first.clear);
  });

  it('does not set state after unmount', async () => {
    // The seed resolves through a promise, so an unmount can land between the request and
    // its reply. The `active` flag is the guard; without it React warns about a
    // state-update-after-unmount and writes to a dead fiber.
    let resolveSeed: (s: WebrtcExemptState) => void = () => {};
    getExemptHosts.mockReturnValue(
      new Promise<WebrtcExemptState>((r) => {
        resolveSeed = r;
      }),
    );
    const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { unmount } = renderHook(() => useWebrtcExempt());
    unmount();
    resolveSeed(state(['late.test']));
    await new Promise((r) => setTimeout(r, 0));
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
