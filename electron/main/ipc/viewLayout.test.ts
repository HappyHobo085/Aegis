// electron/main/ipc/viewLayout.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../../shared/types';
import { buildViewLayoutHandlers } from './viewLayout';

describe('buildViewLayoutHandlers', () => {
  it('registers exactly the view.setContentInset + view.setSidebarOpen channels', () => {
    const handlers = buildViewLayoutHandlers(vi.fn(), vi.fn());
    expect(Object.keys(handlers)).toEqual([IPC.viewSetContentInset, IPC.viewSetSidebarOpen]);
  });

  it('forwards (inset.top, inset.left) to setContentInset', () => {
    const setContentInset = vi.fn();
    const handlers = buildViewLayoutHandlers(setContentInset, vi.fn());
    handlers[IPC.viewSetContentInset](PRIMARY_VIEW_ID, { top: 96, left: 280 });
    expect(setContentInset).toHaveBeenCalledWith(96, 280);
  });

  it('forwards top with a zero left', () => {
    const setContentInset = vi.fn();
    const handlers = buildViewLayoutHandlers(setContentInset, vi.fn());
    handlers[IPC.viewSetContentInset](PRIMARY_VIEW_ID, { top: 56, left: 0 });
    expect(setContentInset).toHaveBeenCalledWith(56, 0);
  });

  it('forwards the open boolean to setSidebarOpen', () => {
    const setSidebarOpen = vi.fn();
    const handlers = buildViewLayoutHandlers(vi.fn(), setSidebarOpen);
    handlers[IPC.viewSetSidebarOpen](PRIMARY_VIEW_ID, true);
    expect(setSidebarOpen).toHaveBeenCalledWith(true);
    handlers[IPC.viewSetSidebarOpen](PRIMARY_VIEW_ID, false);
    expect(setSidebarOpen).toHaveBeenCalledWith(false);
  });
});
