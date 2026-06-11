// src/hooks/useHorizontalWheel.test.tsx
import { describe, it, expect } from 'vitest';
import { useState } from 'react';
import { render, fireEvent } from '@testing-library/react';
import { useHorizontalWheel } from './useHorizontalWheel';

function Strip() {
  const ref = useHorizontalWheel<HTMLDivElement>();
  return <div ref={ref} data-testid="strip" />;
}

// The strip mounts AFTER the host (like the sidebar tab strip, which only renders
// while the sidebar is open). The callback ref must bind the listener when the
// element finally appears — a useEffect([]) hook would miss it.
function LateStrip() {
  const ref = useHorizontalWheel<HTMLDivElement>();
  const [show, setShow] = useState(false);
  return (
    <>
      <button onClick={() => setShow(true)}>show</button>
      {show && <div ref={ref} data-testid="late" />}
    </>
  );
}

function setDims(el: HTMLElement, scrollWidth: number, clientWidth: number): void {
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  el.scrollLeft = 0;
}

describe('useHorizontalWheel', () => {
  it('translates a vertical wheel into horizontal scroll when overflowing', () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId('strip');
    setDims(el, 500, 100);

    const ev = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    el.dispatchEvent(ev);

    expect(el.scrollLeft).toBe(120);
    expect(ev.defaultPrevented).toBe(true);
  });

  it('does nothing when content does not overflow', () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId('strip');
    setDims(el, 100, 100);

    const ev = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    el.dispatchEvent(ev);

    expect(el.scrollLeft).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('ignores a horizontal wheel (deltaY === 0)', () => {
    const { getByTestId } = render(<Strip />);
    const el = getByTestId('strip');
    setDims(el, 500, 100);

    const ev = new WheelEvent('wheel', { deltaY: 0, deltaX: 120, cancelable: true });
    el.dispatchEvent(ev);

    expect(el.scrollLeft).toBe(0);
    expect(ev.defaultPrevented).toBe(false);
  });

  it('binds the listener to a strip that mounts after the host (sidebar case)', () => {
    const { getByText, getByTestId } = render(<LateStrip />);
    // Strip not in the DOM yet.
    expect(() => getByTestId('late')).toThrow();
    fireEvent.click(getByText('show'));
    const el = getByTestId('late');
    setDims(el, 500, 100);

    const ev = new WheelEvent('wheel', { deltaY: 120, cancelable: true });
    el.dispatchEvent(ev);

    expect(el.scrollLeft).toBe(120);
    expect(ev.defaultPrevented).toBe(true);
  });
});
