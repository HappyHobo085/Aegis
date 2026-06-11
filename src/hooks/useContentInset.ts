import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H } from '../lib/layout';

/**
 * Top inset is constant (toolbar + always-on favbar). Full-window chrome
 * overlays (sidebar, settings, manager, prompts, error screens) never inset
 * content — they drive a native z-order swap via `view.setChromeOverlay`, which
 * App owns (see the chrome-overlay union effect in App.tsx).
 */
export function useContentInset(viewId: ViewId): void {
  useEffect(() => {
    void aegis.view.setContentInset(viewId, { top: TOOLBAR_H + FAVBAR_H, left: 0 });
  }, [viewId]);
}
