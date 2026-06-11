// src/hooks/useHorizontalWheel.test.tsx
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { useHorizontalWheel } from './useHorizontalWheel';

function Strip() {
  const ref = useHorizontalWheel<HTMLDivElement>();
  return <div ref={ref} data-testid="strip" />;
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
});
