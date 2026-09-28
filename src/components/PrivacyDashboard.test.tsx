// src/components/PrivacyDashboard.test.tsx
//
// The dashboard derives a three-level verdict from six independent signals, and the
// derivation is the part worth pinning: `statusOf` collapses them into
// Strong / Standard / Relaxed, and getting a boundary wrong would tell the user they
// are better protected than they are.
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AdblockState,
  FingerprintState,
  ProxyState,
  Settings,
  TabMeta,
  WebrtcExemptState,
} from '../../shared/types';
import { protectionSummary } from '../lib/protectionSummary';
import { PrivacyDashboard } from './PrivacyDashboard';

const settings = (over: Partial<Settings> = {}): Settings =>
  ({ httpsOnly: true, webrtcPolicy: 'public-only', ...over }) as Settings;

const fingerprint = (over: Partial<FingerprintState> = {}): FingerprintState => ({
  level: 'standard',
  allowlistedHosts: [],
  ...over,
});

const proxy = (over: Partial<ProxyState> = {}): ProxyState =>
  ({ active: false, uri: null, ...over }) as ProxyState;

// Empty by DEFAULT so the dashboard's existing cases keep asserting the
// non-exempt WebRTC row; a test that cares passes `webrtc: { exemptHosts: [host] }`.
const webrtc = (over: Partial<WebrtcExemptState> = {}): WebrtcExemptState => ({
  exemptHosts: [],
  ...over,
});

const adblock = (over: Partial<AdblockState> = {}): AdblockState => ({
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
  pageBlocked: 0,
  ...over,
});

const tab = (over: Partial<TabMeta> = {}): TabMeta =>
  ({ id: 1, title: 'Example', url: 'https://example.com/', private: false, ...over }) as TabMeta;

/** A fully-hardened baseline; each test weakens exactly ONE signal. */
function renderDashboard(
  over: {
    settings?: Settings;
    fingerprint?: FingerprintState;
    proxy?: ProxyState;
    adblock?: AdblockState;
    activeTab?: TabMeta;
    host?: string | null;
    blockedHere?: number;
    webrtc?: WebrtcExemptState;
  } = {},
) {
  const handlers = { onHarden: vi.fn(), onOpenProxy: vi.fn() };
  const protection = protectionSummary({
    activeTab: over.activeTab,
    settings: over.settings ?? settings(),
    fingerprint: over.fingerprint ?? fingerprint(),
    webrtc: over.webrtc ?? webrtc(),
    proxy: over.proxy ?? proxy(),
    host: over.host === undefined ? 'example.com' : over.host,
  });
  render(
    <PrivacyDashboard
      protection={protection}
      adblock={over.adblock ?? adblock()}
      blockedHere={over.blockedHere ?? 12}
      {...handlers}
    />,
  );
  return handlers;
}

const status = () =>
  screen.getByText('Current protection').parentElement?.querySelector('strong')?.textContent;

describe('PrivacyDashboard', () => {
  describe('the status verdict', () => {
    it('is Standard when every baseline is on and nothing is extra', () => {
      renderDashboard();
      expect(status()).toBe('Standard');
    });

    it('is Strong when hardened AND private or proxied', () => {
      renderDashboard({ activeTab: tab({ private: true }) });
      expect(status()).toBe('Strong');
    });

    it('is Strong when hardened and proxied', () => {
      renderDashboard({ proxy: proxy({ active: true, uri: 'socks5://127.0.0.1:9050' }) });
      expect(status()).toBe('Strong');
    });

    // Each of the four baseline signals is load-bearing: dropping any one must drop
    // the verdict, or the dashboard would claim protection the user does not have.
    it('is Relaxed when HTTPS-only is off', () => {
      renderDashboard({ settings: settings({ httpsOnly: false }) });
      expect(status()).toBe('Relaxed');
    });

    it('is Relaxed when the WebRTC policy is default', () => {
      renderDashboard({ settings: settings({ webrtcPolicy: 'default' }) });
      expect(status()).toBe('Relaxed');
    });

    it('is Relaxed when fingerprinting is off', () => {
      renderDashboard({ fingerprint: fingerprint({ level: 'off' }) });
      expect(status()).toBe('Relaxed');
    });

    it('is Relaxed when ad blocking is off', () => {
      renderDashboard({ adblock: adblock({ enabled: false }) });
      expect(status()).toBe('Relaxed');
    });

    // private/proxy are BONUSES, not requirements — neither alone can reach Strong.
    it('is not Strong just because the tab is private', () => {
      renderDashboard({
        activeTab: tab({ private: true }),
        settings: settings({ httpsOnly: false }),
      });
      expect(status()).toBe('Relaxed');
    });

    it('is not Strong just because a proxy is on', () => {
      renderDashboard({
        proxy: proxy({ active: true }),
        fingerprint: fingerprint({ level: 'off' }),
      });
      expect(status()).toBe('Relaxed');
    });

    it('strict fingerprinting still counts as hardened', () => {
      renderDashboard({ fingerprint: fingerprint({ level: 'strict' }) });
      expect(status()).toBe('Standard');
    });
  });

  describe('the stat grid', () => {
    const cell = (label: string) =>
      screen.getByText(label).parentElement?.querySelector('strong')?.textContent;

    it('shows the per-page block count while ad blocking is on', () => {
      renderDashboard({ blockedHere: 7 });
      expect(cell('Ad blocking')).toBe('7 blocked here');
    });

    it('shows "Off" instead of a count while ad blocking is off', () => {
      renderDashboard({ adblock: adblock({ enabled: false }), blockedHere: 7 });
      expect(cell('Ad blocking')).toBe('Off');
    });

    it('reports HTTPS upgrades as On', () => {
      renderDashboard();
      expect(cell('HTTPS upgrades')).toBe('On');
    });

    it('reports HTTPS upgrades as Off when disabled', () => {
      renderDashboard({ settings: settings({ httpsOnly: false }) });
      expect(cell('HTTPS upgrades')).toBe('Off');
    });

    it('distinguishes a protected WebRTC policy from the default one', () => {
      renderDashboard();
      expect(cell('WebRTC')).toBe('Protected');
    });

    it('labels the default WebRTC policy "Default", not "Protected"', () => {
      renderDashboard({ settings: settings({ webrtcPolicy: 'default' }) });
      expect(cell('WebRTC')).toBe('Default');
    });

    it('reports the fingerprint level verbatim when it is on', () => {
      renderDashboard({ fingerprint: fingerprint({ level: 'strict' }) });
      expect(cell('Fingerprinting')).toBe('strict');
    });

    it('reports fingerprinting as Off when it is off', () => {
      renderDashboard({ fingerprint: fingerprint({ level: 'off' }) });
      expect(cell('Fingerprinting')).toBe('Off');
    });

    it('reports the private tab', () => {
      renderDashboard({ activeTab: tab({ private: true }) });
      expect(cell('Private tab')).toBe('On');
    });

    it('reports a non-private tab as Off', () => {
      renderDashboard({ activeTab: tab({ private: false }) });
      expect(cell('Private tab')).toBe('Off');
    });

    it('reports an absent active tab as not private', () => {
      renderDashboard({ activeTab: undefined });
      expect(cell('Private tab')).toBe('Off');
    });

    it('reports the proxy', () => {
      renderDashboard({ proxy: proxy({ active: true, uri: 'http://p.test:8080' }) });
      expect(cell('Proxy')).toBe('Active');
    });

    it('reports an inactive proxy as Off', () => {
      renderDashboard();
      expect(cell('Proxy')).toBe('Off');
    });
  });

  describe('the actions', () => {
    it('calls onHarden', async () => {
      const h = renderDashboard();
      await userEvent.click(screen.getByRole('button', { name: 'Harden this session' }));
      expect(h.onHarden).toHaveBeenCalledTimes(1);
    });

    it('calls onOpenProxy', async () => {
      const h = renderDashboard();
      await userEvent.click(screen.getByRole('button', { name: 'Proxy settings' }));
      expect(h.onOpenProxy).toHaveBeenCalledTimes(1);
    });

    it('the two actions do not fire each other', async () => {
      const h = renderDashboard();
      await userEvent.click(screen.getByRole('button', { name: 'Harden this session' }));
      expect(h.onOpenProxy).not.toHaveBeenCalled();
    });
  });

  it('is a labelled landmark region', () => {
    renderDashboard();
    expect(screen.getByRole('region', { name: 'Privacy dashboard' })).toBeInTheDocument();
  });
});
