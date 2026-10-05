// src/popover/ZoomPanel.tsx
//
// The page-zoom controls, rendered on the popover surface.
//
// Only `factor` crosses the boundary: `formatZoom` is a pure helper both documents import, so
// the "150%" string cannot be derived two ways and drift. The chrome's copy stays mounted
// (hidden) and keeps `useDialog`'s focus trap, because focus cannot reach this document — see
// the Phase-4 ledger entry on the accepted Focus Visible regression.
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { formatZoom } from '../lib/zoom';
import { reportAction } from './PopoverPanel';
import type { PanelProps } from './PopoverPanel';

export function ZoomPanel({ shown }: PanelProps): React.JSX.Element | null {
  const factor = (shown.payload as { factor?: unknown }).factor;
  // No clamp of our own: `formatZoom` calls `clampZoom`, which owns the ladder's bounds
  // (0.5–3.0). A second clamp here with different numbers is how the surface and the chrome end
  // up rendering different zoom levels for the same factor.
  if (typeof factor !== 'number' || !Number.isFinite(factor)) return null;

  return (
    <div role="dialog" aria-modal="false" className="zoom-indicator__popover">
      <span className="sr-only">Page zoom controls</span>
      <button
        type="button"
        aria-label="Zoom out"
        onClick={() => void reportAction(shown, 'zoom-out')}
      >
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <span className="zoom-indicator__value">{formatZoom(factor)}</span>
      <button
        type="button"
        aria-label="Zoom in"
        onClick={() => void reportAction(shown, 'zoom-in')}
      >
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        aria-label="Reset zoom"
        onClick={() => void reportAction(shown, 'reset')}
      >
        <RotateCcw size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
