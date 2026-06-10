import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H, SIDEBAR_W } from '../lib/layout';

/**
 * Reports the content-view inset to main whenever the sidebar toggles (and once
 * on mount). The favorites bar is always-on in Phase 3, so the top inset is a
 * constant TOOLBAR_H + FAVBAR_H; the sidebar toggles only the left inset.
 */
export function useContentInset(viewId: ViewId, { sidebarOpen }: { sidebarOpen: boolean }): void {
  useEffect(() => {
    const top = TOOLBAR_H + FAVBAR_H;
    const left = sidebarOpen ? SIDEBAR_W : 0;
    void aegis.view.setContentInset(viewId, { top, left });
  }, [viewId, sidebarOpen]);
}
