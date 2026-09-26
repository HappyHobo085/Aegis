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

/** Parse `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa` into channels, or `null` if the string
 *  is not one of those shapes. `Settings.primaryColor` is validated to exactly these forms
 *  on the Rust side (`settings::validate_setting`), but this stays defensive because the
 *  value can also arrive from an imported `data.export` bundle. Pure. */
export function parseHexColor(hex: string): { r: number; g: number; b: number; a: number } | null {
  const m = /^#?([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(hex.trim());
  if (!m) return null;
  let h = m[1];
  if (h.length === 3 || h.length === 4) {
    // `#abc` → `aabbcc`, `#abcd` → `aabbccdd`
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
    a: h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1,
  };
}

/** Blend `hex` toward `toward` by `t` (0 = unchanged, 1 = fully `toward`). Pure. */
function mixToward(hex: string, toward: string, t: number): string {
  const from = parseHexColor(hex);
  const to = parseHexColor(toward);
  if (!from || !to) return hex;
  const ch = (a: number, b: number): number => Math.round(a + (b - a) * t);
  return `#${[ch(from.r, to.r), ch(from.g, to.g), ch(from.b, to.b)]
    .map((v) => v.toString(16).padStart(2, '0'))
    .join('')}`;
}

/** Every CSS custom property the user's accent choice has to drive, derived from it.
 *
 *  `index.css` defines `--accent` / `--on-accent` as the CANONICAL tokens and
 *  `--accent-color` / `--text-on-accent` as legacy aliases pointing at them. `applyTheme`
 *  used to write only the two aliases, so the ~44 rules reading `var(--accent)` /
 *  `var(--on-accent)` kept the default indigo — the picker appeared to do nothing for a
 *  third of the UI — and `onAccentTextColor()`'s contrast decision was written to a token
 *  nothing read, leaving `color: var(--on-accent)` hard-pinned to `#ffffff`, i.e. a light
 *  accent rendered white-on-near-white. `--accent-hover` / `--accent-gradient` /
 *  `--accent-glow` were never written at all, so hover states and gradients also stayed
 *  indigo whatever the user picked. Both spellings are now set; the canonical ones are
 *  what matter. */
export interface AccentTokens {
  accent: string;
  onAccent: string;
  hover: string;
  gradient: string;
  glow: string;
  /** Legacy alias values, kept in sync for the rules still using the old names. */
  accentColor: string;
  textOnAccent: string;
}

/** Derive the full accent token set. Pure. */
export function accentTokens(accentHex: string): AccentTokens {
  const rgb = parseHexColor(accentHex);
  const onAccent = onAccentTextColor(accentHex);
  // Unparseable accent: keep the caller's string for the accent itself and degrade the
  // derived tokens, rather than writing invalid custom properties. (The Rust validator
  // rejects these upstream; this only guards an imported bundle or a hand-set DOM style.)
  if (!rgb) {
    return {
      accent: accentHex,
      onAccent,
      hover: accentHex,
      gradient: `linear-gradient(135deg, ${accentHex}, ${accentHex})`,
      glow: '0 0 20px rgba(0, 0, 0, 0.3)',
      accentColor: accentHex,
      textOnAccent: onAccent,
    };
  }
  return {
    accent: accentHex,
    onAccent,
    hover: mixToward(accentHex, '#ffffff', 0.22),
    gradient: `linear-gradient(135deg, ${accentHex}, ${mixToward(accentHex, '#ffffff', 0.38)})`,
    glow: `0 0 20px rgba(${rgb.r}, ${rgb.g}, ${rgb.b}, 0.3)`,
    accentColor: accentHex,
    textOnAccent: onAccent,
  };
}

/** Apply the chrome theme to <html>: accent color (always) + the resolved palette
 * (`data-theme` attribute, read by the [data-theme="…"] token blocks in index.css)
 * + the matching `color-scheme` (so native form controls / scrollbars match). A caller
 * that omits `themeMode` (legacy accent-only callers) is treated as `'system'`. */
export function applyTheme(
  s: Pick<Settings, 'primaryColor'> & Partial<Pick<Settings, 'themeMode'>>,
): void {
  const root = document.documentElement;
  const t = accentTokens(s.primaryColor);
  // Canonical tokens FIRST — these are the ones index.css's ~44 `var(--accent)` /
  // `var(--on-accent)` rules actually read, and the contrast guard only takes effect
  // because `--on-accent` is one of them.
  root.style.setProperty('--accent', t.accent);
  root.style.setProperty('--on-accent', t.onAccent);
  root.style.setProperty('--accent-hover', t.hover);
  root.style.setProperty('--accent-gradient', t.gradient);
  root.style.setProperty('--accent-glow', t.glow);
  // Legacy aliases, kept in sync for the rules still referencing the old names.
  root.style.setProperty('--accent-color', t.accentColor);
  root.style.setProperty('--text-on-accent', t.textOnAccent);
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
