import { describe, it, expect } from 'vitest';
import { chromeUserAgent } from './userAgent';

describe('chromeUserAgent', () => {
  it('builds a reduced Chrome UA for Linux', () => {
    expect(chromeUserAgent('linux', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('builds a reduced Chrome UA for Windows', () => {
    expect(chromeUserAgent('win32', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('builds a reduced Chrome UA for macOS', () => {
    expect(chromeUserAgent('darwin', '134.0.6998.88')).toBe(
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36',
    );
  });

  it('reduces the version to <major>.0.0.0', () => {
    expect(chromeUserAgent('linux', '128.0.1.2')).toContain('Chrome/128.0.0.0 ');
  });

  it('does not contain Electron or the app name', () => {
    const ua = chromeUserAgent('linux', '134.0.6998.88');
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/aegis/i);
  });

  it('falls back to a Linux token for an unknown platform', () => {
    expect(chromeUserAgent('freebsd' as NodeJS.Platform, '134.0.0.0')).toContain('X11; Linux x86_64');
  });
});
