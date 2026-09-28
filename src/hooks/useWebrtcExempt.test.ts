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

    // Wait for the OBSERVABLE, then assert the mechanism. The reverse order — which
    // this test originally used for the two mutators below — is a FLAKE, not a
    // stronger test: `removeExempt` is called synchronously, so
    // `waitFor(...toHaveBeenCalledWith(...))` returns on the very first poll, while
    // the state only changes when the hook's `.then(setState)` runs a microtask
    // later. Whether the following `expect` sees the update therefore depends on how
    // many microtask ticks `waitFor`'s polling loop happens to burn — which is a
    // function of machine load. Measured: this exact race failed 2 runs in 3 under
    // full-suite load and never in isolation, which is why it read as an
    // "unidentified flake" for a whole wave. One `waitFor` on the state removes the
    // dependency on tick counts entirely.
    result.current.removeExempt('b.test');
    await waitFor(() => expect(result.current.state.exemptHosts).toEqual([]));
    expect(removeExempt).toHaveBeenCalledWith('b.test');

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
