// src/hooks/useZoom.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { ZoomState } from '../../shared/types';

// --- mocks ---

const zoomGet = vi.fn();
const zoomSet = vi.fn();
const zoomReset = vi.fn();
const onChanged = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    zoom: {
      get: (...a: unknown[]) => zoomGet(...a),
      set: (...a: unknown[]) => zoomSet(...a),
      reset: (...a: unknown[]) => zoomReset(...a),
      onChanged: (cb: (s: ZoomState) => void) => onChanged(cb),
    },
  },
}));

import { useZoom } from './useZoom';

const OTHER_VIEW_ID = 99 as import('../../shared/types').ViewId;

function makeZoomState(overrides: Partial<ZoomState> = {}): ZoomState {
  return {
    viewId: PRIMARY_VIEW_ID,
    factor: 1.0,
    ...overrides,
  };
}

let onChangedCallback: ((s: ZoomState) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  onChangedCallback = undefined;

  // Default: zoom.get resolves to 1.0
  zoomGet.mockResolvedValue(makeZoomState());
  // zoom.set and zoom.reset resolve immediately
  zoomSet.mockResolvedValue(makeZoomState());
  zoomReset.mockResolvedValue(makeZoomState());
  // Capture the onChanged callback and return an unsubscribe fn
  onChanged.mockImplementation((cb: (s: ZoomState) => void) => {
    onChangedCallback = cb;
    return () => {};
  });
});

describe('useZoom', () => {
  it('seeds factor from zoom.get on mount', async () => {
    zoomGet.mockResolvedValue(makeZoomState({ factor: 1.25 }));

    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));

    // zoom.get should have been called with the active view id
    expect(zoomGet).toHaveBeenCalledWith(PRIMARY_VIEW_ID);

    // Wait for the resolved promise to update state
    await act(async () => {});

    expect(result.current.factor).toBe(1.25);
  });

  it('initial factor defaults to ZOOM_DEFAULT (1.0) before get resolves', () => {
    // zoom.get is pending (never resolves in this test)
    zoomGet.mockReturnValue(new Promise(() => {}));

    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));

    expect(result.current.factor).toBe(1.0);
  });

  it('exposes a formatted percent string', async () => {
    zoomGet.mockResolvedValue(makeZoomState({ factor: 1.25 }));
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});
    expect(result.current.percent).toBe('125%');
  });

  it('zoomIn() calls zoom.set with the next step up from the current factor', async () => {
    // factor seeds to 1.0
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});

    await act(async () => {
      result.current.zoomIn();
    });

    // stepZoom(1.0, 1) === 1.1 on the ZOOM_STEPS ladder
    expect(zoomSet).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 1.1);
  });

  it('zoomOut() calls zoom.set with the next step down from the current factor', async () => {
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});

    await act(async () => {
      result.current.zoomOut();
    });

    // stepZoom(1.0, -1) === 0.9 on the ZOOM_STEPS ladder
    expect(zoomSet).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 0.9);
  });

  it('reset() calls zoom.reset with the active viewId', async () => {
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});

    await act(async () => {
      result.current.reset();
    });

    expect(zoomReset).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('reset() sets factor back to ZOOM_DEFAULT (1.0) optimistically', async () => {
    zoomGet.mockResolvedValue(makeZoomState({ factor: 1.5 }));
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});
    expect(result.current.factor).toBe(1.5);

    await act(async () => {
      result.current.reset();
    });

    expect(result.current.factor).toBe(1.0);
  });

  it('onChanged updates the exposed factor when viewId matches', async () => {
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});

    // onChanged callback captured during mount effect
    expect(onChangedCallback).toBeDefined();

    act(() => onChangedCallback!(makeZoomState({ factor: 1.75 })));

    expect(result.current.factor).toBe(1.75);
  });

  it('onChanged is ignored when viewId does NOT match', async () => {
    const { result } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    await act(async () => {});

    expect(onChangedCallback).toBeDefined();

    act(() => onChangedCallback!(makeZoomState({ viewId: OTHER_VIEW_ID, factor: 2.0 })));

    // Should remain at the seeded value
    expect(result.current.factor).toBe(1.0);
  });

  it('switches viewId: re-fetches zoom.get and resubscribes onChanged', async () => {
    const { result, rerender } = renderHook(({ id }) => useZoom(id), {
      initialProps: { id: PRIMARY_VIEW_ID },
    });

    await act(async () => {});
    expect(zoomGet).toHaveBeenCalledWith(PRIMARY_VIEW_ID);

    zoomGet.mockResolvedValue(makeZoomState({ viewId: OTHER_VIEW_ID, factor: 1.5 }));
    act(() => rerender({ id: OTHER_VIEW_ID }));
    await act(async () => {});

    expect(zoomGet).toHaveBeenCalledWith(OTHER_VIEW_ID);
    expect(result.current.factor).toBe(1.5);
  });

  it('onChanged for old viewId is ignored after tab switch (via current callback)', async () => {
    const { result, rerender } = renderHook(({ id }) => useZoom(id), {
      initialProps: { id: PRIMARY_VIEW_ID },
    });
    await act(async () => {});

    zoomGet.mockResolvedValue(makeZoomState({ viewId: OTHER_VIEW_ID, factor: 1.0 }));
    act(() => rerender({ id: OTHER_VIEW_ID }));
    await act(async () => {});

    // After switching to OTHER_VIEW_ID, the current onChanged callback filters by OTHER_VIEW_ID.
    // A ZoomState for the OLD PRIMARY_VIEW_ID should be ignored.
    act(() => onChangedCallback!(makeZoomState({ viewId: PRIMARY_VIEW_ID, factor: 3.0 })));

    expect(result.current.factor).toBe(1.0);
  });

  it('unsubscribes onChanged on unmount', () => {
    const unsubscribe = vi.fn();
    onChanged.mockReturnValue(unsubscribe);

    const { unmount } = renderHook(() => useZoom(PRIMARY_VIEW_ID));
    unmount();

    expect(unsubscribe).toHaveBeenCalled();
  });
});
