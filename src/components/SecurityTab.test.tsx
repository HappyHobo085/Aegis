import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';
import type { FingerprintState, Settings } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as Settings;
const baseFingerprintState: FingerprintState = { level: 'off', allowlistedHosts: [] };

function renderSecurityTab(
  overrides: {
    update?: (partial: Partial<Settings>) => void;
    listExceptions?: () => Promise<string[]>;
    removeException?: (host: string) => void;
    fingerprintState?: FingerprintState;
    toggleFingerprintAllowlist?: (host: string) => void;
    removeFingerprintAllowlist?: (host: string) => void;
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
    expect(screen.getByText(/regenerated each session/i)).toBeInTheDocument();
  });
});
