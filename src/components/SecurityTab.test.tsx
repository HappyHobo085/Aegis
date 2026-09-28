import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';
import type { FingerprintState, Settings, WebrtcExemptState } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as Settings;
const baseFingerprintState: FingerprintState = { level: 'off', allowlistedHosts: [] };
// A SEPARATE store from the ad-block allowlist (7(2)); the fixture is deliberately a
// different host set so a test cannot pass by the two lists being confused.
const baseWebrtcExemptState: WebrtcExemptState = { exemptHosts: ['exempt.example'] };

function renderSecurityTab(
  overrides: {
    update?: (partial: Partial<Settings>) => void;
    listExceptions?: () => Promise<string[]>;
    removeException?: (host: string) => void;
    fingerprintState?: FingerprintState;
    toggleFingerprintAllowlist?: (host: string) => void;
    removeFingerprintAllowlist?: (host: string) => void;
    webrtcExempt?: WebrtcExemptState;
    toggleWebrtcExempt?: (host: string) => void;
    removeWebrtcExempt?: (host: string) => void;
    settings?: Settings;
  } = {},
) {
  return render(
    <SecurityTab
      settings={overrides.settings ?? baseSettings}
      update={overrides.update ?? vi.fn()}
      listExceptions={overrides.listExceptions ?? (async () => [])}
      removeException={overrides.removeException ?? vi.fn()}
      fingerprintState={overrides.fingerprintState ?? baseFingerprintState}
      toggleFingerprintAllowlist={overrides.toggleFingerprintAllowlist ?? vi.fn()}
      removeFingerprintAllowlist={overrides.removeFingerprintAllowlist ?? vi.fn()}
      webrtcExempt={overrides.webrtcExempt ?? baseWebrtcExemptState}
      toggleWebrtcExempt={overrides.toggleWebrtcExempt ?? vi.fn()}
      removeWebrtcExempt={overrides.removeWebrtcExempt ?? vi.fn()}
    />,
  );
}

describe('SecurityTab', () => {
  it('reflects httpsOnly and toggles it via update', async () => {
    const update = vi.fn();
    renderSecurityTab({ update });
    const toggle = screen.getByRole('checkbox', { name: /https-only/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ httpsOnly: false });
  });

  it('reflects webrtcPolicy and changes it via update', async () => {
    const update = vi.fn();
    renderSecurityTab({ update });
    const select = screen.getByRole('combobox', { name: /webrtc policy/i });
    expect(select).toHaveValue('public-only');
    await userEvent.selectOptions(select, 'disable');
    expect(update).toHaveBeenCalledWith({ webrtcPolicy: 'disable' });
  });

  it('shows malicious-site protection as on (always)', () => {
    renderSecurityTab();
    expect(screen.getByText(/malicious-site protection/i)).toBeInTheDocument();
    // The malicious-site paragraph states the protection is always-on.
    expect(screen.getByText(/known malware and phishing sites are blocked/i)).toBeInTheDocument();
  });

  it('lists exceptions and removes one (via a descriptive aria-label)', async () => {
    const removeException = vi.fn();
    renderSecurityTab({
      listExceptions: async () => ['neverssl.com'],
      removeException,
    });
    expect(await screen.findByText('neverssl.com')).toBeInTheDocument();
    // The HTTP-exception Remove button now carries a descriptive aria-label
    // (parity with its fingerprint-allowlist sibling).
    await userEvent.click(
      screen.getByRole('button', { name: /remove http exception for neverssl\.com/i }),
    );
    expect(removeException).toHaveBeenCalledWith('neverssl.com');
  });

  /**
   * The farbling seed is generated per TAB SPAWN, not per session: the Rust side
   * bakes a fresh seed into the document-start script for each newly created or
   * reloaded tab. So changing the level mid-session leaves every already-open tab
   * on its old seed — and the UI used to claim "regenerated each session", which
   * tells the user a reload is unnecessary when a reload is exactly what is needed.
   */
  it('states the per-spawn limit, not a per-session one', () => {
    renderSecurityTab();
    expect(screen.getByText(/only (takes effect|applies) (on|in)/i)).toBeInTheDocument();
    expect(screen.queryByText(/regenerated each session/i)).toBeNull();
  });

  // Anti-fingerprinting section

  it('renders anti-fingerprinting level select with value from settings', () => {
    const settings = { ...baseSettings, antiFingerprint: 'standard' } as Settings;
    renderSecurityTab({ settings });
    const select = screen.getByRole('combobox', { name: /anti-fingerprinting level/i });
    expect(select).toHaveValue('standard');
  });

  it('changing the anti-fingerprint level calls update({ antiFingerprint })', async () => {
    const update = vi.fn();
    renderSecurityTab({ update });
    const select = screen.getByRole('combobox', { name: /anti-fingerprinting level/i });
    await userEvent.selectOptions(select, 'standard');
    expect(update).toHaveBeenCalledWith({ antiFingerprint: 'standard' });
  });

  it('renders allowlisted hosts from fingerprintState', () => {
    const fingerprintState: FingerprintState = {
      level: 'standard',
      allowlistedHosts: ['allowed.com', 'other.net'],
    };
    renderSecurityTab({ fingerprintState });
    expect(screen.getByText('allowed.com')).toBeInTheDocument();
    expect(screen.getByText('other.net')).toBeInTheDocument();
  });

  it('clicking Remove on a fingerprint allowlist host calls removeFingerprintAllowlist', async () => {
    const removeFingerprintAllowlist = vi.fn();
    const fingerprintState: FingerprintState = {
      level: 'standard',
      allowlistedHosts: ['allowed.com'],
    };
    renderSecurityTab({ fingerprintState, removeFingerprintAllowlist });
    const btn = screen.getByRole('button', { name: /remove allowed\.com/i });
    await userEvent.click(btn);
    expect(removeFingerprintAllowlist).toHaveBeenCalledWith('allowed.com');
  });

  it('adding a host via input+button calls toggleFingerprintAllowlist and clears input', async () => {
    const toggleFingerprintAllowlist = vi.fn();
    renderSecurityTab({ toggleFingerprintAllowlist });
    const input = screen.getByRole('textbox', { name: /host to add to fingerprint allowlist/i });
    const btn = screen.getByRole('button', { name: /add host to fingerprint allowlist/i });
    await userEvent.type(input, 'newsite.com');
    await userEvent.click(btn);
    expect(toggleFingerprintAllowlist).toHaveBeenCalledWith('newsite.com');
    expect(input).toHaveValue('');
  });

  it('Add does NOT toggle a host that is already allowlisted (would remove it)', async () => {
    const toggleFingerprintAllowlist = vi.fn();
    const fingerprintState: FingerprintState = {
      level: 'standard',
      allowlistedHosts: ['already.com'],
    };
    renderSecurityTab({ fingerprintState, toggleFingerprintAllowlist });
    const input = screen.getByRole('textbox', { name: /host to add to fingerprint allowlist/i });
    const btn = screen.getByRole('button', { name: /add host to fingerprint allowlist/i });
    await userEvent.type(input, 'already.com');
    await userEvent.click(btn);
    // It's already on the allowlist — Add must be a no-op, NOT toggle it back off.
    expect(toggleFingerprintAllowlist).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('shows the honest-limit note about detectability', () => {
    renderSecurityTab();
    expect(screen.getByText(/opt-in/i)).toBeInTheDocument();
    expect(screen.getByText(/anti-bot vendors/i)).toBeInTheDocument();
  });

  it('the Standard option does NOT claim it noises WebGL (WebGL is strict-only)', () => {
    renderSecurityTab();
    const standardOption = screen
      .getByRole('combobox', { name: /anti-fingerprinting level/i })
      .querySelector('option[value="standard"]');
    expect(standardOption).toBeTruthy();
    expect(standardOption?.textContent ?? '').not.toMatch(/webgl/i);
    // The Strict option is where WebGL belongs.
    const strictOption = screen
      .getByRole('combobox', { name: /anti-fingerprinting level/i })
      .querySelector('option[value="strict"]');
    expect(strictOption?.textContent ?? '').toMatch(/webgl/i);
  });

  it('the explanatory copy attributes WebGL to Strict, not Standard, and drops dev jargon', () => {
    renderSecurityTab();
    // Plain-language reword: no raw "CSPRNG" / "farbling" / "per frame origin" jargon.
    expect(screen.queryByText(/CSPRNG/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/farbling/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/per frame origin/i)).not.toBeInTheDocument();
    // Plain-language explanation present.
    expect(screen.getByText(/randomized noise/i)).toBeInTheDocument();
    // The seed is per-SPAWN (per tab), not per session. This assertion was
    // `getByText(/regenerated each session/i)`, which asserted the copy was TRUE when
    // it was false: the seed is baked in when a tab is created, so a level change does
    // not reach already-open tabs. It told the user no reload was needed when a reload
    // is exactly what is needed. It is now the drift guard for the honest wording.
    expect(screen.getByText(/only takes effect in tabs/i)).toBeInTheDocument();
    expect(screen.queryByText(/regenerated each session/i)).toBeNull();
  });
});

/**
 * The WebRTC exemption list (7(2)). The security property is what these assert: the list
 * the user edits here is the list the core reads, and it is a SEPARATE store from the
 * ad-block allowlist — so an ad-block allowlist entry must never appear here, and a host
 * exempted here must not be reported as ad-block-allowlisted.
 */
describe('SecurityTab WebRTC exemptions', () => {
  it('lists the hosts the core reports, and only those', () => {
    renderSecurityTab({ webrtcExempt: { exemptHosts: ['a.example', 'b.example'] } });
    expect(screen.getByText('a.example')).toBeInTheDocument();
    expect(screen.getByText('b.example')).toBeInTheDocument();
    // The ad-block allowlist fixture is empty, so a host cannot leak in from it.
    expect(
      screen.queryByRole('button', { name: /ad-block allowlist.*Remove a\.example/ }),
    ).not.toBeInTheDocument();
  });

  it('sends the host the user typed to the core', async () => {
    const toggleWebrtcExempt = vi.fn();
    renderSecurityTab({ webrtcExempt: { exemptHosts: [] }, toggleWebrtcExempt });
    const input = screen.getByLabelText('Host to exempt from WebRTC protection');
    await userEvent.type(input, 'new.example');
    await userEvent.click(screen.getByRole('button', { name: 'Add host to WebRTC exemptions' }));
    expect(toggleWebrtcExempt).toHaveBeenCalledWith('new.example');
  });

  it('does not re-add a host that is already listed', async () => {
    // The channel is a TOGGLE, so re-adding an already-listed host would REMOVE it. A user
    // clicking Add twice must not silently un-exempt the host.
    const toggleWebrtcExempt = vi.fn();
    renderSecurityTab({
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
    renderSecurityTab({ webrtcExempt: { exemptHosts: [] }, toggleWebrtcExempt });
    const add = screen.getByRole('button', { name: 'Add host to WebRTC exemptions' });
    expect(add).toBeDisabled();
    await userEvent.type(screen.getByLabelText('Host to exempt from WebRTC protection'), '   ');
    expect(add).toBeDisabled();
    expect(toggleWebrtcExempt).not.toHaveBeenCalled();
  });

  it('removes exactly the host whose button was pressed', async () => {
    const removeWebrtcExempt = vi.fn();
    renderSecurityTab({
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
    renderSecurityTab({ webrtcExempt: { exemptHosts: [] } });
    expect(screen.getByText(/No sites are exempted from WebRTC protection/i)).toBeInTheDocument();
  });
});
