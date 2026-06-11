// src/hooks/useContentInset.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { TOOLBAR_H, FAVBAR_H } from '../lib/layout';

const setContentInset = vi.fn();
const setSidebarOpen = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    view: {
      setContentInset: (...a: any[]) => setContentInset(...a),
      setSidebarOpen: (...a: any[]) => setSidebarOpen(...a),
    },
  },
}));

import { useContentInset } from './useContentInset';

beforeEach(() => {
  vi.clearAllMocks();
  setContentInset.mockResolvedValue(undefined);
  setSidebarOpen.mockResolvedValue(undefined);
});

describe('useContentInset', () => {
  it('exports the shared layout constants', () => {
    expect(TOOLBAR_H).toBe(56);
    expect(FAVBAR_H).toBe(40);
  });

  it('reports a constant top inset (toolbar + favbar) with left 0 on mount, regardless of sidebar state', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: false }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
  });

  it('the overlay never insets content: open mount still reports left 0 (no SIDEBAR_W push)', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: true }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
  });

  it('drives view.setSidebarOpen with the current sidebar state on mount', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: false }));
    expect(setSidebarOpen).toHaveBeenCalledWith(PRIMARY_VIEW_ID, false);
  });

  it('re-reports setSidebarOpen when sidebarOpen changes, WITHOUT re-reporting the inset', () => {
    const { rerender } = renderHook(
      ({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }),
      { initialProps: { open: false } },
    );
    expect(setSidebarOpen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, false);
    expect(setContentInset).toHaveBeenCalledTimes(1);

    rerender({ open: true });
    expect(setSidebarOpen).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, true);
    // The inset effect is keyed on viewId only — it must NOT re-fire on a sidebar toggle.
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });

  it('does not re-report setSidebarOpen when sidebarOpen is unchanged across a rerender', () => {
    const { rerender } = renderHook(
      ({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }),
      { initialProps: { open: true } },
    );
    expect(setSidebarOpen).toHaveBeenCalledTimes(1);
    rerender({ open: true });
    expect(setSidebarOpen).toHaveBeenCalledTimes(1);
  });
});
