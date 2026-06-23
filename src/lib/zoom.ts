export const ZOOM_MIN = 0.5;
export const ZOOM_MAX = 3.0;
export const ZOOM_DEFAULT = 1.0;

/** Chrome-style discrete zoom ladder. */
export const ZOOM_STEPS = [0.5, 0.67, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0];

export function clampZoom(f: number): number {
  if (!Number.isFinite(f)) return ZOOM_DEFAULT;
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, f));
}

/** Snap `f` to the nearest ladder rung, then move `dir` (+1 in / −1 out) one rung; clamped. */
export function stepZoom(f: number, dir: 1 | -1): number {
  const cur = clampZoom(f);
  // nearest rung index
  let i = 0;
  let best = Infinity;
  ZOOM_STEPS.forEach((s, idx) => {
    const d = Math.abs(s - cur);
    if (d < best) {
      best = d;
      i = idx;
    }
  });
  const ni = Math.min(ZOOM_STEPS.length - 1, Math.max(0, i + dir));
  return ZOOM_STEPS[ni];
}

/** "100%", "125%" … for the indicator. */
export function formatZoom(f: number): string {
  return `${Math.round(clampZoom(f) * 100)}%`;
}
