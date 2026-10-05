import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { FingerprintTab } from './FingerprintTab';
import type { FingerprintState, Settings } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as Settings;
const baseFingerprintState: FingerprintState = { level: 'off', allowlistedHosts: [] };

function renderFingerprintTab(
  overrides: {
    update?: (partial: Partial<Settings>) => void;
    fingerprintState?: FingerprintState;
    toggleFingerprintAllowlist?: (host: string) => void;
    removeFingerprintAllowlist?: (host: string) => void;
    settings?: Settings;
  } = {},
) {
  return render(
    <FingerprintTab
      settings={overrides.settings ?? baseSettings}
      update={overrides.update ?? vi.fn()}
      fingerprintState={overrides.fingerprintState ?? baseFingerprintState}
      toggleFingerprintAllowlist={overrides.toggleFingerprintAllowlist ?? vi.fn()}
      removeFingerprintAllowlist={overrides.removeFingerprintAllowlist ?? vi.fn()}
    />,
  );
}

describe('FingerprintTab', () => {
  it('renders anti-fingerprinting level select with value from settings', () => {
    const settings = { ...baseSettings, antiFingerprint: 'standard' } as Settings;
    renderFingerprintTab({ settings });
    const select = screen.getByRole('combobox', { name: /anti-fingerprinting level/i });
    expect(select).toHaveValue('standard');
  });

  it('changing the anti-fingerprint level calls update({ antiFingerprint })', async () => {
    const update = vi.fn();
    renderFingerprintTab({ update });
    const select = screen.getByRole('combobox', { name: /anti-fingerprinting level/i });
    await userEvent.selectOptions(select, 'standard');
    expect(update).toHaveBeenCalledWith({ antiFingerprint: 'standard' });
  });

  /**
   * The farbling seed is generated per TAB SPAWN, not per session: the Rust side
   * bakes a fresh seed into the document-start script for each newly created or
   * reloaded tab. So changing the level mid-session leaves every already-open tab
   * on its old seed — and the UI used to claim "regenerated each session", which
   * tells the user a reload is unnecessary when a reload is exactly what is needed.
   */
  it('states the per-spawn limit, not a per-session one', () => {
    renderFingerprintTab();
    expect(screen.getByText(/only (takes effect|applies) (on|in)/i)).toBeInTheDocument();
    expect(screen.queryByText(/regenerated each session/i)).toBeNull();
  });

  it('renders allowlisted hosts from fingerprintState', () => {
    const fingerprintState: FingerprintState = {
      level: 'standard',
      allowlistedHosts: ['allowed.com', 'other.net'],
    };
    renderFingerprintTab({ fingerprintState });
    expect(screen.getByText('allowed.com')).toBeInTheDocument();
    expect(screen.getByText('other.net')).toBeInTheDocument();
  });

  it('clicking Remove on a fingerprint allowlist host calls removeFingerprintAllowlist', async () => {
    const removeFingerprintAllowlist = vi.fn();
    const fingerprintState: FingerprintState = {
      level: 'standard',
      allowlistedHosts: ['allowed.com'],
    };
    renderFingerprintTab({ fingerprintState, removeFingerprintAllowlist });
    const btn = screen.getByRole('button', { name: /remove allowed\.com/i });
    await userEvent.click(btn);
    expect(removeFingerprintAllowlist).toHaveBeenCalledWith('allowed.com');
  });

  it('adding a host via input+button calls toggleFingerprintAllowlist and clears input', async () => {
    const toggleFingerprintAllowlist = vi.fn();
    renderFingerprintTab({ toggleFingerprintAllowlist });
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
    renderFingerprintTab({ fingerprintState, toggleFingerprintAllowlist });
    const input = screen.getByRole('textbox', { name: /host to add to fingerprint allowlist/i });
    const btn = screen.getByRole('button', { name: /add host to fingerprint allowlist/i });
    await userEvent.type(input, 'already.com');
    await userEvent.click(btn);
    // It's already on the allowlist — Add must be a no-op, NOT toggle it back off.
    expect(toggleFingerprintAllowlist).not.toHaveBeenCalled();
    expect(input).toHaveValue('');
  });

  it('shows the honest-limit note about detectability', () => {
    renderFingerprintTab();
    expect(screen.getByText(/opt-in/i)).toBeInTheDocument();
    expect(screen.getByText(/anti-bot vendors/i)).toBeInTheDocument();
  });

  it('the Standard option does NOT claim it noises WebGL (WebGL is strict-only)', () => {
    renderFingerprintTab();
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
    renderFingerprintTab();
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

  it('does not render the HTTPS or WebRTC controls', () => {
    renderFingerprintTab();
    expect(screen.queryByRole('checkbox', { name: /https-only/i })).toBeNull();
    expect(screen.queryByRole('combobox', { name: /webrtc policy/i })).toBeNull();
    expect(
      screen.queryByRole('textbox', { name: /host to exempt from WebRTC protection/i }),
    ).toBeNull();
  });
});
