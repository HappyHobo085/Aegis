// src/lib/url.test.ts
import { describe, it, expect } from 'vitest';
import { hostCovered, hostOf, originOf } from './url';

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

// A SCOPE TABLE, and deliberately the same one as `adblock::host_covered`'s test in
// src-tauri/src/adblock.rs (`host_covered_is_exact_or_subdomain`). The two functions
// must agree, because they answer the same question about the same store from opposite
// sides of the IPC boundary — and when they disagreed, the SHIELD reported a host as
// fully protected while the core had already exempted it. Each row below is a row in
// the Rust table, for the same reason: a drift guard is only useful if it enumerates
// the cases BOTH sides were supposed to handle, not the ones that happen to be easy.
describe('hostCovered', () => {
  const al = ['example.com'];

  it('covers an exact match', () => {
    expect(hostCovered(al, 'example.com')).toBe(true);
  });

  it('covers subdomains at any depth', () => {
    expect(hostCovered(al, 'www.example.com')).toBe(true);
    expect(hostCovered(al, 'a.b.c.example.com')).toBe(true);
  });

  it('is a SUBDOMAIN test, not a suffix test: notexample.com is unrelated', () => {
    // The row that a `host.endsWith(entry)` implementation gets wrong. This is the
    // single most important case in the table.
    expect(hostCovered(al, 'notexample.com')).toBe(false);
  });

  it('does not match an entry that is only a PREFIX of the host', () => {
    // `example.com.evil.test` ends with nothing of the entry, but a naive
    // `host.includes(entry)` would match it — and that is the shape an attacker
    // registers to get a trusted-looking host into someone else\'s allowlist.
    expect(hostCovered(al, 'example.com.evil.test')).toBe(false);
  });

  it('does not let a leading-dot entry match the bare host', () => {
    expect(hostCovered(al, 'ample.com')).toBe(false);
  });

  it('treats a null or empty host as never covered', () => {
    // about:blank / an unparseable URL. `""` is itself a real allowlist-able value,
    // so this must stay an explicit test rather than a truthiness check.
    expect(hostCovered(al, null)).toBe(false);
    expect(hostCovered(al, '')).toBe(false);
  });

  it('an empty entry must not match everything', () => {
    expect(hostCovered([''], 'example.com')).toBe(false);
    expect(hostCovered([''], '')).toBe(false);
  });

  it('covers nothing when the allowlist is empty', () => {
    expect(hostCovered([], 'example.com')).toBe(false);
  });

  it('matches ANY entry, not just the first', () => {
    expect(hostCovered(['other.test', 'example.com'], 'www.example.com')).toBe(true);
  });
});
