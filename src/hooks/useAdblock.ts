// src/hooks/useAdblock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdblockState, BlockedCount, ListUpdateResult, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { onSyncChange } from '../lib/syncBus';

const emptyState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

/** Returns the parseable hostname of `url`, or null when `url` has no host. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function useAdblock(
  viewId: ViewId,
  currentUrl: string,
): {
  state: AdblockState;
  page: number;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  removeAllowlist(host: string): void;
  clearAllowlist(): void;
  updateNow(): Promise<ListUpdateResult>;
} {
  const [state, setState] = useState<AdblockState>(emptyState);
  const [page, setPage] = useState<number>(0);

  // `currentUrl` is read at call time inside toggleAllowlist; keep a ref so the
  // callback identity stays stable across URL changes.
  const urlRef = useRef<string>(currentUrl);
  urlRef.current = currentUrl;

  useEffect(() => {
    let active = true;
    void aegis.adblock.getState().then((s) => {
      if (!active) return;
      setState(s);
      // Recover the active page's count on mount / tab-switch (live blockedCount events
      // emitted before this subscription — e.g. the restored boot page — were missed).
      setPage(s.pageBlocked ?? 0);
    });
    const unsubscribe = aegis.adblock.onBlockedCount((c: BlockedCount) => {
      if (c.viewId !== viewId) return;
      setPage(c.page);
      // Mirror the monotonic session total so the popover's "this session"
      // figure stays live without an extra getState round-trip.
      setState((prev) => (prev.sessionBlocked === c.session ? prev : { ...prev, sessionBlocked: c.session }));
    });
    // The allowlist is syncable — refetch state (incl. allowlistedHosts) when sync merges it.
    const offSync = onSyncChange('allowlist', () => {
      void aegis.adblock.getState().then((s) => {
        if (active) setState(s);
      });
    });
    return () => {
      active = false;
      unsubscribe();
      offSync();
    };
  }, [viewId]);

  const setEnabled = useCallback((enabled: boolean) => {
    void aegis.adblock.setEnabled(enabled).then((s) => setState(s));
  }, []);

  const toggleAllowlist = useCallback(() => {
    const host = hostOf(urlRef.current);
    if (host === null) return;
    void aegis.adblock.toggleAllowlist(host).then((s) => setState(s));
  }, []);

  const removeAllowlist = useCallback((host: string) => {
    void aegis.adblock.removeAllowlist(host).then((s) => setState(s));
  }, []);

  const clearAllowlist = useCallback(() => {
    void aegis.adblock.clearAllowlist().then((s) => setState(s));
  }, []);

  const updateNow = useCallback((): Promise<ListUpdateResult> => {
    return aegis.lists.updateNow();
  }, []);

  return { state, page, setEnabled, toggleAllowlist, removeAllowlist, clearAllowlist, updateNow };
}
