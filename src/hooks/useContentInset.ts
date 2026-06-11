import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H } from '../lib/layout';

/**
 * Top inset is constant (toolbar + always-on favbar). The sidebar is a right
 * overlay, so it never insets content — it drives a native z-order swap via
 * `view.setSidebarOpen` (chrome-on-top when open, content-on-top when closed).
 */
export function useContentInset(viewId: ViewId, { sidebarOpen }: { sidebarOpen: boolean }): void {
  useEffect(() => {
    void aegis.view.setContentInset(viewId, { top: TOOLBAR_H + FAVBAR_H, left: 0 });
  }, [viewId]);
  useEffect(() => {
    void aegis.view.setSidebarOpen(viewId, sidebarOpen);
  }, [viewId, sidebarOpen]);
}
