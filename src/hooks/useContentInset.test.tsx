// src/hooks/useContentInset.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { TOOLBAR_H, FAVBAR_H } from '../lib/layout';

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
  it('exports the shared layout constants', () => {
    expect(TOOLBAR_H).toBe(56);
    expect(FAVBAR_H).toBe(40);
  });

  it('reports a constant top inset (toolbar + favbar) with left 0 on mount', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
  });

  it('reports the inset exactly once on mount and does not re-fire on rerender', () => {
    const { rerender } = renderHook(() => useContentInset(PRIMARY_VIEW_ID));
    expect(setContentInset).toHaveBeenCalledTimes(1);
    rerender();
    // The inset effect is keyed on viewId only — it must NOT re-fire on a rerender.
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });
});
