// src/hooks/useFind.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { FindState } from '../../shared/types';

// --- mocks ---

const findStart = vi.fn();
const findNext = vi.fn();
const findPrev = vi.fn();
const findClose = vi.fn();
const onState = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    find: {
      start: (...a: unknown[]) => findStart(...a),
      next: (...a: unknown[]) => findNext(...a),
      prev: (...a: unknown[]) => findPrev(...a),
      close: (...a: unknown[]) => findClose(...a),
      onState: (cb: (s: FindState) => void) => onState(cb),
    },
  },
}));

import { useFind } from './useFind';

const OTHER_VIEW_ID = 99 as import('../../shared/types').ViewId;

function makeState(overrides: Partial<FindState> = {}): FindState {
  return {
    viewId: PRIMARY_VIEW_ID,
    query: '',
    matchCount: 0,
    activeMatchIndex: 0,
    ...overrides,
  };
}

let onStateCallback: ((s: FindState) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  findStart.mockResolvedValue(undefined);
  findNext.mockResolvedValue(undefined);
  findPrev.mockResolvedValue(undefined);
  findClose.mockResolvedValue(undefined);
  onStateCallback = undefined;
  onState.mockImplementation((cb: (s: FindState) => void) => {
    onStateCallback = cb;
    return () => {};
  });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useFind', () => {
  it('starts closed with empty state', () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    expect(result.current.open).toBe(false);
    expect(result.current.state.query).toBe('');
    expect(result.current.state.matchCount).toBe(0);
  });

  it('show() opens the bar', () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    act(() => result.current.show());
    expect(result.current.open).toBe(true);
  });

  it('setQuery calls aegis.find.start after debounce', async () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    act(() => result.current.show());
    act(() => result.current.setQuery('hello'));

    // Not yet — debounce pending
    expect(findStart).not.toHaveBeenCalled();

    // Advance past the 120 ms debounce
    await act(async () => {
      vi.advanceTimersByTime(130);
    });

    expect(findStart).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'hello', undefined);
  });

  it('next() calls aegis.find.next with active viewId', async () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    act(() => result.current.show());
    await act(async () => {
      result.current.next();
    });
    expect(findNext).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('prev() calls aegis.find.prev with active viewId', async () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    act(() => result.current.show());
    await act(async () => {
      result.current.prev();
    });
    expect(findPrev).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('close() calls aegis.find.close and hides the bar', async () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));
    act(() => result.current.show());
    expect(result.current.open).toBe(true);

    await act(async () => {
      result.current.close();
    });
    expect(findClose).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(result.current.open).toBe(false);
  });

  it('onState updates exposed state when viewId matches', () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));

    // onState callback is captured synchronously during mount effect
    expect(onStateCallback).toBeDefined();

    const incoming = makeState({ query: 'foo', matchCount: 3, activeMatchIndex: 1 });
    act(() => onStateCallback!(incoming));

    expect(result.current.state.matchCount).toBe(3);
    expect(result.current.state.activeMatchIndex).toBe(1);
    expect(result.current.state.query).toBe('foo');
  });

  it('onState is ignored when viewId does NOT match', () => {
    const { result } = renderHook(() => useFind(PRIMARY_VIEW_ID));

    expect(onStateCallback).toBeDefined();

    const incoming = makeState({ viewId: OTHER_VIEW_ID, query: 'bar', matchCount: 5 });
    act(() => onStateCallback!(incoming));

    // State unchanged — ignored
    expect(result.current.state.matchCount).toBe(0);
    expect(result.current.state.query).toBe('');
  });

  it('tab switch (activeViewId change) resets state and calls find.close for old view', () => {
    const { result, rerender } = renderHook(({ id }) => useFind(id), {
      initialProps: { id: PRIMARY_VIEW_ID },
    });

    // Open and seed some state on the first view
    act(() => result.current.show());
    expect(onStateCallback).toBeDefined();
    const first = makeState({ query: 'x', matchCount: 2, activeMatchIndex: 1 });
    act(() => onStateCallback!(first));
    expect(result.current.state.matchCount).toBe(2);

    // Switch to a different view id
    act(() => rerender({ id: OTHER_VIEW_ID }));

    // State should reset to empty
    expect(result.current.state.query).toBe('');
    expect(result.current.state.matchCount).toBe(0);
    // find.close should have been called for the OLD view id
    expect(findClose).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });
});
