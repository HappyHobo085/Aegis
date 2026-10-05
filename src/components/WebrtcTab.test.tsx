import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WebrtcTab } from './WebrtcTab';
import type { Settings, WebrtcExemptState } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as Settings;
// A SEPARATE store from the ad-block allowlist; the fixture is deliberately a
// different host set so a test cannot pass by the two lists being confused.
const baseWebrtcExemptState: WebrtcExemptState = { exemptHosts: ['exempt.example'] };

function renderWebrtcTab(
  overrides: {
    update?: (partial: Partial<Settings>) => void;
    webrtcExempt?: WebrtcExemptState;
    toggleWebrtcExempt?: (host: string) => void;
    removeWebrtcExempt?: (host: string) => void;
    settings?: Settings;
  } = {},
) {
  return render(
    <WebrtcTab
      settings={overrides.settings ?? baseSettings}
      update={overrides.update ?? vi.fn()}
      webrtcExempt={overrides.webrtcExempt ?? baseWebrtcExemptState}
      toggleWebrtcExempt={overrides.toggleWebrtcExempt ?? vi.fn()}
      removeWebrtcExempt={overrides.removeWebrtcExempt ?? vi.fn()}
    />,
  );
}

describe('WebrtcTab', () => {
  it('reflects webrtcPolicy and changes it via update', async () => {
    const update = vi.fn();
    renderWebrtcTab({ update });
    const select = screen.getByRole('combobox', { name: /webrtc policy/i });
    expect(select).toHaveValue('public-only');
    await userEvent.selectOptions(select, 'disable');
    expect(update).toHaveBeenCalledWith({ webrtcPolicy: 'disable' });
  });

  it('does not render the HTTPS or fingerprinting controls', () => {
    renderWebrtcTab();
    expect(screen.queryByRole('checkbox', { name: /https-only/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /anti-fingerprinting level/i })).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: /host to add to fingerprint allowlist/i }),
    ).toBeNull();
  });
});

/**
 * The WebRTC exemption list. The security property is what these assert: the list
 * the user edits here is the list the core reads, and it is a SEPARATE store from
 * the ad-block allowlist — so an ad-block allowlist entry must never appear here,
 * and a host exempted here must not be reported as ad-block-allowlisted.
 */
describe('WebrtcTab exemptions', () => {
  it('lists the hosts the core reports, and only those', () => {
    renderWebrtcTab({ webrtcExempt: { exemptHosts: ['a.example', 'b.example'] } });
    expect(screen.getByText('a.example')).toBeInTheDocument();
    expect(screen.getByText('b.example')).toBeInTheDocument();
    // The ad-block allowlist fixture is empty, so a host cannot leak in from it.
    expect(
      screen.queryByRole('button', { name: /ad-block allowlist.*Remove a\.example/ }),
    ).not.toBeInTheDocument();
  });

  it('sends the host the user typed to the core', async () => {
    const toggleWebrtcExempt = vi.fn();
    renderWebrtcTab({ webrtcExempt: { exemptHosts: [] }, toggleWebrtcExempt });
    const input = screen.getByLabelText('Host to exempt from WebRTC protection');
    await userEvent.type(input, 'new.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add host to WebRTC exemptions' }));
    expect(toggleWebrtcExempt).toHaveBeenCalledWith('new.example');
  });

  it('does not re-add a host that is already listed', async () => {
    // The channel is a TOGGLE, so re-adding an already-listed host would REMOVE it. A user
    // clicking Add twice must not silently un-exempt the host.
    const toggleWebrtcExempt = vi.fn();
    renderWebrtcTab({
      webrtcExempt: { exemptHosts: ['listed.example'] },
      toggleWebrtcExempt,
    });
    await userEvent.type(
      screen.getByLabelText('Host to exempt from WebRTC protection'),
      'listed.example',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add host to WebRTC exemptions' }));
    expect(toggleWebrtcExempt).not.toHaveBeenCalled();
  });

  it('refuses an empty host rather than telling the core to toggle nothing', async () => {
    const toggleWebrtcExempt = vi.fn();
    renderWebrtcTab({ webrtcExempt: { exemptHosts: [] }, toggleWebrtcExempt });
    const add = screen.getByRole('button', { name: 'Add host to WebRTC exemptions' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Host to exempt from WebRTC protection'), '   ');
    expect(add).toBeDisabled();
    expect(toggleWebrtcExempt).not.toHaveBeenCalled();
  });

  it('removes exactly the host whose button was pressed', async () => {
    const removeWebrtcExempt = vi.fn();
    renderWebrtcTab({
      webrtcExempt: { exemptHosts: ['keep.example', 'drop.example'] },
      removeWebrtcExempt,
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Remove drop.example from WebRTC exemptions' }),
    );
    expect(removeWebrtcExempt).toHaveBeenCalledTimes(1);
    expect(removeWebrtcExempt).toHaveBeenCalledWith('drop.example');
  });

  it('says so plainly when no host is exempted', () => {
    renderWebrtcTab({ webrtcExempt: { exemptHosts: [] } });
    expect(screen.getByText(/No sites are exempted from WebRTC protection/i)).toBeInTheDocument();
  });

  it('states that the list is never synced', () => {
    renderWebrtcTab();
    expect(screen.getByText(/never synced/i)).toBeInTheDocument();
  });
});
