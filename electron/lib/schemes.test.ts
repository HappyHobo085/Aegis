// electron/lib/schemes.test.ts
import { describe, it, expect } from 'vitest';
import { isAllowedNavigationUrl } from './schemes';

describe('isAllowedNavigationUrl', () => {
  it('allows https: URLs', () => {
    expect(isAllowedNavigationUrl('https://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('allows http: URLs', () => {
    expect(isAllowedNavigationUrl('http://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('http://localhost:8080/spa.html')).toBe(true);
  });

  it('allows exactly about:blank', () => {
    expect(isAllowedNavigationUrl('about:blank')).toBe(true);
  });

  it('rejects other about: URLs', () => {
    expect(isAllowedNavigationUrl('about:config')).toBe(false);
    expect(isAllowedNavigationUrl('about:blank#x')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isAllowedNavigationUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isAllowedNavigationUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isAllowedNavigationUrl('data:text/html,<h1>x</h1>')).toBe(false);
  });

  it('rejects chrome: URLs', () => {
    expect(isAllowedNavigationUrl('chrome://settings')).toBe(false);
  });

  it('rejects custom and unknown schemes', () => {
    expect(isAllowedNavigationUrl('ftp://example.com')).toBe(false);
    expect(isAllowedNavigationUrl('aegis://thing')).toBe(false);
  });

  it('rejects invalid / unparsable input', () => {
    expect(isAllowedNavigationUrl('not a url')).toBe(false);
    expect(isAllowedNavigationUrl('')).toBe(false);
    expect(isAllowedNavigationUrl('example.com')).toBe(false); // no scheme
  });

  // Additional security-critical cases required by task spec

  it('handles scheme case-insensitivity (URL parsing lowercases)', () => {
    // The URL constructor normalises the scheme to lowercase, so these must pass.
    expect(isAllowedNavigationUrl('HTTPS://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('HTTP://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('Https://example.com')).toBe(true);
  });

  it('rejects javascript: with odd casing (must not bypass the check)', () => {
    // The URL constructor also lowercases these, so they must all be rejected.
    expect(isAllowedNavigationUrl('Javascript:alert(1)')).toBe(false);
    expect(isAllowedNavigationUrl('JAVASCRIPT:alert(1)')).toBe(false);
    expect(isAllowedNavigationUrl('jAvAsCrIpT:alert(1)')).toBe(false);
  });

  it('does not throw on garbage / exotic input (returns false, never throws)', () => {
    expect(() => isAllowedNavigationUrl('\x00')).not.toThrow();
    expect(isAllowedNavigationUrl('\x00')).toBe(false);
    expect(() => isAllowedNavigationUrl('   ')).not.toThrow();
    expect(isAllowedNavigationUrl('   ')).toBe(false);
    expect(() => isAllowedNavigationUrl('://no-scheme')).not.toThrow();
    expect(isAllowedNavigationUrl('://no-scheme')).toBe(false);
  });
});
