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
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, true));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: 132,
      left: 0,
    });
  });

  it('reports the inset exactly once on mount and does not re-fire on rerender', () => {
    const { rerender } = renderHook(() => useContentInset(PRIMARY_VIEW_ID, true));
    expect(setContentInset).toHaveBeenCalledTimes(1);
    rerender();
    // The inset effect is keyed on viewId + showTabStrip — it must NOT re-fire on a rerender.
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });

  it('adds the tab-strip height to the top inset when shown', () => {
    renderHook(() => useContentInset(1, true));
    expect(setContentInset).toHaveBeenCalledWith(1, { top: 56 + 40 + 36, left: 0 });
  });

  it('omits the strip height when not shown (mobile)', () => {
    renderHook(() => useContentInset(1, false));
    expect(setContentInset).toHaveBeenCalledWith(1, { top: 56 + 40, left: 0 });
  });
});
