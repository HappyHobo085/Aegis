// src/lib/theme.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  applyTheme,
  resolveTheme,
  prefersDarkScheme,
  watchSystemTheme,
  onAccentTextColor,
  luminanceOf,
  parseHexColor,
  accentTokens,
} from './theme';

/** Install a matchMedia mock that reports `dark` and returns the listener controls. */
function mockMatchMedia(prefersDark: boolean) {
  const listeners = new Set<() => void>();
  const mql = {
    matches: prefersDark,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (_: string, cb: () => void) => listeners.add(cb),
    removeEventListener: (_: string, cb: () => void) => listeners.delete(cb),
    // Legacy fallback (some engines); our code prefers addEventListener.
    addListener: (cb: () => void) => listeners.add(cb),
    removeListener: (cb: () => void) => listeners.delete(cb),
  };
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => mql),
  );
  return { fire: () => listeners.forEach((cb) => cb()), listenerCount: () => listeners.size };
}

afterEach(() => {
  document.documentElement.style.removeProperty('--accent-color');
  document.documentElement.style.removeProperty('color-scheme');
  document.documentElement.removeAttribute('data-theme');
  vi.unstubAllGlobals();
});

describe('resolveTheme', () => {
  it('returns the explicit mode for dark and light', () => {
    expect(resolveTheme('dark', true)).toBe('dark');
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('light', false)).toBe('light');
  });

  it('follows the OS preference for system', () => {
    expect(resolveTheme('system', true)).toBe('dark');
    expect(resolveTheme('system', false)).toBe('light');
  });
});

describe('prefersDarkScheme', () => {
  it('reads matchMedia (prefers-color-scheme: dark)', () => {
    mockMatchMedia(true);
    expect(prefersDarkScheme()).toBe(true);
    mockMatchMedia(false);
    expect(prefersDarkScheme()).toBe(false);
  });

  it('defaults to dark when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    expect(prefersDarkScheme()).toBe(true);
  });
});

describe('applyTheme', () => {
  it('sets --accent-color on :root from the primaryColor setting', () => {
    mockMatchMedia(true);
    applyTheme({ primaryColor: '#ff5500', themeMode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#ff5500');
  });

  it('sets --text-on-accent for contrast: white on a dark accent, black on a light accent', () => {
    mockMatchMedia(true);
    applyTheme({ primaryColor: '#2563eb', themeMode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--text-on-accent')).toBe('#ffffff');
    applyTheme({ primaryColor: '#ffe066', themeMode: 'dark' });
    expect(document.documentElement.style.getPropertyValue('--text-on-accent')).toBe('#000000');
  });

  it('sets data-theme="dark" and color-scheme dark for themeMode dark', () => {
    mockMatchMedia(false); // OS prefers light, but explicit dark must win
    applyTheme({ primaryColor: '#111', themeMode: 'dark' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('dark');
  });

  it('sets data-theme="light" and color-scheme light for themeMode light', () => {
    mockMatchMedia(true); // OS prefers dark, but explicit light must win
    applyTheme({ primaryColor: '#111', themeMode: 'light' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    expect(document.documentElement.style.getPropertyValue('color-scheme')).toBe('light');
  });

  it('resolves system to the OS preference', () => {
    mockMatchMedia(false);
    applyTheme({ primaryColor: '#111', themeMode: 'system' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
    mockMatchMedia(true);
    applyTheme({ primaryColor: '#111', themeMode: 'system' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('dark');
  });

  it('treats a missing themeMode as system', () => {
    mockMatchMedia(false);
    applyTheme({ primaryColor: '#111' });
    expect(document.documentElement.getAttribute('data-theme')).toBe('light');
  });
});

describe('watchSystemTheme', () => {
  it('invokes the callback when the OS preference changes and unsubscribes cleanly', () => {
    const m = mockMatchMedia(true);
    const onChange = vi.fn();
    const off = watchSystemTheme(onChange);
    expect(m.listenerCount()).toBe(1);
    m.fire();
    expect(onChange).toHaveBeenCalledTimes(1);
    off();
    expect(m.listenerCount()).toBe(0);
  });

  it('is a no-op (returns a usable cleanup) when matchMedia is unavailable', () => {
    vi.stubGlobal('matchMedia', undefined);
    const off = watchSystemTheme(vi.fn());
    expect(() => off()).not.toThrow();
  });
});

describe('onAccentTextColor / luminanceOf', () => {
  it('returns white text on dark accents, black on light ones', () => {
    expect(onAccentTextColor('#000000')).toBe('#ffffff');
    expect(onAccentTextColor('#2563eb')).toBe('#ffffff'); // the default blue
    expect(onAccentTextColor('#ffffff')).toBe('#000000');
    expect(onAccentTextColor('#ffe066')).toBe('#000000'); // a light yellow
  });

  it('accepts shorthand hex and ignores a missing leading #', () => {
    expect(onAccentTextColor('#fff')).toBe('#000000');
    expect(onAccentTextColor('000')).toBe('#ffffff');
  });

  it('luminanceOf is 0 for black, ~1 for white, 0 for an unparseable value', () => {
    expect(luminanceOf('#000000')).toBeCloseTo(0, 5);
    expect(luminanceOf('#ffffff')).toBeCloseTo(1, 5);
    expect(luminanceOf('not-a-color')).toBe(0);
  });
});

describe('parseHexColor', () => {
  it('parses the four shapes the Rust validator allows', () => {
    expect(parseHexColor('#6366f1')).toEqual({ r: 0x63, g: 0x66, b: 0xf1, a: 1 });
    // 3-digit shorthand expands each nibble
    expect(parseHexColor('#abc')).toEqual({ r: 0xaa, g: 0xbb, b: 0xcc, a: 1 });
    // 4- and 8-digit forms carry alpha
    expect(parseHexColor('#abcd')?.a).toBeCloseTo(0xdd / 255, 5);
    expect(parseHexColor('#6366f180')?.a).toBeCloseTo(0x80 / 255, 5);
  });

  it('tolerates a missing # and surrounding whitespace, and rejects junk', () => {
    expect(parseHexColor('  6366f1 ')?.r).toBe(0x63);
    expect(parseHexColor('rebeccapurple')).toBeNull();
    expect(parseHexColor('#12345')).toBeNull(); // 5 digits is not a valid shape
    expect(parseHexColor('#ff')).toBeNull();
  });
});

describe('accentTokens', () => {
  it('keeps the legacy aliases in sync with the canonical tokens', () => {
    const t = accentTokens('#ff8800');
    expect(t.accent).toBe('#ff8800');
    expect(t.accentColor).toBe(t.accent);
    expect(t.textOnAccent).toBe(t.onAccent);
  });

  it('derives hover/gradient/glow from the pick instead of leaving the default indigo', () => {
    // These three were never written by applyTheme at all, so hover states and gradients
    // stayed #6366f1 whatever the user chose.
    const t = accentTokens('#ff0000');
    expect(t.hover).not.toBe('#818cf8');
    expect(t.hover).not.toBe(t.accent); // lightened toward white
    expect(t.gradient).toContain('#ff0000');
    expect(t.gradient).toContain('linear-gradient');
    expect(t.glow).toBe('0 0 20px rgba(255, 0, 0, 0.3)');
  });

  it('carries the contrast guard so a light accent gets dark text', () => {
    // The bug this fixes: `color: var(--on-accent)` stayed #ffffff because the guard's
    // decision was written to `--text-on-accent`, which nothing read.
    expect(accentTokens('#ffe066').onAccent).toBe('#000000');
    expect(accentTokens('#1a237e').onAccent).toBe('#ffffff');
  });

  it('degrades gracefully for an unparseable accent instead of writing invalid values', () => {
    const t = accentTokens('not-a-color');
    expect(t.accent).toBe('not-a-color');
    expect(t.hover).toBe('not-a-color');
    expect(t.glow).toContain('rgba(');
  });
});

describe('applyTheme writes the CANONICAL accent tokens', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('style');
  });

  it('sets --accent and --on-accent, not only the legacy aliases', () => {
    // index.css defines --accent/--on-accent as the canonical tokens (~44 rules read
    // them) and --accent-color/--text-on-accent as aliases pointing at them. Writing
    // only the aliases made the picker a no-op for those rules and defeated the guard.
    // A dark accent so the contrast guard's answer is the legible white.
    applyTheme({ primaryColor: '#1a237e' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--accent')).toBe('#1a237e');
    expect(style.getPropertyValue('--on-accent')).toBe('#ffffff');
    // aliases still written, for the rules that haven't migrated
    expect(style.getPropertyValue('--accent-color')).toBe('#1a237e');
    expect(style.getPropertyValue('--text-on-accent')).toBe('#ffffff');
  });

  it('makes a light accent actually render dark text through --on-accent', () => {
    applyTheme({ primaryColor: '#ffe066' });
    expect(document.documentElement.style.getPropertyValue('--on-accent')).toBe('#000000');
  });

  it('drives the hover/gradient/glow tokens from the pick', () => {
    applyTheme({ primaryColor: '#00aa55' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--accent-hover')).not.toBe('');
    expect(style.getPropertyValue('--accent-gradient')).toContain('#00aa55');
    expect(style.getPropertyValue('--accent-glow')).toContain('rgba(0, 170, 85');
  });
});
