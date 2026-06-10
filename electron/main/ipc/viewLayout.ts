// electron/main/ipc/viewLayout.ts
import { IPC } from '../../../shared/types';
import type { ViewId, ContentInset } from '../../../shared/types';

/**
 * Builds the view-layout IPC handler map (channel -> handler). The renderer
 * computes the content inset (top = toolbar + favorites-bar height; left =
 * sidebar width when open) from known layout constants and reports it here;
 * the handler forwards (top, left) to the supplied setContentInset closure,
 * which repositions the content WebContentsView in main (index.ts).
 */
export function buildViewLayoutHandlers(
  setContentInset: (top: number, left: number) => void,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.viewSetContentInset]: (_viewId: ViewId, inset: ContentInset) =>
      setContentInset(inset.top, inset.left),
  };
}
