import { describe, it, expect } from 'vitest';
import { upgradeUrl } from './httpsUpgrade';

const never = () => false;

describe('upgradeUrl', () => {
  it('upgrades a plain http URL to https, preserving path/query/hash', () => {
    expect(upgradeUrl('http://example.com/a/b?q=1#h', { httpsOnly: true, isException: never })).toBe(
      'https://example.com/a/b?q=1#h',
    );
  });

  it('returns null for an https URL (nothing to do)', () => {
    expect(upgradeUrl('https://example.com/', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('returns null when httpsOnly is off', () => {
    expect(upgradeUrl('http://example.com/', { httpsOnly: false, isException: never })).toBeNull();
  });

  it('returns null when the host is an exception', () => {
    const isException = (h: string) => h === 'example.com';
    expect(upgradeUrl('http://example.com/', { httpsOnly: true, isException })).toBeNull();
  });

  it('upgrades a non-exception host even when another host is excepted', () => {
    const isException = (h: string) => h === 'other.com';
    expect(upgradeUrl('http://example.com/', { httpsOnly: true, isException })).toBe('https://example.com/');
  });

  it('returns null for non-http(s) schemes', () => {
    expect(upgradeUrl('about:blank', { httpsOnly: true, isException: never })).toBeNull();
    expect(upgradeUrl('file:///x', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('returns null for an unparseable URL', () => {
    expect(upgradeUrl('not a url', { httpsOnly: true, isException: never })).toBeNull();
  });

  it('preserves a non-default port', () => {
    expect(upgradeUrl('http://example.com:8080/x', { httpsOnly: true, isException: never })).toBe(
      'https://example.com:8080/x',
    );
  });
});
