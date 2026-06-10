// src/hooks/useContentInset.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { TOOLBAR_H, FAVBAR_H, SIDEBAR_W } from '../lib/layout';

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
    expect(SIDEBAR_W).toBe(280);
  });

  it('on mount with the sidebar closed, reports top = TOOLBAR_H + FAVBAR_H, left = 0', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: false }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
  });

  it('on mount with the sidebar open, reports left = SIDEBAR_W', () => {
    renderHook(() => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: true }));
    expect(setContentInset).toHaveBeenCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: SIDEBAR_W,
    });
  });

  it('re-reports the inset when sidebarOpen changes', () => {
    const { rerender } = renderHook(({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }), {
      initialProps: { open: false },
    });
    expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: 0,
    });
    rerender({ open: true });
    expect(setContentInset).toHaveBeenLastCalledWith(PRIMARY_VIEW_ID, {
      top: TOOLBAR_H + FAVBAR_H,
      left: SIDEBAR_W,
    });
  });

  it('does not re-report when sidebarOpen is unchanged across a rerender', () => {
    const { rerender } = renderHook(({ open }) => useContentInset(PRIMARY_VIEW_ID, { sidebarOpen: open }), {
      initialProps: { open: true },
    });
    expect(setContentInset).toHaveBeenCalledTimes(1);
    rerender({ open: true });
    expect(setContentInset).toHaveBeenCalledTimes(1);
  });
});
