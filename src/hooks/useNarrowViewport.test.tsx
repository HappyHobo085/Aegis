// src/hooks/useNarrowViewport.test.tsx
//
// Two contracts: the reactive matchMedia result, and the mirror onto
// `<html class="aegis-narrow">` that CSS adapts to. The mirror must NEVER apply in the
// Android shell — that shell has its own layout and the class would fight it.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useNarrowViewport, NARROW_BREAKPOINT_PX } from './useNarrowViewport';

type Listener = (e: MediaQueryListEvent | MediaQueryList) => void;

/** A controllable matchMedia that records its listeners and can be flipped. */
function installMatchMedia(initial: boolean) {
  const listeners = new Set<Listener>();
  let matches = initial;
  const queries: string[] = [];
  const mql = {
    get matches() {
      return matches;
    },
    media: '',
    onchange: null,
    addEventListener: ((_: string, fn: Listener) => {
      listeners.add(fn);
    }) as MediaQueryList['addEventListener'],
    removeEventListener: ((_: string, fn: Listener) => {
      listeners.delete(fn);
    }) as MediaQueryList['removeEventListener'],
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => true,
  } as unknown as MediaQueryList;
  const matchMedia = vi.fn((query: string) => {
    queries.push(query);
    return mql;
  });
  (window as { matchMedia?: unknown }).matchMedia = matchMedia;
  return {
    mql,
    queries,
    matchMedia,
    get listenerCount() {
      return listeners.size;
    },
    flip(next: boolean) {
      matches = next;
      for (const fn of [...listeners]) fn(mql);
    },
  };
}

beforeEach(() => {
  document.documentElement.classList.remove('aegis-narrow');
});
afterEach(() => {
  delete (window as { matchMedia?: unknown }).matchMedia;
  document.documentElement.classList.remove('aegis-narrow');
});

describe('useNarrowViewport', () => {
  it('queries the documented breakpoint', () => {
    const mm = installMatchMedia(false);
    renderHook(() => useNarrowViewport());
    expect(mm.queries[0]).toBe(`(max-width: ${NARROW_BREAKPOINT_PX}px)`);
  });

  it('reports narrow when the query already matches at mount', () => {
    installMatchMedia(true);
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(true);
  });

  it('reports wide when the query does not match at mount', () => {
    installMatchMedia(false);
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
  });

  it('follows a live crossing of the breakpoint in both directions', () => {
    const mm = installMatchMedia(false);
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
    act(() => mm.flip(true));
    expect(result.current).toBe(true);
    act(() => mm.flip(false));
    expect(result.current).toBe(false);
  });

  it('mirrors the result onto <html class="aegis-narrow">', () => {
    const mm = installMatchMedia(false);
    renderHook(() => useNarrowViewport());
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(false);
    act(() => mm.flip(true));
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(true);
    act(() => mm.flip(false));
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(false);
  });

  it('removes the class on unmount so a torn-down shell cannot leave it behind', () => {
    const mm = installMatchMedia(true);
    const { unmount } = renderHook(() => useNarrowViewport());
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(true);
    unmount();
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(false);
  });

  // The Android shell renders its own layout; the desktop-compact class must not be
  // applied there or CSS would compact a layout that is already a touch layout.
  it('does NOT apply the class while the mobile shell is active', () => {
    document.documentElement.classList.add('aegis-mobile');
    const mm = installMatchMedia(true);
    const { result } = renderHook(() => useNarrowViewport());
    // The hook still REPORTS the media result…
    expect(result.current).toBe(true);
    // …but it must not touch the root class.
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(false);
    act(() => mm.flip(false));
    expect(document.documentElement.classList.contains('aegis-narrow')).toBe(false);
  });

  it('removes its change listener on unmount', () => {
    const mm = installMatchMedia(false);
    const { unmount } = renderHook(() => useNarrowViewport());
    expect(mm.listenerCount).toBe(1);
    unmount();
    expect(mm.listenerCount).toBe(0);
  });

  // A non-browser/test environment with no matchMedia must not crash the shell.
  it('defaults to wide and does not throw when matchMedia is unavailable', () => {
    delete (window as { matchMedia?: unknown }).matchMedia;
    const { result } = renderHook(() => useNarrowViewport());
    expect(result.current).toBe(false);
  });

  it('adds exactly one change listener, not one per render', () => {
    const mm = installMatchMedia(false);
    const { rerender } = renderHook(() => useNarrowViewport());
    rerender();
    rerender();
    expect(mm.listenerCount).toBe(1);
  });
});
