// src/components/ZoomIndicator.tsx
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { formatZoom } from '../lib/zoom';
import { useDialog } from '../hooks/useDialog';

export interface ZoomIndicatorProps {
  factor: number;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
}

function Popover({
  factor,
  zoomIn,
  zoomOut,
  reset,
  onClose,
  wrapperRef,
}: ZoomIndicatorProps & { onClose: () => void; wrapperRef: RefObject<HTMLElement | null> }) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper && !wrapper.contains(event.target as Node)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [wrapperRef]);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className="zoom-indicator__popover"
    >
      <span id={labelId} className="sr-only">
        Page zoom controls
      </span>
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
  );
}

export function ZoomIndicator({ factor, zoomIn, zoomOut, reset }: ZoomIndicatorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={wrapperRef} className="zoom-indicator">
      <button
        type="button"
        className="zoom-indicator__label"
        aria-label="Page zoom"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {formatZoom(factor)}
      </button>
      {open && (
        <Popover
          factor={factor}
          zoomIn={zoomIn}
          zoomOut={zoomOut}
          reset={reset}
          onClose={() => setOpen(false)}
          wrapperRef={wrapperRef}
        />
      )}
    </div>
  );
}
