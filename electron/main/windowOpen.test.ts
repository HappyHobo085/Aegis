// electron/main/windowOpen.test.ts
import { describe, it, expect } from 'vitest';
import { decideWindowOpen } from './windowOpen';

// The real Electron 42.4.0 HandlerDetails.disposition enum (no 'save-to-disk').
const dispositions = [
  'default',
  'foreground-tab',
  'background-tab',
  'new-window',
  'other',
] as const;

describe('decideWindowOpen', () => {
  it("denies the popunder dispositions ('background-tab', 'other') regardless of URL", () => {
    for (const disposition of ['background-tab', 'other'] as const) {
      expect(decideWindowOpen({ url: 'https://ok.test/page', disposition })).toEqual({
        action: 'deny',
      });
      // even an otherwise-allowed scheme must not route in-place for these
      expect('loadInPlace' in decideWindowOpen({ url: 'https://ok.test/page', disposition })).toBe(
        false,
      );
    }
  });

  it('routes an allowed-scheme new-window in-place for the non-popunder dispositions', () => {
    for (const disposition of ['default', 'foreground-tab', 'new-window'] as const) {
      expect(decideWindowOpen({ url: 'https://ok.test/page', disposition })).toEqual({
        action: 'deny',
        loadInPlace: 'https://ok.test/page',
      });
    }
  });

  it('routes about:blank in-place for an allowed disposition', () => {
    expect(decideWindowOpen({ url: 'about:blank', disposition: 'foreground-tab' })).toEqual({
      action: 'deny',
      loadInPlace: 'about:blank',
    });
  });

  it('denies a disallowed-scheme url for an allowed disposition without routing', () => {
    for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'aegis-bad://x', 'data:text/html,x']) {
      const res = decideWindowOpen({ url, disposition: 'new-window' });
      expect(res).toEqual({ action: 'deny' });
      expect('loadInPlace' in res).toBe(false);
    }
  });

  it('covers every real disposition value without throwing', () => {
    for (const disposition of dispositions) {
      const res = decideWindowOpen({ url: 'https://ok.test/', disposition });
      expect(res.action).toBe('deny');
    }
  });
});
