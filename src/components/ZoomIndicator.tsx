// src/components/ZoomIndicator.tsx
import { ZoomIn, ZoomOut, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { formatZoom } from '../lib/zoom';
import { useDialog } from '../hooks/useDialog';
import { useMeasuredRect } from '../hooks/useMeasuredRect';
import { usePopoverSurface } from '../hooks/usePopoverSurface';
import { aegis } from '../lib/ipcClient';

/** The only actions the zoom surface may report. Module-level so `usePopoverSurface` does not
 *  re-send on every render (it keys its effect on the serialised list). */
const ZOOM_ACTIONS: readonly string[] = ['zoom-out', 'zoom-in', 'reset'];

export interface ZoomIndicatorProps {
  factor: number;
  zoomIn(): void;
  zoomOut(): void;
  reset(): void;
  /** Called when the popover opens or closes. The desktop compositor never needed this; the
   *  mobile shell still uses it to lower its native content view — and on mobile there is no
   *  surface, so the chrome's own copy is the visible popover. */
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
  // Measured as a RECT now, and no longer reserving a content-top inset: the popover renders
  // on the surface, which floats over the page. The element measured here is this component's
  // own copy, which stays mounted (hidden) because `useDialog`'s focus trap and these three
  // buttons have to live in a document the keyboard can reach.
  const [popoverRef, popoverRect] = useMeasuredRect<HTMLDivElement>(open);
  usePopoverSurface({
    id: 'zoom-indicator',
    active: open,
    rect: popoverRect,
    itemCount: 0,
    actions: ZOOM_ACTIONS,
    payload: open ? { factor } : null,
  });

  const handleOpenChange = (next: boolean): void => {
    setOpen(next);
    onOpenChange?.(next);
  };

  // The surface reports an ACTION NAME, never a factor: it does not know the ladder, and
  // stepping from the chrome's own state is the only way a zoom level stays consistent with
  // what the toolbar shows.
  useEffect(
    () =>
      aegis.popover.onPicked((pick) => {
        if (pick.id !== 'zoom-indicator') return;
        if (pick.action === 'zoom-in') zoomIn();
        else if (pick.action === 'zoom-out') zoomOut();
        else if (pick.action === 'reset') reset();
      }),
    [zoomIn, zoomOut, reset],
  );

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
