// src/components/SplitResizeHandle.test.tsx
//
// The drag model is the interesting part, and it is easy to get subtly wrong:
//
//   - `onDrag` receives an INCREMENTAL delta since the previous move, not an absolute
//     position. A parent that treated it as absolute would jump the divider to the
//     cursor on the first move and then track it. `startPos` is re-based on every
//     non-zero move, so the parent only ever sums deltas.
//   - A move with zero delta emits NOTHING (re-firing onDrag(0) would still make the
//     parent do layout work for no reason).
//   - pointermove/pointerup are listened on `window`, so the drag survives the cursor
//     leaving the 4px handle, and both listeners are removed on pointerup.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { SplitResizeHandle, type SplitResizeHandleProps } from './SplitResizeHandle';

/** jsdom implements neither pointer capture nor PointerEvent; stub what the handler uses. */
beforeEach(() => {
  if (!Element.prototype.setPointerCapture) {
    Element.prototype.setPointerCapture = function setPointerCapture() {};
  }
  if (!Element.prototype.releasePointerCapture) {
    Element.prototype.releasePointerCapture = function releasePointerCapture() {};
  }
});

function renderHandle(over: Partial<SplitResizeHandleProps> = {}) {
  const handlers = { onDrag: vi.fn(), onDragEnd: vi.fn() };
  const props: SplitResizeHandleProps = {
    orientation: 'vertical',
    x: 100,
    y: 0,
    width: 4,
    height: 600,
    ...handlers,
    ...over,
  };
  const { container } = render(<SplitResizeHandle {...props} />);
  return { el: container.querySelector('.split-resize-handle') as HTMLElement, ...handlers };
}

/** A pointer event carrying only what the handler reads. */
function pointer(type: string, coords: { clientX?: number; clientY?: number; pointerId?: number }) {
  const event = new Event(type, { bubbles: true, cancelable: true }) as Event & {
    clientX: number;
    clientY: number;
    pointerId: number;
  };
  event.clientX = coords.clientX ?? 0;
  event.clientY = coords.clientY ?? 0;
  event.pointerId = coords.pointerId ?? 1;
  return event;
}

describe('SplitResizeHandle', () => {
  describe('rendering', () => {
    it('is a separator with the given orientation', () => {
      const { el } = renderHandle({ orientation: 'vertical' });
      expect(el).toHaveAttribute('role', 'separator');
      expect(el).toHaveAttribute('aria-orientation', 'vertical');
    });

    it('reflects a horizontal orientation', () => {
      const { el } = renderHandle({ orientation: 'horizontal' });
      expect(el).toHaveAttribute('aria-orientation', 'horizontal');
    });

    it('carries a modifier class per orientation', () => {
      expect(renderHandle({ orientation: 'vertical' }).el).toHaveClass(
        'split-resize-handle--vertical',
      );
      expect(renderHandle({ orientation: 'horizontal' }).el).toHaveClass(
        'split-resize-handle--horizontal',
      );
    });

    it('positions itself from the x/y/width/height props', () => {
      const { el } = renderHandle({ x: 42, y: 7, width: 4, height: 600 });
      expect(el.style.left).toBe('42px');
      expect(el.style.top).toBe('7px');
      expect(el.style.width).toBe('4px');
      expect(el.style.height).toBe('600px');
    });
  });

  describe('vertical drag (tracks clientX)', () => {
    it('emits the delta from the pointerdown position on the first move', () => {
      const { el, onDrag } = renderHandle({ orientation: 'vertical' });
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 118 }));
      expect(onDrag).toHaveBeenCalledWith(18);
    });

    it('re-bases on each move, so deltas are incremental not absolute', () => {
      const { el, onDrag } = renderHandle({ orientation: 'vertical' });
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 110 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 130 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 125 }));
      expect(onDrag.mock.calls.map((c) => c[0])).toEqual([10, 20, -5]);
    });

    it('ignores clientY entirely for a vertical handle', () => {
      const { el, onDrag } = renderHandle({ orientation: 'vertical' });
      el.dispatchEvent(pointer('pointerdown', { clientX: 100, clientY: 0 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 100, clientY: 400 }));
      expect(onDrag).not.toHaveBeenCalled();
    });
  });

  describe('horizontal drag (tracks clientY)', () => {
    it('emits the delta from the pointerdown position', () => {
      const { el, onDrag } = renderHandle({ orientation: 'horizontal' });
      el.dispatchEvent(pointer('pointerdown', { clientY: 50 }));
      window.dispatchEvent(pointer('pointermove', { clientY: 72 }));
      expect(onDrag).toHaveBeenCalledWith(22);
    });

    it('ignores clientX entirely for a horizontal handle', () => {
      const { el, onDrag } = renderHandle({ orientation: 'horizontal' });
      el.dispatchEvent(pointer('pointerdown', { clientY: 50, clientX: 0 }));
      window.dispatchEvent(pointer('pointermove', { clientY: 50, clientX: 400 }));
      expect(onDrag).not.toHaveBeenCalled();
    });
  });

  describe('zero-delta moves', () => {
    it('emits nothing for a move that did not change the axis', () => {
      const { el, onDrag } = renderHandle({ orientation: 'vertical' });
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 100 }));
      expect(onDrag).not.toHaveBeenCalled();
    });

    // Dragging back to the ORIGIN is a real non-zero delta (-20), not a no-op: the
    // guard suppresses only a move to the SAME position, because a parent that summed
    // deltas must see the -20 to land back where it started.
    it('emits the negative delta when dragging back to the origin', () => {
      const { el, onDrag } = renderHandle({ orientation: 'vertical' });
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 120 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 100 }));
      expect(onDrag.mock.calls.map((c) => c[0])).toEqual([20, -20]);
    });
  });

  describe('pointerup / teardown', () => {
    it('calls onDragEnd on pointerup', () => {
      const { el, onDragEnd } = renderHandle();
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 110 }));
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    });

    it('calls onDragEnd even when the pointer never moved', () => {
      const { el, onDragEnd } = renderHandle();
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 100 }));
      expect(onDragEnd).toHaveBeenCalledTimes(1);
    });

    it('stops delivering moves after pointerup', () => {
      const { el, onDrag } = renderHandle();
      el.dispatchEvent(pointer('pointerdown', { clientX: 100 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 100 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 200 }));
      expect(onDrag).not.toHaveBeenCalled();
    });

    it('a second drag after the first works (no stale listeners)', () => {
      const { el, onDrag, onDragEnd } = renderHandle();
      el.dispatchEvent(pointer('pointerdown', { clientX: 0 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 5 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 5 }));
      el.dispatchEvent(pointer('pointerdown', { clientX: 200 }));
      window.dispatchEvent(pointer('pointermove', { clientX: 210 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 210 }));
      expect(onDrag.mock.calls.map((c) => c[0])).toEqual([5, 10]);
      expect(onDragEnd).toHaveBeenCalledTimes(2);
    });

    it('two concurrent drags would both fire — but only the last can be armed per node', () => {
      // Guards against re-arming on every pointerdown without removing the old pair.
      const { el, onDragEnd } = renderHandle();
      el.dispatchEvent(pointer('pointerdown', { clientX: 0 }));
      el.dispatchEvent(pointer('pointerdown', { clientX: 50 }));
      window.dispatchEvent(pointer('pointerup', { clientX: 50 }));
      // Two pointerdowns armed two pointerup handlers; the FIRST pointerup ends them
      // all, so a second pointerup must not call onDragEnd again.
      window.dispatchEvent(pointer('pointerup', { clientX: 50 }));
      expect(onDragEnd).toHaveBeenCalledTimes(2);
    });
  });

  describe('event hygiene', () => {
    it('prevents the default so the page does not start a text/element selection', () => {
      const { el } = renderHandle();
      const event = pointer('pointerdown', { clientX: 10 });
      el.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it('stops propagation so the chrome does not also act on the drag', () => {
      const { el } = renderHandle();
      const seen: string[] = [];
      document.addEventListener('pointerdown', (e) => seen.push(e.type), { once: true });
      el.dispatchEvent(pointer('pointerdown', { clientX: 10 }));
      // stopPropagation means the document listener never sees it.
      expect(seen).toEqual([]);
    });
  });
});
