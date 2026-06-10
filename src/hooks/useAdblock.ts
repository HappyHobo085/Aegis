// src/hooks/useAdblock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdblockState, BlockedCount, ListUpdateResult, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

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
      if (active) setState(s);
    });
    const unsubscribe = aegis.adblock.onBlockedCount((c: BlockedCount) => {
      if (c.viewId !== viewId) return;
      setPage(c.page);
      // Mirror the monotonic session total so the popover's "this session"
      // figure stays live without an extra getState round-trip.
      setState((prev) => (prev.sessionBlocked === c.session ? prev : { ...prev, sessionBlocked: c.session }));
    });
    return () => {
      active = false;
      unsubscribe();
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

  const updateNow = useCallback((): Promise<ListUpdateResult> => {
    return aegis.lists.updateNow();
  }, []);

  return { state, page, setEnabled, toggleAllowlist, updateNow };
}
