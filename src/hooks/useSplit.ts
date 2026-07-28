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
 * Subscribes to `split.state` events so the layout is always in sync
 * with the Rust core. No initial fetch needed — the Rust side emits
 * the current state as soon as the subscriber is registered.
 */
export function useSplit(): UseSplit {
  const [layout, setLayout] = useState<SplitLayout | null>(null);

  // Subscribe to split.state events. The Rust side emits the current
  // layout immediately on subscription, so no separate getState is needed.
  useEffect(() => {
    const unsub = aegis.split.onState((l: SplitLayout | null) => setLayout(l));
    return unsub;
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
