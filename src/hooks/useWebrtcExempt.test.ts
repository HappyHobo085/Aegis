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
// The webrtc exempt list is LOCAL-ONLY (see the hook's doc comment), so the hook must not
// subscribe to the sync bus. Mocking `onSyncChange` is what makes that absence ASSERTABLE
// rather than merely documented — without this spy nothing could tell a deliberately
// unsubscribed hook from one that simply forgot.
// A rest parameter, not a fixed one — see the note in useFingerprint.test.ts: a fixed
// signature makes the mock factory's spread a TS2556 compile error.
const onSyncChange = vi.fn((..._a: unknown[]) => () => {});
vi.mock('../lib/syncBus', () => ({
  onSyncChange: (...a: unknown[]) => onSyncChange(...a),
}));
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

  it('subscribes to nothing, because the exempt list is local-only', async () => {
    // The absence IS the feature: a peer merge must not be able to change this list, so
    // the hook deliberately has no `onSyncChange` subscription. This replaces an older
    // test that spied on `console.error` and asserted no warning was logged — React 18
    // REMOVED the post-unmount setState warning, so that assertion could never fail and
    // reported coverage it was not providing.
    renderHook(() => useWebrtcExempt());
    await waitFor(() => expect(getExemptHosts).toHaveBeenCalled());
    expect(onSyncChange).not.toHaveBeenCalled();
  });

  it('swallows a seed that resolves after unmount', async () => {
    // The seed resolves through a promise, so an unmount can land between the request and
    // its reply; the `active` flag is the guard.
    //
    // HONEST LIMIT: that guard's EFFECT is not observable from a test. React 18 removed
    // the warning it used to raise, and there is no public way to see that `setState` was
    // skipped. So this asserts what IS observable — that the late reply is absorbed
    // without throwing, surfacing an unhandled rejection, or leaking into the next test —
    // and the `active` flag itself remains untested defence-in-depth.
    let resolveSeed: (s: WebrtcExemptState) => void = () => {};
    getExemptHosts.mockReturnValue(
      new Promise<WebrtcExemptState>((r) => {
        resolveSeed = r;
      }),
    );
    const onRejection = vi.fn();
    process.on('unhandledRejection', onRejection);

    const { unmount } = renderHook(() => useWebrtcExempt());
    unmount();
    resolveSeed(state(['late.test']));
    await new Promise((r) => setTimeout(r, 0));

    expect(onRejection).not.toHaveBeenCalled();
    expect(getExemptHosts).toHaveBeenCalledTimes(1);
    process.off('unhandledRejection', onRejection);
  });
});
