import { useEffect, useRef } from 'react';
import type { TabMeta, ViewId } from '../../shared/types';
import { activateTab, closeTab, discardTab } from '../lib/ipcClient';

/**
 * Drive the native per-tab WebViews (on Android) from the registry's tabs state. The
 * registry decides; this relays to the bridge. Native calls are idempotent/no-op off
 * Android, so we fire on plain state diffs without tracking native's internal map.
 */
export function useMobileTabSync(tabs: TabMeta[], activeId: ViewId): void {
  const prevTabs = useRef<TabMeta[] | null>(null);
  // The id we last told native to activate. Tracked separately from the tabs diff:
  // useTabs seeds an EMPTY {tabs:[], activeId:1} state before its async list() resolves,
  // so keying activation off a prev-activeId diff would skip the very first activate when
  // the registry's real active id is also 1 (the common fresh-start case) — leaving no
  // native WebView and a dead address bar. Activate whenever the active tab first appears.
  const activatedId = useRef<ViewId | null>(null);

  useEffect(() => {
    const active = tabs.find((t) => t.id === activeId);

    // Ensure the active tab's WebView exists + is shown. Fires when the active tab first
    // becomes available and on every active-id change. A discarded tab is only ever
    // resurrected via tabs.activate() (which changes activeId), so this also covers
    // re-showing a discarded tab.
    if (active && activatedId.current !== activeId) {
      activateTab(activeId, active.url, active.private);
      activatedId.current = activeId;
    }

    const before = prevTabs.current;
    if (before) {
      // Tabs removed from the list -> destroy + forget.
      for (const b of before) {
        if (!tabs.some((t) => t.id === b.id)) closeTab(b.id);
      }
      // Tabs idle-swept (live: true -> false) -> discard the WebView.
      for (const b of before) {
        const now = tabs.find((t) => t.id === b.id);
        if (b.live && now && !now.live) discardTab(b.id);
      }
    }
    prevTabs.current = tabs;
  }, [tabs, activeId]);
}
