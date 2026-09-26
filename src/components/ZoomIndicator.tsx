// src/components/ZoomIndicator.tsx
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { formatZoom } from '../lib/zoom';
import { useDialog } from '../hooks/useDialog';
import { useChromePopoverInset } from '../hooks/useChromePopover';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';

export interface ZoomIndicatorProps {
  factor: number;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /** Called when the popover opens or closes. The desktop compositor no longer needs
   *  this (the popover registers its own measured inset, see useChromePopover); the
   *  mobile shell still uses it to lower its native content view. */
  onOpenChange?(open: boolean): void;
}

function Popover({
  factor,
  zoomIn,
  zoomOut,
  reset,
  onClose,
  wrapperRef,
  popoverRef,
}: ZoomIndicatorProps & {
  onClose: () => void;
  wrapperRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
}) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  // Stable: React must not detach the node the inset observer is watching.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      dialogRef.current = el;
      popoverRef.current = el;
    },
    [dialogRef, popoverRef],
  );
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
      ref={setRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className="zoom-indicator__popover"
    >
      <span id={labelId} className="sr-only">
        Page zoom controls
      </span>
      <button type="button" aria-label="Zoom out" onClick={zoomOut}>
        <ZoomOut size={16} aria-hidden="true" />
      </button>
      <span className="zoom-indicator__value">{formatZoom(factor)}</span>
      <button type="button" aria-label="Zoom in" onClick={zoomIn}>
        <ZoomIn size={16} aria-hidden="true" />
      </button>
      <button type="button" aria-label="Reset zoom" onClick={reset}>
        <RotateCcw size={16} aria-hidden="true" />
      </button>
    </div>
  );
}

export function ZoomIndicator({
  factor,
  zoomIn,
  zoomOut,
  reset,
  onOpenChange,
}: ZoomIndicatorProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Self-registering: a popover that renders is a popover that reserves its space,
  // so the content webview can never sit on top of it.
  const [popoverRef, popoverHeight] = useMeasuredHeight<HTMLDivElement>(open);
  useChromePopoverInset('zoom-indicator', popoverHeight);

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  return (
    <div ref={wrapperRef} className="zoom-indicator">
      <button
        type="button"
        className="zoom-indicator__label"
        aria-label="Page zoom"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => handleOpenChange(!open)}
      >
        {formatZoom(factor)}
      </button>
      {open && (
        <Popover
          factor={factor}
          zoomIn={zoomIn}
          zoomOut={zoomOut}
          reset={reset}
          onClose={() => handleOpenChange(false)}
          wrapperRef={wrapperRef}
          popoverRef={popoverRef}
        />
      )}
    </div>
  );
}
