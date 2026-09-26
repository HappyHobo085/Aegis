import { useCallback, useEffect, useState } from 'react';
import type { SplitLayout } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export interface UseSplit {
  /** Current split layout, or null when split mode is inactive. */
  layout: SplitLayout | null;
  /** Enter split-view mode with the given tab ids (2-4 panes). */
  enterSplit(tabIds: number[]): Promise<void>;
  /** Exit split-view mode, returning to single-pane. */
  exitSplit(): Promise<void>;
  /** Resize a specific pane by its tab id. */
  resizePane(paneId: number, width: number, height: number): Promise<void>;
  /** Focus a specific pane. */
  focusPane(paneId: number): Promise<void>;
}

/**
 * Owns split-view state and exposes typed mutation methods. Follows the
 * one-hook-per-domain convention — kept separate from useTabs so each
 * hook stays focused.
 *
 * Subscribes to `split.state` events so the layout stays in sync with the
 * Rust core, AND seeds from `split.getState` on mount. The fetch is required,
 * not a nicety: Rust only emits `split.state` from its four mutation handlers
 * and keeps the layout in process-global in-memory state that is never
 * persisted, so a remounting renderer (a data-import reload, hot reload, a
 * conditional-render branch flip) would otherwise subscribe, wait for an event
 * that never comes, and render single-pane while the core still holds N live
 * split webviews.
 */
export function useSplit(): UseSplit {
  const [layout, setLayout] = useState<SplitLayout | null>(null);

  useEffect(() => {
    // Subscribe first, then fetch, so a mutation racing the fetch cannot be
    // missed between the snapshot and the listener becoming live.
    const unsub = aegis.split.onState((l: SplitLayout | null) => setLayout(l));
    let cancelled = false;
    void aegis.split.getState().then(
      (l) => {
        if (!cancelled) setLayout(l);
      },
      () => {
        /* fetch failed: the event subscription is still the source of truth */
      },
    );
    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  const enterSplit = useCallback(async (tabIds: number[]) => {
    await aegis.split.enter(tabIds);
  }, []);

  const exitSplit = useCallback(async () => {
    await aegis.split.exit();
  }, []);

  const resizePane = useCallback(async (paneId: number, width: number, height: number) => {
    await aegis.split.resize(paneId, width, height);
  }, []);

  const focusPane = useCallback(async (paneId: number) => {
    await aegis.split.focus(paneId);
  }, []);

  return { layout, enterSplit, exitSplit, resizePane, focusPane };
}
