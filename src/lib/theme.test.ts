// src/lib/theme.test.ts
import { describe, it, expect, afterEach, vi } from 'vitest';
import { applyTheme, resolveTheme, prefersDarkScheme, watchSystemTheme } from './theme';

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
    // @ts-expect-error — exercise the runtime default for callers passing only primaryColor
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
