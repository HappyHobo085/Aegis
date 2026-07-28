// src/hooks/useSplit.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { SplitLayout } from '../../shared/types';

const onStateCallbacks: Array<(l: SplitLayout | null) => void> = [];

const mockSplit = {
  enter: vi.fn().mockResolvedValue(undefined),
  exit: vi.fn().mockResolvedValue(undefined),
  resize: vi.fn().mockResolvedValue(undefined),
  focus: vi.fn().mockResolvedValue(undefined),
  onState: vi.fn((cb: (l: SplitLayout | null) => void) => {
    onStateCallbacks.push(cb);
    return () => {
      const i = onStateCallbacks.indexOf(cb);
      if (i !== -1) onStateCallbacks.splice(i, 1);
    };
  }),
};

vi.mock('../lib/ipcClient', () => ({
  aegis: { split: mockSplit },
}));

// import after mock
const { useSplit } = await import('./useSplit');

describe('useSplit', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onStateCallbacks.length = 0;
    mockSplit.enter.mockResolvedValue(undefined);
    mockSplit.exit.mockResolvedValue(undefined);
    mockSplit.resize.mockResolvedValue(undefined);
    mockSplit.focus.mockResolvedValue(undefined);
    mockSplit.onState.mockImplementation((cb: (l: SplitLayout | null) => void) => {
      onStateCallbacks.push(cb);
      return () => {
        const i = onStateCallbacks.indexOf(cb);
        if (i !== -1) onStateCallbacks.splice(i, 1);
      };
    });
  });

  it('initializes with null layout', () => {
    const { result } = renderHook(() => useSplit());
    expect(result.current.layout).toBeNull();
  });

  it('subscribes to onState on mount', () => {
    renderHook(() => useSplit());
    expect(mockSplit.onState).toHaveBeenCalledTimes(1);
  });

  it('updates layout when split.state event fires', async () => {
    const { result } = renderHook(() => useSplit());
    const layout: SplitLayout = {
      panes: [
        { tabId: 1, width: 600, height: 800, x: 0, y: 0 },
        { tabId: 2, width: 600, height: 800, x: 600, y: 0 },
      ],
      focusedPaneId: 1,
    };
    act(() => {
      onStateCallbacks.forEach((cb) => cb(layout));
    });
    expect(result.current.layout).toEqual(layout);
    expect(result.current.layout?.panes).toHaveLength(2);
  });

  it('resets layout to null when split is exited', async () => {
    const { result } = renderHook(() => useSplit());
    const layout: SplitLayout = {
      panes: [
        { tabId: 1, width: 1200, height: 800, x: 0, y: 0 },
        { tabId: 2, width: 1200, height: 800, x: 0, y: 400 },
      ],
      focusedPaneId: 1,
    };
    act(() => {
      onStateCallbacks.forEach((cb) => cb(layout));
    });
    expect(result.current.layout).not.toBeNull();

    act(() => {
      onStateCallbacks.forEach((cb) => cb(null));
    });
    expect(result.current.layout).toBeNull();
  });

  it('enterSplit calls aegis.split.enter', async () => {
    const { result } = renderHook(() => useSplit());
    await act(async () => {
      await result.current.enterSplit([1, 2]);
    });
    expect(mockSplit.enter).toHaveBeenCalledWith([1, 2]);
  });

  it('exitSplit calls aegis.split.exit', async () => {
    const { result } = renderHook(() => useSplit());
    await act(async () => {
      await result.current.exitSplit();
    });
    expect(mockSplit.exit).toHaveBeenCalled();
  });

  it('resizePane calls aegis.split.resize', async () => {
    const { result } = renderHook(() => useSplit());
    await act(async () => {
      await result.current.resizePane(1, 800, 600);
    });
    expect(mockSplit.resize).toHaveBeenCalledWith(1, 800, 600);
  });

  it('focusPane calls aegis.split.focus', async () => {
    const { result } = renderHook(() => useSplit());
    await act(async () => {
      await result.current.focusPane(2);
    });
    expect(mockSplit.focus).toHaveBeenCalledWith(2);
  });

  it('unsubscribes from onState on unmount', () => {
    const { unmount } = renderHook(() => useSplit());
    expect(onStateCallbacks).toHaveLength(1);
    unmount();
    expect(onStateCallbacks).toHaveLength(0);
  });
});
