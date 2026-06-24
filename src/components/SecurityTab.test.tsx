import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SecurityTab } from './SecurityTab';
import type { FingerprintState } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as never;
const baseFingerprintState: FingerprintState = { level: 'off', allowlistedHosts: [] };

function renderSecurityTab(
  overrides: {
    update?: ReturnType<typeof vi.fn>;
    listExceptions?: () => Promise<string[]>;
    removeException?: ReturnType<typeof vi.fn>;
    fingerprintState?: FingerprintState;
    toggleFingerprintAllowlist?: ReturnType<typeof vi.fn>;
    removeFingerprintAllowlist?: ReturnType<typeof vi.fn>;
    settings?: typeof baseSettings;
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
    // "On —" appears in the malicious-site protection paragraph
    expect(screen.getByText(/on\s*—/i)).toBeInTheDocument();
  });

  it('lists exceptions and removes one', async () => {
    const removeException = vi.fn();
    renderSecurityTab({
      listExceptions: async () => ['neverssl.com'],
      removeException,
    });
    expect(await screen.findByText('neverssl.com')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /remove/i }));
    expect(removeException).toHaveBeenCalledWith('neverssl.com');
  });

  // Anti-fingerprinting section

  it('renders anti-fingerprinting level select with value from settings', () => {
    const settings = { ...baseSettings, antiFingerprint: 'standard' } as never;
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

  it('shows the honest-limit note about detectability', () => {
    renderSecurityTab();
    expect(screen.getByText(/opt-in/i)).toBeInTheDocument();
    expect(screen.getByText(/anti-bot vendors/i)).toBeInTheDocument();
  });
});
