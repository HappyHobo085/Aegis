import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { TOOLBAR_H, FAVBAR_H, TABSTRIP_H } from '../lib/layout';

/**
 * Reports the chrome top inset to the Rust core so the content webview sits
 * below the chrome. Inset = toolbar + always-on favbar + optional tab strip
 * (desktop-only; pass showTabStrip=false on mobile). Full-window chrome
 * overlays (sidebar, settings, manager, prompts, error screens) never inset
 * content — they drive a native z-order swap via `view.setChromeOverlay`, which
 * App owns (see the chrome-overlay union effect in App.tsx).
 */
export function useContentInset(
  viewId: ViewId,
  showTabStrip: boolean,
  extraTop = 0,
): void {
  useEffect(() => {
    const top = TOOLBAR_H + FAVBAR_H + (showTabStrip ? TABSTRIP_H : 0) + extraTop;
    void aegis.view.setContentInset(viewId, { top, left: 0 });
  }, [viewId, showTabStrip, extraTop]);
}
