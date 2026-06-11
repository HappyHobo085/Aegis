// electron/main/ipc/viewLayout.ts
import { IPC } from '../../../shared/types';
import type { ViewId, ContentInset } from '../../../shared/types';

/**
 * Builds the view-layout IPC handler map (channel -> handler). The renderer
 * computes the content inset (top = toolbar + favorites-bar height; left =
 * sidebar width when open) from known layout constants and reports it here;
 * the handler forwards (top, left) to the supplied setContentInset closure,
 * which repositions the content WebContentsView in main (index.ts).
 *
 * The sidebar is a right overlay (not a content inset): the renderer reports the
 * open/closed state via view.setSidebarOpen, and the handler forwards the boolean
 * to setSidebarOpen, which performs the chrome/content z-order swap in main.
 */
export function buildViewLayoutHandlers(
  setContentInset: (top: number, left: number) => void,
  setSidebarOpen: (open: boolean) => void,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.viewSetContentInset]: (_viewId: ViewId, inset: ContentInset) =>
      setContentInset(inset.top, inset.left),
    [IPC.viewSetSidebarOpen]: (_viewId: ViewId, open: boolean) => setSidebarOpen(open),
  };
}
