import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';
import type { AdblockState } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';

// The Overview tab. It renders the dashboard (covered on its own in
// `SecurityDashboard.test.tsx`) plus the always-on malicious-site note, so what is
// pinned HERE is that the summary is actually on this tab and that the note survived
// the split out of the tab that used to carry it.
const protection = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  fingerprintLevel: 'off',
  privateMode: false,
  proxyActive: false,
} as ProtectionSummary;
const adblock: AdblockState = {
  enabled: true,
  allowlistedHosts: [],
  sessionBlocked: 0,
  pageBlocked: 0,
};

function renderSecurityTab() {
  const handlers = { onHarden: vi.fn(), onOpenProxy: vi.fn() };
  render(
    <SecurityTab protection={protection} adblockState={adblock} blockedHere={12} {...handlers} />,
  );
  return handlers;
}

describe('SecurityTab (Overview)', () => {
  it('shows the protection summary from the dashboard', () => {
    renderSecurityTab();
    expect(screen.getByRole('region', { name: /security dashboard/i })).toBeInTheDocument();
    expect(screen.getByText('Current protection')).toBeInTheDocument();
  });

  // Malicious-site protection lost its `<h3>` sibling relationship when the tab split,
  // but the user-visible text is unchanged and must stay on the Overview tab.
  it('shows malicious-site protection as on (always)', () => {
    renderSecurityTab();
    expect(screen.getByText(/malicious-site protection/i)).toBeInTheDocument();
    expect(screen.getByText(/known malware and phishing sites are blocked/i)).toBeInTheDocument();
  });

  it('offers the two dashboard actions, and neither fires the other', async () => {
    const h = renderSecurityTab();
    await userEvent.click(screen.getByRole('button', { name: 'Harden this session' }));
    expect(h.onHarden).toHaveBeenCalledTimes(1);
    expect(h.onOpenProxy).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Proxy settings' }));
    expect(h.onOpenProxy).toHaveBeenCalledTimes(1);
  });

  // The three concerns that left this tab must NOT still be here — otherwise the
  // split only duplicated them. Each assertion names a control unique to its own tab.
  it('no longer renders the HTTPS, WebRTC or fingerprinting controls', () => {
    renderSecurityTab();
    expect(screen.queryByRole('combobox', { name: /webrtc policy/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /anti-fingerprinting level/i })).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: /host to exempt from WebRTC protection/i }),
    ).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: /host to add to fingerprint allowlist/i }),
    ).toBeNull();
  });
});
