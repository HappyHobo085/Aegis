// src/lib/addressParse.test.ts
import { describe, it, expect } from 'vitest';
import { addressParse, normalizeSavedUrl, isUrlLikeInput } from './addressParse';

const ctx = (overrides: Partial<{ currentUrl: string; searchTemplate: string }> = {}) => ({
  currentUrl: 'https://example.com/',
  searchTemplate: 'https://duckduckgo.com/?q=%s',
  ...overrides,
});

describe('addressParse', () => {
  it('treats input equal to the current URL as a reload', () => {
    expect(addressParse('https://example.com/', ctx())).toEqual({ kind: 'reload' });
  });

  it('trims whitespace before comparing for reload', () => {
    expect(addressParse('  https://example.com/  ', ctx())).toEqual({ kind: 'reload' });
  });

  it('navigates a full allowed https URL as-is', () => {
    expect(addressParse('https://news.example.org/path?x=1', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://news.example.org/path?x=1',
    });
  });

  it('navigates a full allowed http URL as-is', () => {
    expect(addressParse('http://insecure.example.org/', ctx())).toEqual({
      kind: 'navigate',
      url: 'http://insecure.example.org/',
    });
  });

  it('rejects a disallowed scheme such as file:', () => {
    const r = addressParse('file:///etc/passwd', ctx());
    expect(r.kind).toBe('rejected');
  });

  it('rejects a disallowed scheme such as javascript:', () => {
    const r = addressParse('javascript:alert(1)', ctx());
    expect(r.kind).toBe('rejected');
  });

  it('prepends https:// to a schemeless host', () => {
    expect(addressParse('example.com', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://example.com',
    });
  });

  it('prepends https:// to a schemeless host with a path', () => {
    expect(addressParse('example.com/some/path', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://example.com/some/path',
    });
  });

  it('treats a bare term with no dot as a search', () => {
    expect(addressParse('hello world', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=hello%20world',
    });
  });

  it('treats text containing a dot but also spaces as a search', () => {
    expect(addressParse('what is a .gitignore file', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=what%20is%20a%20.gitignore%20file',
    });
  });

  it('encodes special characters in a search query', () => {
    expect(addressParse('a&b=c', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=a%26b%3Dc',
    });
  });

  it('treats empty input as a no-op, not a search of the empty string', () => {
    // A real browser does nothing on Enter in an empty omnibox. This used to fall through to
    // the search template and navigate to `https://duckduckgo.com/?q=`.
    expect(addressParse('   ', ctx())).toEqual({ kind: 'noop' });
  });

  it('treats a fully empty input as a no-op', () => {
    expect(addressParse('', ctx())).toEqual({ kind: 'noop' });
  });

  it('still searches a real query', () => {
    expect(addressParse('kittens', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=kittens',
    });
  });
});

describe('normalizeSavedUrl', () => {
  it('accepts a full https URL as-is', () => {
    expect(normalizeSavedUrl('https://news.example.org/path?x=1')).toEqual({
      ok: true,
      url: 'https://news.example.org/path?x=1',
    });
  });

  it('accepts a full http URL as-is', () => {
    expect(normalizeSavedUrl('http://insecure.example.org/')).toEqual({
      ok: true,
      url: 'http://insecure.example.org/',
    });
  });

  it('trims surrounding whitespace before normalising', () => {
    expect(normalizeSavedUrl('  example.com  ')).toEqual({
      ok: true,
      url: 'https://example.com',
    });
  });

  it('prepends https:// to a schemeless host', () => {
    expect(normalizeSavedUrl('example.com')).toEqual({
      ok: true,
      url: 'https://example.com',
    });
  });

  it('prepends https:// to a schemeless host with a path', () => {
    expect(normalizeSavedUrl('example.com/some/path')).toEqual({
      ok: true,
      url: 'https://example.com/some/path',
    });
  });

  it('rejects empty input', () => {
    expect(normalizeSavedUrl('   ')).toEqual({ ok: false, reason: 'Enter a URL.' });
  });

  it('rejects a disallowed scheme such as file:', () => {
    const r = normalizeSavedUrl('file:///etc/passwd');
    expect(r.ok).toBe(false);
  });

  it('rejects a disallowed scheme such as javascript:', () => {
    const r = normalizeSavedUrl('javascript:alert(1)');
    expect(r.ok).toBe(false);
  });

  it('rejects a bare term that is not a host', () => {
    const r = normalizeSavedUrl('hello world');
    expect(r.ok).toBe(false);
  });
});

// A `host:port` is a host, not a scheme. RFC 3986 allows `.` and digits in a
// scheme name, so `example.com:8080` matches the scheme regex and `new URL`
// happily parses it with the protocol `example.com:` — which then fails the
// http(s) allowlist. Every letter-leading host:port was therefore rejected with
// "Aegis can only open web (http and https) addresses", a message that is
// plainly false about a plainly-web address. Loopback additionally needs http:
// a dev server on `localhost:3000` speaks plain HTTP, and prepending https://
// to it produces a TLS error rather than a page.
describe('a host:port is an address, not a scheme', () => {
  it('navigates a dotted host:port instead of rejecting it', () => {
    expect(addressParse('example.com:8080', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://example.com:8080',
    });
  });

  it('navigates a loopback host:port over http', () => {
    // A dev server on 127.0.0.1:3000 is plain HTTP; prepending https:// gives a
    // TLS handshake failure, not a page.
    expect(addressParse('127.0.0.1:3000', ctx())).toEqual({
      kind: 'navigate',
      url: 'http://127.0.0.1:3000',
    });
  });

  it.each([
    ['localhost:8080', 'http://localhost:8080'],
    ['127.0.0.1:8080', 'http://127.0.0.1:8080'],
    ['127.1.2.3:9', 'http://127.1.2.3:9'],
    ['[::1]:8080', 'http://[::1]:8080'],
  ])('routes the loopback address %s to http', (typed, expected) => {
    expect(addressParse(typed, ctx())).toEqual({ kind: 'navigate', url: expected });
  });

  it('still refuses a dotless name:port, which is indistinguishable from a scheme', () => {
    // `wiki:8443` is shape-identical to `javascript:1`, and there is no way to
    // tell them apart without a registry of every scheme ever registered. Refusal
    // is the fail-safe answer and is deliberately UNCHANGED by this fix — a
    // dotless `name:port` is the one case that stays refused. What changed is
    // the case where the host is actually identifiable (dotted, `localhost`, or a
    // bracketed IPv6 literal), which used to be refused in exactly the same way.
    expect(addressParse('wiki:8443', ctx()).kind).toBe('rejected');
    expect(normalizeSavedUrl('wiki:8443').ok).toBe(false);
  });

  it('offers a Go-to row for a host:port rather than treating it as a phrase', () => {
    expect(isUrlLikeInput('localhost:8080')).toBe(true);
    expect(isUrlLikeInput('example.com:8080')).toBe(true);
    expect(isUrlLikeInput('[::1]:8080')).toBe(true);
  });

  it('saves a host:port', () => {
    expect(normalizeSavedUrl('localhost:8080')).toEqual({ ok: true, url: 'http://localhost:8080' });
    expect(normalizeSavedUrl('example.com:8080')).toEqual({
      ok: true,
      url: 'https://example.com:8080',
    });
  });

  it('still refuses a scheme whose tail merely looks numeric', () => {
    // javascript:1 and a bare `scheme:` are schemes, not host:port pairs.
    expect(addressParse('javascript:alert(1)', ctx()).kind).toBe('rejected');
    expect(addressParse('javascript:1', ctx()).kind).toBe('rejected');
    expect(normalizeSavedUrl('javascript:1').ok).toBe(false);
  });

  it('still refuses a port that is out of range or not a number', () => {
    expect(normalizeSavedUrl('localhost:0').ok).toBe(false);
    expect(normalizeSavedUrl('localhost:99999').ok).toBe(false);
    expect(normalizeSavedUrl('localhost:80a').ok).toBe(false);
  });
});
