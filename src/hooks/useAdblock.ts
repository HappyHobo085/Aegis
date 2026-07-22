// src/hooks/useAdblock.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { AdblockState, BlockedCount, ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { onSyncChange } from '../lib/syncBus';
import { hostOf } from '../lib/url';

const emptyState: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
};

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
  /** Autopilot seeding only — directly sets the allowlisted hosts without an IPC round-trip. */
  _setAllowlistedHosts(hosts: string[]): void;
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
      setState((prev) =>
        prev.sessionBlocked === c.session ? prev : { ...prev, sessionBlocked: c.session },
      );
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

  return {
    state,
    page,
    setEnabled,
    toggleAllowlist,
    removeAllowlist,
    clearAllowlist,
    _setAllowlistedHosts: (hosts: string[]) =>
      setState((prev) => ({ ...prev, allowlistedHosts: hosts })),
  };
}
