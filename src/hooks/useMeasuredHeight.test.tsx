// src/hooks/useMeasuredHeight.test.tsx
//
// The compositor's height source for popovers. The behaviour that matters:
//   - a CLOSED popover reserves 0 immediately (so the content springs back without
//     waiting for a render of an element that no longer exists), and
//   - the ResizeObserver is armed only while open and always disconnected on cleanup
//     (a leaked observer holds a detached node alive and re-fires forever).
//
// CALL SHAPE MATTERS: `measure()` runs inside the `[active, measure]` effect, so
// assigning `ref.current` after mount measures nothing. Every test therefore attaches
// the node while INACTIVE and then flips `active`, which is what the real component
// does (the popover renders, then `active` goes true).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMeasuredHeight } from './useMeasuredHeight';

const HEIGHT = 137;

interface FakeInstance {
  cb: ResizeObserverCallback;
  observed: Element[];
  disconnected: number;
}

/** Install a controllable ResizeObserver and return its instance registry. */
function installResizeObserver() {
  const instances: FakeInstance[] = [];
  const RealRO = globalThis.ResizeObserver;
  class FakeRO {
    cb: ResizeObserverCallback;
    observed: Element[] = [];
    disconnected = 0;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
      instances.push(this as unknown as FakeInstance);
    }
    observe(el: Element) {
      this.observed.push(el);
    }
    unobserve() {}
    disconnect() {
      this.disconnected += 1;
    }
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = FakeRO;
  return {
    instances,
    get last() {
      return instances[instances.length - 1];
    },
    restore() {
      if (RealRO === undefined) {
        delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
      } else {
        (globalThis as { ResizeObserver?: unknown }).ResizeObserver = RealRO;
      }
    },
  };
}

/** A node whose getBoundingClientRect reports `height`. */
function nodeWithHeight(height: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      height,
      width: 10,
      top: 0,
      left: 0,
      right: 10,
      bottom: height,
      x: 0,
      y: 0,
      toJSON: () => ({}),
    }) as DOMRect;
  return el;
}

/**
 * Mount inactive, attach `el`, then open. Returns the hook result plus the observer
 * registry the effect armed.
 */
function mountOpeningWith(el: HTMLElement | null) {
  const ro = installResizeObserver();
  const rendered = renderHook(({ active }) => useMeasuredHeight<HTMLDivElement>(active), {
    initialProps: { active: false },
  });
  act(() => {
    rendered.result.current[0].current = el as HTMLDivElement | null;
  });
  rendered.rerender({ active: true });
  return { ...rendered, ro };
}

afterEach(() => {
  delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  vi.restoreAllMocks();
});

describe('useMeasuredHeight', () => {
  it('measures 0 while inactive (the element is not mounted yet)', () => {
    const { result } = renderHook(() => useMeasuredHeight<HTMLDivElement>(false));
    expect(result.current[1]).toBe(0);
  });

  it('reports the measured height of the attached node once open', () => {
    const { result } = mountOpeningWith(nodeWithHeight(HEIGHT));
    expect(result.current[1]).toBe(HEIGHT);
  });

  it('rounds a fractional height to a whole pixel', () => {
    const { result } = mountOpeningWith(nodeWithHeight(120.6));
    expect(result.current[1]).toBe(121);
  });

  it('measures 0 for a detached node rather than throwing', () => {
    const { result } = mountOpeningWith(null);
    expect(result.current[1]).toBe(0);
  });

  it('drops the reservation to 0 the moment it closes', () => {
    const { result, rerender } = mountOpeningWith(nodeWithHeight(HEIGHT));
    expect(result.current[1]).toBe(HEIGHT);
    rerender({ active: false });
    expect(result.current[1]).toBe(0);
  });

  it('re-measures on reopen (a popover that changed size while closed)', () => {
    const el = nodeWithHeight(HEIGHT);
    const { result, rerender } = mountOpeningWith(el);
    expect(result.current[1]).toBe(HEIGHT);
    rerender({ active: false });
    act(() => {
      el.getBoundingClientRect = () => ({ height: 200, width: 10 }) as DOMRect;
    });
    rerender({ active: true });
    expect(result.current[1]).toBe(200);
  });

  it('arms a ResizeObserver that observes the node', () => {
    const el = nodeWithHeight(HEIGHT);
    const { ro } = mountOpeningWith(el);
    expect(ro.instances).toHaveLength(1);
    expect(ro.last.observed).toEqual([el]);
  });

  it('re-measures when the observer reports a new size', () => {
    const el = nodeWithHeight(HEIGHT);
    const { result, ro } = mountOpeningWith(el);
    act(() => {
      el.getBoundingClientRect = () => ({ height: 200, width: 10 }) as DOMRect;
      ro.last.cb([], {} as ResizeObserver);
    });
    expect(result.current[1]).toBe(200);
  });

  it('disconnects the observer on unmount (no leaked observer holding a dead node)', () => {
    const { ro, unmount } = mountOpeningWith(nodeWithHeight(HEIGHT));
    expect(ro.last.disconnected).toBe(0);
    unmount();
    expect(ro.last.disconnected).toBe(1);
  });

  it('disconnects the observer when it closes', () => {
    const { ro, rerender } = mountOpeningWith(nodeWithHeight(HEIGHT));
    const instance = ro.last;
    rerender({ active: false });
    expect(instance.disconnected).toBe(1);
  });

  it('arms a fresh observer on each open and disconnects each on close', () => {
    const { ro, rerender } = mountOpeningWith(nodeWithHeight(HEIGHT));
    const first = ro.last;
    rerender({ active: false });
    rerender({ active: true });
    expect(ro.instances).toHaveLength(2);
    expect(first.disconnected).toBe(1);
    expect(ro.last.disconnected).toBe(0);
  });

  it('does not arm an observer at all while closed', () => {
    const ro = installResizeObserver();
    renderHook(() => useMeasuredHeight<HTMLDivElement>(false));
    expect(ro.instances).toHaveLength(0);
    ro.restore();
  });

  // jsdom (and very old WebKitGTK) have no ResizeObserver; the single measure() is the
  // only thing available, so the hook must not throw on `new ResizeObserver`.
  it('still measures once when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const rendered = renderHook(({ active }) => useMeasuredHeight<HTMLDivElement>(active), {
      initialProps: { active: false },
    });
    act(() => {
      rendered.result.current[0].current = nodeWithHeight(HEIGHT);
    });
    expect(() => rendered.rerender({ active: true })).not.toThrow();
    expect(rendered.result.current[1]).toBe(HEIGHT);
  });

  // The change guard makes a redundant observer callback a no-op, so a re-render loop
  // cannot be born: the popover's CSS height is fixed px (never vh) precisely because
  // a size fed back from the inset could otherwise oscillate.
  it('does not churn state when a redundant measure reports the same height', () => {
    const { result, ro } = mountOpeningWith(nodeWithHeight(HEIGHT));
    const before = result.current[1];
    act(() => {
      ro.last.cb([], {} as ResizeObserver);
    });
    expect(result.current[1]).toBe(before);
  });
});
