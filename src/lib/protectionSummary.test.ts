// src/lib/protectionSummary.test.ts
import { describe, it, expect } from 'vitest';
import type { FingerprintState, ProxyState, Settings, TabMeta } from '../../shared/types';
import { protectionSummary } from './protectionSummary';

const settings = { httpsOnly: true, webrtcPolicy: 'public-only' } as unknown as Settings;
const fingerprint: FingerprintState = { level: 'standard', allowlistedHosts: [] };
const proxy = { active: false, uri: null } as unknown as ProxyState;

const tab = (over: Partial<TabMeta> = {}): TabMeta =>
  ({ id: 1, url: 'https://example.com', title: 'Example', ...over }) as TabMeta;

describe('protectionSummary', () => {
  it('reports a non-private active tab', () => {
    expect(
      protectionSummary({ activeTab: tab(), settings, fingerprint, proxy, host: null }).privateMode,
    ).toBe(false);
  });

  it('reports a private active tab', () => {
    expect(
      protectionSummary({
        activeTab: tab({ private: true }),
        settings,
        fingerprint,
        proxy,
        host: null,
      }).privateMode,
    ).toBe(true);
  });

  it('treats an ABSENT active tab as not private (no tab is not a private tab)', () => {
    expect(protectionSummary({ settings, fingerprint, proxy, host: null }).privateMode).toBe(false);
  });

  // `activeTab?.private ?? false` — the `??` matters for a TabMeta whose `private`
  // field is genuinely undefined, which is what a malformed IPC reply looks like.
  it('treats an active tab with no `private` field as not private', () => {
    const noFlag = { id: 1, url: 'https://example.com', title: 'Example' } as TabMeta;
    expect(
      protectionSummary({ activeTab: noFlag, settings, fingerprint, proxy, host: null })
        .privateMode,
    ).toBe(false);
  });

  it('passes the settings-backed fields straight through', () => {
    const summary = protectionSummary({ settings, fingerprint, proxy, host: null });
    expect(summary.httpsOnly).toBe(true);
    expect(summary.webrtcPolicy).toBe('public-only');
    expect(summary.fingerprintLevel).toBe('standard');
  });

  describe('fingerprintAllowed', () => {
    const allowlisted: FingerprintState = { level: 'standard', allowlistedHosts: ['a.com'] };

    it('is true only when the browsed host is on the allowlist', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, proxy, host: 'a.com' })
          .fingerprintAllowed,
      ).toBe(true);
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, proxy, host: 'b.com' })
          .fingerprintAllowed,
      ).toBe(false);
    });

    // A NULL host is the `about:blank` / unparseable-URL case. Reporting "allowed"
    // for it would show the user their host is exempt from farbling when there is no
    // host at all — and `""` is a real allowlist-able value, so the null check has to
    // be an explicit `!== null` rather than a truthiness test.
    it('is false when there is no browsed host at all', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, proxy, host: null })
          .fingerprintAllowed,
      ).toBe(false);
    });

    it('does not substring-match: a.com must not allow ac.com', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, proxy, host: 'ac.com' })
          .fingerprintAllowed,
      ).toBe(false);
    });
  });

  describe('proxy', () => {
    it('passes active + uri through', () => {
      const on = { active: true, uri: 'socks5://127.0.0.1:9050' } as unknown as ProxyState;
      const summary = protectionSummary({ settings, fingerprint, proxy: on, host: null });
      expect(summary.proxyActive).toBe(true);
      expect(summary.proxyUri).toBe('socks5://127.0.0.1:9050');
    });

    it('reports an inactive proxy with a null uri', () => {
      const summary = protectionSummary({ settings, fingerprint, proxy, host: null });
      expect(summary.proxyActive).toBe(false);
      expect(summary.proxyUri).toBeNull();
    });
  });

  it('is a pure projection: it does not mutate or retain its inputs', () => {
    const fp: FingerprintState = { level: 'off', allowlistedHosts: [] };
    const frozen = Object.freeze([...fp.allowlistedHosts]);
    Object.freeze(fp);
    const summary = protectionSummary({ settings, fingerprint: fp, proxy, host: 'a.com' });
    expect(summary.fingerprintAllowed).toBe(false);
    expect(fp.allowlistedHosts).toEqual(frozen);
  });
});
