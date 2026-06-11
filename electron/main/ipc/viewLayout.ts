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
 * Full-window chrome overlays (sidebar, settings modal, favorites manager,
 * permission prompts, error/crash screens) are right/scrim overlays — not a
 * content inset. The renderer reports whether ANY such overlay is active via
 * view.setChromeOverlay, and the handler forwards the boolean to
 * setChromeOverlay, which performs the chrome/content z-order swap in main
 * (chrome on top when active so the overlay paints over the content view).
 */
export function buildViewLayoutHandlers(
  setContentInset: (top: number, left: number) => void,
  setChromeOverlay: (active: boolean) => void,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.viewSetContentInset]: (_viewId: ViewId, inset: ContentInset) =>
      setContentInset(inset.top, inset.left),
    [IPC.viewSetChromeOverlay]: (_viewId: ViewId, active: boolean) => setChromeOverlay(active),
  };
}
