import { describe, it, expect } from 'vitest';
import { clampZoom, stepZoom, formatZoom, ZOOM_MIN, ZOOM_MAX } from './zoom';

describe('zoom math', () => {
  it('clamps to range and guards non-finite', () => {
    expect(clampZoom(0.1)).toBe(ZOOM_MIN);
    expect(clampZoom(9)).toBe(ZOOM_MAX);
    expect(clampZoom(1.25)).toBe(1.25);
    expect(clampZoom(NaN)).toBe(1.0);
  });
  it('steps along the ladder and stops at the ends', () => {
    expect(stepZoom(1.0, 1)).toBe(1.1);
    expect(stepZoom(1.0, -1)).toBe(0.9);
    expect(stepZoom(0.5, -1)).toBe(0.5); // clamped at min
    expect(stepZoom(3.0, 1)).toBe(3.0); // clamped at max
    expect(stepZoom(1.18, 1)).toBe(1.5); // snaps to 1.25 then +1
  });
  it('formats percent', () => {
    expect(formatZoom(1.0)).toBe('100%');
    expect(formatZoom(1.25)).toBe('125%');
  });
});
