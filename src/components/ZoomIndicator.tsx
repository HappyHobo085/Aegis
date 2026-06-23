// src/components/ZoomIndicator.tsx
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useState } from 'react';
import { formatZoom } from '../lib/zoom';

export interface ZoomIndicatorProps {
  factor: number;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

export function ZoomIndicator({ factor, zoomIn, zoomOut, reset }: ZoomIndicatorProps) {
  const [open, setOpen] = useState(false);
  return (
    <div className="zoom-indicator">
      <button
        type="button"
        className="zoom-indicator__label"
        aria-label="Page zoom"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {formatZoom(factor)}
      </button>
      {open && (
        <div className="zoom-indicator__popover" role="menu">
          <button type="button" aria-label="Zoom out" onClick={zoomOut}>
            <ZoomOut size={16} />
          </button>
          <span className="zoom-indicator__value">{formatZoom(factor)}</span>
          <button type="button" aria-label="Zoom in" onClick={zoomIn}>
            <ZoomIn size={16} />
          </button>
          <button type="button" aria-label="Reset zoom" onClick={reset}>
            <RotateCcw size={16} />
          </button>
        </div>
      )}
    </div>
  );
}
