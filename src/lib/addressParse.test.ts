// src/lib/addressParse.test.ts
import { describe, it, expect } from 'vitest';
import { addressParse } from './addressParse';

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

  it('treats empty input as a search of the empty string', () => {
    expect(addressParse('   ', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=',
    });
  });
});
