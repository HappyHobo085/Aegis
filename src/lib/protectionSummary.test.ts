// src/lib/protectionSummary.test.ts
import { describe, it, expect } from 'vitest';
import type {
  FingerprintState,
  ProxyState,
  Settings,
  TabMeta,
  WebrtcExemptState,
} from '../../shared/types';
import { protectionSummary } from './protectionSummary';

const settings = { httpsOnly: true, webrtcPolicy: 'public-only' } as unknown as Settings;
const fingerprint: FingerprintState = { level: 'standard', allowlistedHosts: [] };
const proxy = { active: false, uri: null } as unknown as ProxyState;
// Deliberately a DIFFERENT host set from the fingerprint allowlist, so a test cannot
// pass by confusing the two lists — the same reasoning the SecurityTab test uses.
const webrtc: WebrtcExemptState = { exemptHosts: ['exempt.example'] };

const tab = (over: Partial<TabMeta> = {}): TabMeta =>
  ({ id: 1, url: 'https://example.com', title: 'Example', ...over }) as TabMeta;

describe('protectionSummary', () => {
  it('reports a non-private active tab', () => {
    expect(
      protectionSummary({ activeTab: tab(), settings, fingerprint, webrtc, proxy, host: null })
        .privateMode,
    ).toBe(false);
  });

  it('reports a private active tab', () => {
    expect(
      protectionSummary({
        activeTab: tab({ private: true }),
        settings,
        fingerprint,
        webrtc,
        proxy,
        host: null,
      }).privateMode,
    ).toBe(true);
  });

  it('treats an ABSENT active tab as not private (no tab is not a private tab)', () => {
    expect(
      protectionSummary({ settings, fingerprint, webrtc, proxy, host: null }).privateMode,
    ).toBe(false);
  });

  // `activeTab?.private ?? false` — the `??` matters for a TabMeta whose `private`
  // field is genuinely undefined, which is what a malformed IPC reply looks like.
  it('treats an active tab with no `private` field as not private', () => {
    const noFlag = { id: 1, url: 'https://example.com', title: 'Example' } as TabMeta;
    expect(
      protectionSummary({ activeTab: noFlag, settings, fingerprint, webrtc, proxy, host: null })
        .privateMode,
    ).toBe(false);
  });

  it('passes the settings-backed fields straight through', () => {
    const summary = protectionSummary({ settings, fingerprint, webrtc, proxy, host: null });
    expect(summary.httpsOnly).toBe(true);
    expect(summary.webrtcPolicy).toBe('public-only');
    expect(summary.fingerprintLevel).toBe('standard');
  });

  describe('fingerprintAllowed', () => {
    const allowlisted: FingerprintState = { level: 'standard', allowlistedHosts: ['a.com'] };

    it('is true only when the browsed host is on the allowlist', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: 'a.com' })
          .fingerprintAllowed,
      ).toBe(true);
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: 'b.com' })
          .fingerprintAllowed,
      ).toBe(false);
    });

    // A NULL host is the `about:blank` / unparseable-URL case. Reporting "allowed"
    // for it would show the user their host is exempt from farbling when there is no
    // host at all — and `""` is a real allowlist-able value, so the null check has to
    // be an explicit `!== null` rather than a truthiness test.
    it('is false when there is no browsed host at all', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: null })
          .fingerprintAllowed,
      ).toBe(false);
    });

    it('does not substring-match: a.com must not allow ac.com', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: 'ac.com' })
          .fingerprintAllowed,
      ).toBe(false);
    });

    // THE CORE'S SCOPE IS EXACT-OR-SUBDOMAIN, and this must agree with it.
    // `adblock::host_covered` (src-tauri/src/adblock.rs) is the ONE definition of
    // the allowlist's scope, and it was written precisely because three renderers
    // had each spelled the rule out separately and drifted — the engine's copy was
    // an exact `HashSet` hit with no subdomain case at all. The BADGE was the
    // remaining copy, and it is an exact `.includes()`, so allowlisting `a.com`
    // exempts `www.a.com` in the core (no farbling, no WebRTC shim) while this
    // badge reported "Fingerprint protection: standard" for the very page whose
    // protection had been switched off. A privacy badge that disagrees with the
    // privacy machinery about the same host is worse than no badge.
    it('covers a SUBDOMAIN of an allowlisted host, as the core does', () => {
      for (const sub of ['www.a.com', 'deep.sub.a.com']) {
        expect(
          protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: sub })
            .fingerprintAllowed,
          `allowlisting a.com must cover ${sub}, because adblock::host_covered does`,
        ).toBe(true);
      }
    });

    // The other direction, so the subdomain rule cannot degenerate into a
    // suffix test: `nota.com` merely ENDS with the characters of `a.com`.
    it('does not suffix-match: a.com must not allow nota.com', () => {
      expect(
        protectionSummary({ settings, fingerprint: allowlisted, webrtc, proxy, host: 'nota.com' })
          .fingerprintAllowed,
      ).toBe(false);
    });
  });

  describe('proxy', () => {
    it('passes active + uri through', () => {
      const on = { active: true, uri: 'socks5://127.0.0.1:9050' } as unknown as ProxyState;
      const summary = protectionSummary({ settings, fingerprint, webrtc, proxy: on, host: null });
      expect(summary.proxyActive).toBe(true);
      expect(summary.proxyUri).toBe('socks5://127.0.0.1:9050');
    });

    it('reports an inactive proxy with a null uri', () => {
      const summary = protectionSummary({ settings, fingerprint, webrtc, proxy, host: null });
      expect(summary.proxyActive).toBe(false);
      expect(summary.proxyUri).toBeNull();
    });
  });

  it('is a pure projection: it does not mutate or retain its inputs', () => {
    const fp: FingerprintState = { level: 'off', allowlistedHosts: [] };
    const frozen = Object.freeze([...fp.allowlistedHosts]);
    Object.freeze(fp);
    const summary = protectionSummary({ settings, fingerprint: fp, webrtc, proxy, host: 'a.com' });
    expect(summary.fingerprintAllowed).toBe(false);
    expect(fp.allowlistedHosts).toEqual(frozen);
  });
});
