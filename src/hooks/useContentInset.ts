import { useEffect } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

/**
 * Reports the chrome top inset to the Rust core so the content webview sits
 * below the chrome. The caller computes `topInset` (typically from
 * `useChromeHeights`) and passes it here; this hook is solely responsible
 * for the IPC call.
 *
 * Full-window chrome overlays (sidebar, settings, manager, prompts, error
 * screens) never inset content — they drive a native z-order swap via
 * `view.setChromeOverlay`, which App owns (see the chrome-overlay union
 * effect in App.tsx).
 */
export function useContentInset(viewId: ViewId, topInset: number): void {
  useEffect(() => {
    void aegis.view.setContentInset(viewId, { top: topInset, left: 0 });
  }, [viewId, topInset]);
}
