// src/hooks/useMeasuredRect.test.tsx
//
// The surface's position source. What matters here:
//
//   - a CLOSED popover reports the EMPTY rect immediately (so the surface parks without waiting
//     for a render of an element that no longer exists), and
//   - the change guard compares the WHOLE RECT, not just the height: a popover can move
//     without resizing, and a height-only guard would leave the surface at the old position,
//   - the ResizeObserver is armed only while open and always disconnected (a leaked observer
//     holds a detached node alive and re-fires forever).
//
// CALL SHAPE MATTERS: `measure()` runs inside the `[active, measure]` effect, so assigning
// `ref.current` after mount measures nothing. Every test therefore attaches the node while
// INACTIVE and then flips `active`, which is what the real component does (the popover
// renders, then `active` goes true).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useMeasuredRect, EMPTY_RECT } from './useMeasuredRect';

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

/** A node whose getBoundingClientRect reports the given box. */
function nodeWithRect(x: number, y: number, width: number, height: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      x,
      y,
      width,
      height,
      left: x,
      top: y,
      right: x + width,
      bottom: y + height,
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
  const rendered = renderHook(({ active }) => useMeasuredRect<HTMLDivElement>(active), {
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

describe('useMeasuredRect', () => {
  it('reports the empty rect while inactive (the element is not mounted yet)', () => {
    const { result } = renderHook(() => useMeasuredRect<HTMLDivElement>(false));
    expect(result.current[1]).toStrictEqual(EMPTY_RECT);
  });

  it('reports the whole rectangle of the attached node once open', () => {
    const { result } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    expect(result.current[1]).toStrictEqual({ x: 120, y: 44, width: 640, height: 312 });
  });

  it('rounds every axis, not just the height', () => {
    // Sub-pixel values would be rounded again by `set_position`/`set_size` and by the GTK
    // allocation, so the hook rounds once here.
    const { result } = mountOpeningWith(nodeWithRect(120.6, 44.4, 639.5, 312.7));
    expect(result.current[1]).toStrictEqual({ x: 121, y: 44, width: 640, height: 313 });
  });

  it('reports the empty rect for a detached node rather than throwing', () => {
    const { result } = mountOpeningWith(null);
    expect(result.current[1]).toStrictEqual(EMPTY_RECT);
  });

  it('drops to the empty rect the moment it closes', () => {
    const { result, rerender } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    expect(result.current[1].height).toBe(312);
    rerender({ active: false });
    expect(result.current[1]).toStrictEqual(EMPTY_RECT);
  });

  it('re-measures on reopen (a popover that moved or changed size while closed)', () => {
    const { result, rerender } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    rerender({ active: false });
    act(() => {
      const el = result.current[0].current!;
      el.getBoundingClientRect = () =>
        ({ x: 8, y: 9, width: 500, height: 200, toJSON: () => ({}) }) as DOMRect;
    });
    rerender({ active: true });
    expect(result.current[1]).toStrictEqual({ x: 8, y: 9, width: 500, height: 200 });
  });

  // THE reason this hook is not `useMeasuredHeight`: the omnibox dropdown follows the row the
  // caret is on, so a popover can move while keeping its size. A height-only change guard
  // would report "unchanged" and leave the surface one row behind — visible as a dropdown
  // whose highlight is in the wrong place, or whose pointer target is a different row.
  it('re-measures when the popover MOVES without resizing', () => {
    const el = nodeWithRect(120, 44, 640, 312);
    const { result, ro } = mountOpeningWith(el);
    const before = result.current[1];
    act(() => {
      el.getBoundingClientRect = () =>
        ({ x: 120, y: 200, width: 640, height: 312, toJSON: () => ({}) }) as DOMRect;
      ro.last.cb([], {} as ResizeObserver);
    });
    expect(result.current[1]).toStrictEqual({ x: 120, y: 200, width: 640, height: 312 });
    expect(result.current[1]).not.toStrictEqual(before);
  });

  it('arms a ResizeObserver that observes the node', () => {
    const el = nodeWithRect(120, 44, 640, 312);
    const { ro } = mountOpeningWith(el);
    expect(ro.instances).toHaveLength(1);
    expect(ro.last.observed).toStrictEqual([el]);
  });

  it('disconnects the observer on unmount (no leaked observer holding a dead node)', () => {
    const { ro, unmount } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    expect(ro.last.disconnected).toBe(0);
    unmount();
    expect(ro.last.disconnected).toBe(1);
  });

  it('disconnects the observer when it closes', () => {
    const { ro, rerender } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    const instance = ro.last;
    rerender({ active: false });
    expect(instance.disconnected).toBe(1);
  });

  it('arms a fresh observer on each open and disconnects each on close', () => {
    const { ro, rerender } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    const first = ro.last;
    rerender({ active: false });
    rerender({ active: true });
    expect(ro.instances).toHaveLength(2);
    expect(first.disconnected).toBe(1);
    expect(ro.last.disconnected).toBe(0);
  });

  it('does not arm an observer at all while closed', () => {
    const ro = installResizeObserver();
    renderHook(() => useMeasuredRect<HTMLDivElement>(false));
    expect(ro.instances).toHaveLength(0);
    ro.restore();
  });

  // jsdom (and very old WebKitGTK) have no ResizeObserver; the single measure() is the only
  // thing available, so the hook must not throw on `new ResizeObserver`.
  it('still measures once when ResizeObserver is unavailable', () => {
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    const rendered = renderHook(({ active }) => useMeasuredRect<HTMLDivElement>(active), {
      initialProps: { active: false },
    });
    act(() => {
      rendered.result.current[0].current = nodeWithRect(120, 44, 640, 312);
    });
    expect(() => rendered.rerender({ active: true })).not.toThrow();
    expect(rendered.result.current[1]).toStrictEqual({ x: 120, y: 44, width: 640, height: 312 });
  });

  // A redundant observer callback must be a no-op, or a re-render loop can be born.
  it('does not churn state when a redundant measure reports the same rect', () => {
    const { result, ro } = mountOpeningWith(nodeWithRect(120, 44, 640, 312));
    const before = result.current[1];
    act(() => {
      ro.last.cb([], {} as ResizeObserver);
    });
    expect(result.current[1]).toBe(before);
  });
});
