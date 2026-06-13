import { describe, it, expect, vi } from 'vitest';
import type { NavFailed, SafetyInterstitialPayload } from '../../../shared/types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import { SafetyController } from './SafetyController';

function setup(opts?: { httpsOnly?: boolean; exceptions?: Set<string> }) {
  const exceptions = opts?.exceptions ?? new Set<string>();
  const navigateView = vi.fn();
  const events: (SafetyInterstitialPayload | null)[] = [];
  const sc = new SafetyController({
    navigateView,
    httpExceptions: {
      has: (h) => exceptions.has(h),
      add: (h) => exceptions.add(h),
      remove: (h) => exceptions.delete(h),
      list: () => [...exceptions],
    },
    getHttpsOnly: () => opts?.httpsOnly ?? true,
    onInterstitial: (p) => events.push(p),
  });
  return { sc, navigateView, events, exceptions };
}

const failed = (url: string): NavFailed => ({
  viewId: PRIMARY_VIEW_ID,
  errorCode: -105,
  errorDescription: 'ERR_NAME_NOT_RESOLVED',
  validatedURL: url,
  kind: 'load',
});

describe('SafetyController.navigate', () => {
  it('upgrades http -> https before loading', () => {
    const { sc, navigateView } = setup();
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('https://example.com/');
  });

  it('loads as-is when httpsOnly is off', () => {
    const { sc, navigateView } = setup({ httpsOnly: false });
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
  });

  it('loads http as-is for an excepted host', () => {
    const { sc, navigateView } = setup({ exceptions: new Set(['example.com']) });
    sc.navigate('http://example.com/');
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
  });
});

describe('SafetyController.handleNavFailed', () => {
  it('raises the interstitial when an upgraded URL fails, returns true', () => {
    const { sc, events } = setup();
    sc.navigate('http://example.com/');
    const handled = sc.handleNavFailed(failed('https://example.com/'));
    expect(handled).toBe(true);
    expect(sc.getState()).toEqual({ url: 'http://example.com/', reason: 'https-failed' });
    expect(events.at(-1)).toEqual({ url: 'http://example.com/', reason: 'https-failed' });
  });

  it('returns false for a failure unrelated to an upgrade', () => {
    const { sc } = setup();
    sc.navigate('https://example.com/');
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(false);
    expect(sc.getState()).toBeNull();
  });

  it('does not double-fire for a stale upgrade record', () => {
    const { sc } = setup();
    sc.navigate('http://example.com/');
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(true);
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(false);
  });
});

describe('SafetyController.handleNavCommitted + stale-record safety', () => {
  it('clears the upgrade record on successful commit, preventing a later false interstitial', () => {
    const { sc } = setup();
    sc.navigate('http://example.com/'); // arms http -> https
    sc.handleNavCommitted('https://example.com/'); // the upgraded URL loaded OK
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(false);
    expect(sc.getState()).toBeNull();
  });

  it('ignores an unrelated committed URL (keeps the arm)', () => {
    const { sc } = setup();
    sc.navigate('http://example.com/');
    sc.handleNavCommitted('https://different.com/');
    expect(sc.handleNavFailed(failed('https://example.com/'))).toBe(true);
  });

  it('a fresh navigation clears a stale arm (no false interstitial on a later direct-https failure)', () => {
    const { sc } = setup();
    sc.navigate('http://a.com/'); // arms a -> https://a
    sc.navigate('https://b.com/'); // direct https supersedes, clears the arm
    expect(sc.handleNavFailed(failed('https://b.com/'))).toBe(false);
    expect(sc.handleNavFailed(failed('https://a.com/'))).toBe(false);
  });

  it('a fresh navigation dismisses an active interstitial', () => {
    const { sc, events } = setup();
    sc.navigate('http://example.com/');
    sc.handleNavFailed(failed('https://example.com/'));
    expect(sc.getState()).not.toBeNull();
    sc.navigate('https://other.com/');
    expect(sc.getState()).toBeNull();
    expect(events.at(-1)).toBeNull();
  });
});

describe('SafetyController.proceed', () => {
  it('persists the host exception, dismisses, and reloads over http', () => {
    const { sc, navigateView, events, exceptions } = setup();
    sc.navigate('http://example.com/');
    sc.handleNavFailed(failed('https://example.com/'));
    navigateView.mockClear();
    sc.proceed('http://example.com/');
    expect(exceptions.has('example.com')).toBe(true);
    expect(navigateView).toHaveBeenCalledWith('http://example.com/');
    expect(sc.getState()).toBeNull();
    expect(events.at(-1)).toBeNull();
  });

  it('is a no-op when there is no active interstitial', () => {
    const { sc, navigateView, exceptions } = setup();
    sc.proceed('http://example.com/');
    expect(navigateView).not.toHaveBeenCalled();
    expect(exceptions.has('example.com')).toBe(false);
  });

  it('ignores a url that does not match the active interstitial', () => {
    const { sc, navigateView, exceptions } = setup();
    sc.navigate('http://example.com/');
    sc.handleNavFailed(failed('https://example.com/'));
    navigateView.mockClear();
    sc.proceed('http://evil.com/');
    expect(navigateView).not.toHaveBeenCalled();
    expect(exceptions.has('evil.com')).toBe(false);
    expect(sc.getState()).not.toBeNull();
  });

  it('persists the normalized (trailing-dot-stripped) host so the exception matches next time', () => {
    const { sc, exceptions } = setup();
    sc.navigate('http://example.com./'); // upgradeUrl normalizes the host -> https://example.com/
    sc.handleNavFailed(failed('https://example.com/'));
    sc.proceed('http://example.com./');
    expect(exceptions.has('example.com')).toBe(true);
    expect(exceptions.has('example.com.')).toBe(false);
  });
});

describe('SafetyController.resolveUpgrade (gate hook)', () => {
  it('returns the https URL for an upgradeable http link', () => {
    const { sc } = setup();
    expect(sc.resolveUpgrade('http://example.com/x')).toBe('https://example.com/x');
  });
  it('returns null when nothing to upgrade', () => {
    const { sc } = setup();
    expect(sc.resolveUpgrade('https://example.com/x')).toBeNull();
  });
});

describe('SafetyController exception management', () => {
  it('listExceptions + removeException delegate to the repo', () => {
    const { sc, exceptions } = setup({ exceptions: new Set(['a.com', 'b.com']) });
    expect(sc.listExceptions().sort()).toEqual(['a.com', 'b.com']);
    sc.removeException('a.com');
    expect(exceptions.has('a.com')).toBe(false);
  });
});
