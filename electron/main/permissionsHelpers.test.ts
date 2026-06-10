// electron/main/permissionsHelpers.test.ts
import { describe, it, expect } from 'vitest';
import { resolvePermission, originOf, PHASE5_PERMISSIONS } from './permissionsHelpers';

describe('originOf', () => {
  it('extracts the origin from a full URL', () => {
    expect(originOf('https://example.com/path?q=1')).toBe('https://example.com');
  });

  it('keeps a non-default port', () => {
    expect(originOf('http://localhost:8080/x')).toBe('http://localhost:8080');
  });

  it('returns empty string for an unparseable URL', () => {
    expect(originOf('not a url')).toBe('');
  });
});

describe('resolvePermission', () => {
  it('honors a remembered allow', () => {
    expect(resolvePermission('allow', true)).toEqual({ decision: 'allow' });
  });

  it('honors a remembered deny', () => {
    expect(resolvePermission('deny', true)).toEqual({ decision: 'deny' });
  });

  it('prompts when no memory and the permission is in the Phase-5 set', () => {
    expect(resolvePermission(undefined, true)).toEqual({ prompt: true });
  });

  it('denies when no memory and the permission is NOT in the Phase-5 set', () => {
    expect(resolvePermission(undefined, false)).toEqual({ deny: true });
  });

  it('a remembered decision wins even for an out-of-set permission', () => {
    expect(resolvePermission('allow', false)).toEqual({ decision: 'allow' });
  });
});

describe('PHASE5_PERMISSIONS', () => {
  it('is exactly the meaningful set', () => {
    expect([...PHASE5_PERMISSIONS].sort()).toEqual(
      ['clipboard-read', 'geolocation', 'media', 'notifications'].sort(),
    );
  });
});
