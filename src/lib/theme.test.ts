// src/lib/theme.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme } from './theme';

afterEach(() => {
  document.documentElement.style.removeProperty('--accent-color');
});

describe('applyTheme', () => {
  it('sets --accent-color on :root from the primaryColor setting', () => {
    applyTheme({ primaryColor: '#ff5500' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#ff5500');
  });

  it('overwrites a previously-applied accent color', () => {
    applyTheme({ primaryColor: '#111111' });
    applyTheme({ primaryColor: '#222222' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#222222');
  });
});
