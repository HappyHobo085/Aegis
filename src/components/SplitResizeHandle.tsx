// src/components/SplitResizeHandle.tsx
import { memo, useCallback, useRef } from 'react';

export interface SplitResizeHandleProps {
  orientation: 'vertical' | 'horizontal';
  /** Pixel position (left edge) of the handle. */
  x: number;
  /** Pixel position (top edge) of the handle. */
  y: number;
  /** Pixel width of the handle. */
  width: number;
  /** Pixel height of the handle. */
  height: number;
  onDrag(delta: number): void;
  onDragEnd(): void;
}

/**
 * A thin draggable divider bar between split panes. Tracks pointer events
 * (pointerdown -> pointermove -> pointerup) so the parent can update pane
 * dimensions in real time. Styled via `.split-resize-handle` in index.css.
 */
export const SplitResizeHandle = memo(function SplitResizeHandle({
  orientation,
  x,
  y,
  width,
  height,
  onDrag,
  onDragEnd,
}: SplitResizeHandleProps) {
  const startPos = useRef(0);

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      e.stopPropagation();
      // Capture the pointer so we continue receiving move/up even if the
      // cursor leaves the handle.
      (e.target as HTMLElement).setPointerCapture(e.pointerId);

      startPos.current = orientation === 'vertical' ? e.clientX : e.clientY;

      const onPointerMove = (ev: PointerEvent): void => {
        const current = orientation === 'vertical' ? ev.clientX : ev.clientY;
        const delta = current - startPos.current;
        if (delta !== 0) {
          startPos.current = current;
          onDrag(delta);
        }
      };

      const onPointerUp = (): void => {
        window.removeEventListener('pointermove', onPointerMove);
        window.removeEventListener('pointerup', onPointerUp);
        onDragEnd();
      };

      window.addEventListener('pointermove', onPointerMove);
      window.addEventListener('pointerup', onPointerUp);
    },
    [orientation, onDrag, onDragEnd],
  );

  return (
    <div
      className={`split-resize-handle split-resize-handle--${orientation}`}
      role="separator"
      aria-orientation={orientation}
      style={{ left: x, top: y, width, height }}
      onPointerDown={handlePointerDown}
    />
  );
});
