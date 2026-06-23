// src/hooks/useZoom.ts
import { useCallback, useEffect, useState } from 'react';
import type { ViewId } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { clampZoom, formatZoom, stepZoom, ZOOM_DEFAULT } from '../lib/zoom';

/**
 * Owns page-zoom state for the active view.
 *
 * - Seeds `factor` from `aegis.zoom.get(activeId)` on mount and on every tab switch.
 * - Subscribes to `aegis.zoom.onChanged`, applying updates only when `viewId` matches.
 * - `zoomIn` / `zoomOut` step along the Chrome-style discrete zoom ladder, apply
 *   optimistically, then call `aegis.zoom.set` (the `onChanged` event confirms).
 * - `reset` restores `ZOOM_DEFAULT` optimistically and calls `aegis.zoom.reset`.
 * - `setFactor` applies an arbitrary clamped factor.
 * - `percent` is a human-readable string ("100%", "125%", …) derived from `factor`.
 */
export function useZoom(activeId: ViewId): {
  factor: number;
  percent: string;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  setFactor(f: number): void;
} {
  const [factor, setFactor] = useState(ZOOM_DEFAULT);

  // Seed from the backend on mount / active-view change.
  useEffect(() => {
    let live = true;
    void aegis.zoom.get(activeId).then((s) => {
      if (live) setFactor(s.factor);
    });
    return () => {
      live = false;
    };
  }, [activeId]);

  // Subscribe to live zoom changes; filter to the active view.
  useEffect(() => {
    return aegis.zoom.onChanged((s) => {
      if (s.viewId === activeId) setFactor(s.factor);
    });
  }, [activeId]);

  const apply = useCallback(
    (f: number) => {
      const clamped = clampZoom(f);
      setFactor(clamped); // optimistic — onChanged event confirms
      void aegis.zoom.set(activeId, clamped);
    },
    [activeId],
  );

  const zoomIn = useCallback(() => apply(stepZoom(factor, 1)), [apply, factor]);
  const zoomOut = useCallback(() => apply(stepZoom(factor, -1)), [apply, factor]);

  const reset = useCallback(() => {
    setFactor(ZOOM_DEFAULT);
    void aegis.zoom.reset(activeId);
  }, [activeId]);

  return {
    factor,
    percent: formatZoom(factor),
    zoomIn,
    zoomOut,
    reset,
    setFactor: apply,
  };
}
