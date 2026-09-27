// src/lib/url.test.ts
import { describe, it, expect } from 'vitest';
import { hostOf, originOf } from './url';

describe('hostOf', () => {
  it('returns the hostname of a parseable URL', () => {
    expect(hostOf('https://example.com/a/b?c=1#d')).toBe('example.com');
  });

  it('keeps subdomains and drops the userinfo and port', () => {
    expect(hostOf('https://user:pw@sub.example.co.uk:8443/x')).toBe('sub.example.co.uk');
  });

  it('returns null for a non-http scheme that has no host', () => {
    expect(hostOf('about:blank')).toBeNull();
  });

  it('returns null for a scheme-less string (URL would parse it as a path)', () => {
    expect(hostOf('example.com')).toBeNull();
  });

  it('returns null for garbage rather than throwing', () => {
    expect(hostOf('not a url at all')).toBeNull();
    expect(hostOf('')).toBeNull();
  });

  it('handles an IPv6 literal, whose hostname keeps its brackets', () => {
    expect(hostOf('http://[::1]:8787/healthz')).toBe('[::1]');
  });
});

describe('originOf', () => {
  it('returns the scheme + host + port origin', () => {
    expect(originOf('https://example.com/a/b?c=1')).toBe('https://example.com');
  });

  it('is not origin-null, so sibling paths on one host share an origin', () => {
    expect(originOf('https://example.com/a')).toBe(originOf('https://example.com/b'));
  });

  it('keeps a non-default port in the origin', () => {
    expect(originOf('http://example.com:8787/healthz')).toBe('http://example.com:8787');
  });

  it('returns null for an unparseable URL', () => {
    expect(originOf('example.com')).toBeNull();
  });

  // `URL.origin` is the string "null" for opaque origins (about:, data:, blob: is
  // special-cased). Returning that literal as if it were an origin would make an
  // `about:blank` tab compare equal to a `data:` one, so it is rejected below.
  it('reports a real null for opaque origins instead of the string "null"', () => {
    expect(originOf('about:blank')).toBeNull();
    expect(originOf('data:text/html,hi')).toBeNull();
  });
});
