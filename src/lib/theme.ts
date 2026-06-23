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

/** Apply the chrome theme to <html>: accent color (always) + the resolved palette
 * (`data-theme` attribute, read by the [data-theme="…"] token blocks in index.css)
 * + the matching `color-scheme` (so native form controls / scrollbars match). A caller
 * that omits `themeMode` (legacy accent-only callers) is treated as `'system'`. */
export function applyTheme(
  s: Pick<Settings, 'primaryColor'> & Partial<Pick<Settings, 'themeMode'>>,
): void {
  const root = document.documentElement;
  root.style.setProperty('--accent-color', s.primaryColor);
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
