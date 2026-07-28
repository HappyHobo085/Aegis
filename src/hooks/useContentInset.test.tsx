// src/hooks/useContentInset.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';

const setContentInset = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    view: {
      setContentInset: (...a: any[]) => setContentInset(...a),
    },
  },
}));

import { useContentInset } from './useContentInset';

beforeEach(() => {
  vi.clearAllMocks();
  setContentInset.mockResolvedValue(undefined);
});

describe('useContentInset', () => {
  it('reports the given topInset with left 0 on mount', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, 132));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: 132,
      left: 0,
    });
  });

  it('does not re-fire the IPC on rerender when topInset is unchanged', () => {
    const { rerender } = renderHook(({ topInset }) => useContentInset(PRIMARY_VIEW_ID, topInset), {
      initialProps: { topInset: 132 },
    });
    expect(setContentInset).toHaveBeenCalledTimes(1);
    rerender({ topInset: 132 });
    // Same topInset → effect must NOT re-fire.
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });

  it('re-fires the IPC when topInset changes', () => {
    const { rerender } = renderHook(({ topInset }) => useContentInset(PRIMARY_VIEW_ID, topInset), {
      initialProps: { topInset: 132 },
    });
    expect(setContentInset).toHaveBeenCalledTimes(1);
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 132, left: 0 });

    rerender({ topInset: 172 });
    expect(setContentInset).toHaveBeenCalledTimes(2);
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 172, left: 0 });
  });

  it('reports a zero topInset correctly', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, 0));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, { top: 0, left: 0 });
  });
});
