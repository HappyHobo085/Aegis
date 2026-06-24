// src/lib/theme.ts
import type { Settings } from '../../shared/types';

export type ThemeMode = 'system' | 'dark' | 'light';
export type ResolvedTheme = 'dark' | 'light';

const DARK_QUERY = '(prefers-color-scheme: dark)';

/** Map a theme mode + the OS preference to a concrete palette. Pure. */
export function resolveTheme(mode: ThemeMode, prefersDark: boolean): ResolvedTheme {
  if (mode === 'dark' || mode === 'light') return mode;
  return prefersDark ? 'dark' : 'light';
}

/** Whether the OS currently prefers a dark color scheme. Defaults to `true`
 * (Aegis's historic default) when `matchMedia` is unavailable. */
export function prefersDarkScheme(): boolean {
  if (typeof matchMedia !== 'function') return true;
  return matchMedia(DARK_QUERY).matches;
}

/** Relative luminance (WCAG) of an `#rgb`/`#rrggbb` color, 0 (black) … 1 (white).
 *  Returns 0 for an unparseable string. Pure. */
export function luminanceOf(hex: string): number {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return 0;
  let h = m[1];
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
  const channel = (v: number): number => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const r = channel(parseInt(h.slice(0, 2), 16));
  const g = channel(parseInt(h.slice(2, 4), 16));
  const b = channel(parseInt(h.slice(4, 6), 16));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Pick black or white text for the best contrast on a given accent — the contrast
 *  guard so a user-picked light accent doesn't get illegible white text. Pure. */
export function onAccentTextColor(accentHex: string): '#000000' | '#ffffff' {
  const l = luminanceOf(accentHex);
  const contrastWhite = 1.05 / (l + 0.05);
  const contrastBlack = (l + 0.05) / 0.05;
  return contrastBlack >= contrastWhite ? '#000000' : '#ffffff';
}

/** Apply the chrome theme to <html>: accent color (always) + the resolved palette
 * (`data-theme` attribute, read by the [data-theme="…"] token blocks in index.css)
 * + the matching `color-scheme` (so native form controls / scrollbars match). A caller
 * that omits `themeMode` (legacy accent-only callers) is treated as `'system'`. */
export function applyTheme(
  s: Pick<Settings, 'primaryColor'> & Partial<Pick<Settings, 'themeMode'>>,
): void {
  const root = document.documentElement;
  root.style.setProperty('--accent-color', s.primaryColor);
  // Contrast guard: pick legible on-accent text for whatever accent the user chose.
  root.style.setProperty('--text-on-accent', onAccentTextColor(s.primaryColor));
  const resolved = resolveTheme(s.themeMode ?? 'system', prefersDarkScheme());
  root.setAttribute('data-theme', resolved);
  root.style.setProperty('color-scheme', resolved);
}

/** Subscribe to OS color-scheme changes (drives live re-resolve of `'system'`).
 * Returns an unsubscribe function. No-op when `matchMedia` is unavailable. */
export function watchSystemTheme(onChange: () => void): () => void {
  if (typeof matchMedia !== 'function') return () => {};
  const mql = matchMedia(DARK_QUERY);
  mql.addEventListener('change', onChange);
  return () => mql.removeEventListener('change', onChange);
}
