import { useEffect, useRef } from 'react';
import type { TabMeta, ViewId } from '../../shared/types';
import { activateTab, closeTab, discardTab } from '../lib/ipcClient';

/**
 * Drive the native per-tab WebViews (on Android) from the registry's tabs state. The
 * registry decides; this relays to the bridge. Native calls are idempotent/no-op off
 * Android, so we fire on plain state diffs without tracking native's internal map.
 */
export function useMobileTabSync(tabs: TabMeta[], activeId: ViewId): void {
  const prev = useRef<{ tabs: TabMeta[]; activeId: ViewId } | null>(null);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);
    const before = prev.current;

    // Ensure the active tab's WebView exists + is shown (idempotent).
    if (active && (!before || before.activeId !== activeId)) {
      activateTab(activeId, active.url);
    }
    if (before) {
      // Tabs removed from the list -> destroy + forget.
      for (const b of before.tabs) {
        if (!tabs.some((t) => t.id === b.id)) closeTab(b.id);
      }
      // Tabs idle-swept (live: true -> false) -> discard the WebView.
      for (const b of before.tabs) {
        const now = tabs.find((t) => t.id === b.id);
        if (b.live && now && !now.live) discardTab(b.id);
      }
    }
    prev.current = { tabs, activeId };
  }, [tabs, activeId]);
}
