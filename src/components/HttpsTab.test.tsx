import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { HttpsTab } from './HttpsTab';
import type { Settings } from '../../shared/types';

const baseSettings = {
  httpsOnly: true,
  webrtcPolicy: 'public-only',
  antiFingerprint: 'off',
} as Settings;

function renderHttpsTab(
  overrides: {
    update?: (partial: Partial<Settings>) => void;
    listExceptions?: () => Promise<string[]>;
    removeException?: (host: string) => void;
    settings?: Settings;
  } = {},
) {
  return render(
    <HttpsTab
      settings={overrides.settings ?? baseSettings}
      update={overrides.update ?? vi.fn()}
      listExceptions={overrides.listExceptions ?? (async () => [])}
      removeException={overrides.removeException ?? vi.fn()}
    />,
  );
}

// `.aegis-mobile` lives on `<html>` for the whole module, so a test that sets it
// MUST clear it or every later test in this file renders the Android branch.
afterEach(() => {
  document.documentElement.classList.remove('aegis-mobile');
});

describe('HttpsTab', () => {
  it('reflects httpsOnly and toggles it via update', async () => {
    const update = vi.fn();
    renderHttpsTab({ update });
    const toggle = screen.getByRole('checkbox', { name: /https-only/i });
    expect(toggle).toBeChecked();
    await userEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ httpsOnly: false });
  });

  it('offers no HTTPS-Only switch on Android, and says why', () => {
    // The desktop side of the pair is the test above: it uses `getByRole`, which
    // THROWS when the checkbox is absent, so it cannot pass while this passes.
    document.documentElement.classList.add('aegis-mobile');
    renderHttpsTab();
    // `queryAllByRole` — `getAllByRole` throws on an empty match, so the
    // "expect(…).toHaveLength(0)" idiom has to use the query form.
    expect(screen.queryAllByRole('checkbox', { name: /https-only/i })).toHaveLength(0);
    // …and the control is not merely hidden: the user is told the setting is
    // unconditional, because the alternative is a silently inert privacy control.
    expect(screen.getByText(/always on here/i)).toBeTruthy();
  });

  it('lists exceptions and removes one (via a descriptive aria-label)', async () => {
    const removeException = vi.fn();
    renderHttpsTab({
      listExceptions: async () => ['neverssl.com'],
      removeException,
    });
    expect(await screen.findByText('neverssl.com')).toBeInTheDocument();
    // The HTTP-exception Remove button carries a descriptive aria-label (parity with
    // its fingerprint-allowlist sibling).
    await userEvent.click(
      screen.getByRole('button', { name: /remove http exception for neverssl\.com/i }),
    );
    expect(removeException).toHaveBeenCalledWith('neverssl.com');
  });

  it('says plainly when no exception is remembered', () => {
    renderHttpsTab();
    expect(screen.getByText(/No HTTP exceptions remembered/i)).toBeInTheDocument();
  });

  // The split's whole point: each tab now receives ONLY what it reads. This tab is
  // the one that must not carry the WebRTC or fingerprinting controls any more.
  it('does not render the WebRTC or fingerprinting controls', () => {
    renderHttpsTab();
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
