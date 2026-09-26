import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncSettingsTab, isInsecureRemoteUrl } from './SyncSettingsTab';
import type { UseSync } from '../hooks/useSync';
import type { Settings, SyncState } from '../../shared/types';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { confirm, toast } from '../lib/toast';

// The panel reads `aegis.vault.getState()` to report what the CORE thinks is
// syncing, rather than echoing the checkbox back at the user. Mocked through
// `vi.hoisted` because `vi.mock` factories are hoisted above module bodies.
const { vaultGetState } = vi.hoisted(() => ({ vaultGetState: vi.fn() }));
vi.mock('../lib/ipcClient', () => ({
  aegis: { vault: { getState: vaultGetState } },
}));

// Seeded at module scope, not in a `beforeEach`: EVERY render in this file runs
// the panel's mount-time `aegis.vault.getState()`, so an unseeded spy returns
// `undefined` and `.then(setVaultState)` throws inside a passive effect. The
// tests below override this per-case; the rest only need it to resolve.
// (`vi.clearAllMocks()` does not clear an implementation, only calls.)
vaultGetState.mockResolvedValue({
  exists: false,
  unlocked: false,
  count: 0,
  undecryptable: 0,
  syncEnabled: false,
});

const disabled: SyncState = {
  enabled: false,
  status: 'disabled',
  serverUrl: '',
  lastSyncMs: 0,
  lastError: '',
  deviceId: '',
  accountId: '',
  vaultBacking: 'none',
  hasStoredRoot: false,
};
const enabled: SyncState = {
  ...disabled,
  enabled: true,
  status: 'idle',
  serverUrl: 'https://s.example',
  deviceId: 'devA',
  vaultBacking: 'keychain',
};

// Settings + the patch setter the panel uses for the `syncVault` opt-in.
const settings = {} as Settings;
const update = vi.fn();

function fakeSync(over: Partial<UseSync> = {}): UseSync {
  return {
    state: disabled,
    enableNew: vi.fn(async () => 'alpha bravo charlie'),
    enableFromPhrase: vi.fn(async () => {}),
    unlock: vi.fn(async () => {}),
    disable: vi.fn(async () => {}),
    syncNow: vi.fn(async () => {}),
    testConnection: vi.fn(async () => ({ ok: true, latencyMs: 1 })),
    getRecoveryPhrase: vi.fn(async () => 'my secret phrase'),
    listDevices: vi.fn(async () => []),
    removeDevice: vi.fn(async () => []),
    ...over,
  } as unknown as UseSync;
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
  Object.assign(navigator, {
    clipboard: { writeText: vi.fn(async () => {}) },
  });
});

describe('SyncSettingsTab', () => {
  it('disabled: "Start new sync" enables and shows the recovery phrase once', async () => {
    const enableNew = vi.fn(async () => 'alpha bravo charlie');
    const onSetServerUrl = vi.fn();
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableNew })}
        onSetServerUrl={onSetServerUrl}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    expect(enableNew).toHaveBeenCalled();
    expect(onSetServerUrl).toHaveBeenCalledWith('');
    expect(await screen.findByText('alpha bravo charlie')).toBeInTheDocument();
    // Dismissing the phrase hides it.
    await userEvent.click(screen.getByRole('button', { name: /i've saved it/i }));
    expect(screen.queryByText('alpha bravo charlie')).not.toBeInTheDocument();
  });

  it('disabled: "Start new sync" can persist with a passphrase fallback', async () => {
    const enableNew = vi.fn(async () => 'alpha bravo charlie');
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableNew })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.type(screen.getByLabelText(/sync passphrase optional/i), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    expect(enableNew).toHaveBeenCalledWith('correct horse');
    expect(await screen.findByText('alpha bravo charlie')).toBeInTheDocument();
  });

  it('disabled: editing the server URL commits on blur', async () => {
    const onSetServerUrl = vi.fn();
    render(
      <SyncSettingsTab
        sync={fakeSync()}
        onSetServerUrl={onSetServerUrl}
        settings={settings}
        update={update}
      />,
    );
    const input = screen.getByLabelText(/sync server url/i);
    await userEvent.type(input, 'https://x.example');
    await userEvent.tab();
    expect(onSetServerUrl).toHaveBeenCalledWith('https://x.example');
  });

  it('disabled: restore is blocked until a phrase is entered', async () => {
    const enableFromPhrase = vi.fn(async () => {});
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableFromPhrase })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    const restore = screen.getByRole('button', { name: /^restore$/i });
    expect(restore).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/recovery phrase/i), 'word word word');
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    expect(enableFromPhrase).toHaveBeenCalledWith('word word word');
  });

  it('disabled: restore can use the sync passphrase vault', async () => {
    const enableFromPhrase = vi.fn(async () => {});
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableFromPhrase })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.type(screen.getByLabelText(/recovery phrase/i), 'word word word');
    await userEvent.type(screen.getByLabelText(/sync passphrase for restore/i), 'correct horse');
    await userEvent.click(screen.getByRole('button', { name: /^restore$/i }));
    expect(enableFromPhrase).toHaveBeenCalledWith('word word word', 'correct horse');
  });

  it('disabled: unlocks a stored sync vault after app restart', async () => {
    const unlock = vi.fn(async () => {});
    const onSetServerUrl = vi.fn();
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: { ...disabled, hasStoredRoot: true }, unlock })}
        onSetServerUrl={onSetServerUrl}
        settings={settings}
        update={update}
      />,
    );
    expect(screen.getByRole('heading', { name: /unlock sync/i })).toBeInTheDocument();
    const button = screen.getByRole('button', { name: /unlock sync/i });
    expect(button).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/sync unlock passphrase/i), 'correct horse');
    expect(button).toBeEnabled();
    await userEvent.click(button);
    expect(onSetServerUrl).toHaveBeenCalledWith('');
    expect(unlock).toHaveBeenCalledWith('correct horse');
  });

  it('disabled: a failed unlock shows the backend recovery guidance', async () => {
    const unlock = vi.fn(async () => {
      throw new Error(
        'No saved sync vault was found. Restore with your recovery phrase once, then set a sync passphrase.',
      );
    });
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: { ...disabled, hasStoredRoot: true }, unlock })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.type(screen.getByLabelText(/sync unlock passphrase/i), 'wrong');
    await userEvent.click(screen.getByRole('button', { name: /unlock sync/i }));
    expect(await screen.findByText(/no saved sync vault was found/i)).toBeInTheDocument();
  });

  it('disabled: Test connection reports success with latency', async () => {
    const testConnection = vi.fn(async () => ({ ok: true, latencyMs: 42 }));
    const onSetServerUrl = vi.fn();
    render(
      <SyncSettingsTab
        sync={fakeSync({ testConnection })}
        onSetServerUrl={onSetServerUrl}
        settings={settings}
        update={update}
      />,
    );
    const url = screen.getByLabelText(/sync server url/i);
    await userEvent.clear(url);
    await userEvent.type(url, 'http://localhost:8787');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(onSetServerUrl).toHaveBeenCalledWith('http://localhost:8787');
    expect(testConnection).toHaveBeenCalledWith('http://localhost:8787');
    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('disabled: Test connection reports failure', async () => {
    const testConnection = vi.fn(async () => ({ ok: false, error: 'refused' }));
    render(
      <SyncSettingsTab
        sync={fakeSync({ testConnection })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    const url = screen.getByLabelText(/sync server url/i);
    await userEvent.clear(url);
    await userEvent.type(url, 'http://bad');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(await screen.findByText(/failed: refused/i)).toBeInTheDocument();
  });

  it('enabled: shows friendly status + key storage labels, reveals the phrase, and disables', async () => {
    const getRecoveryPhrase = vi.fn(async () => 'my secret phrase');
    const disable = vi.fn(async () => {});
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, getRecoveryPhrase, disable })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    // Friendly labels — never the raw enum values.
    expect(screen.getByText(/key storage: device keychain/i)).toBeInTheDocument();
    expect(screen.getByText(/status: up to date/i)).toBeInTheDocument();
    expect(screen.queryByText(/key storage: keychain$/i)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show recovery phrase/i }));
    expect(getRecoveryPhrase).toHaveBeenCalled();
    expect(await screen.findByText('my secret phrase')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /disable sync/i }));
    expect(confirm).toHaveBeenCalled();
    expect(disable).toHaveBeenCalled();
  });

  // BUG(F8): `useSync` used to hardcode `{ confirm: true }`, so the core's "gated on an
  // explicit confirm" contract was a bypass. The panel now asks first and passes the answer
  // down, which is the only thing that makes that flag mean anything.
  describe('revealing the recovery phrase requires an explicit confirmation', () => {
    it('passes the confirmation through to the hook and shows the phrase', async () => {
      const getRecoveryPhrase = vi.fn(async (_confirmed: boolean) => 'my secret phrase');
      render(
        <SyncSettingsTab
          sync={fakeSync({ state: enabled, getRecoveryPhrase })}
          onSetServerUrl={vi.fn()}
          settings={settings}
          update={update}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /show recovery phrase/i }));
      expect(confirm).toHaveBeenCalled();
      expect(getRecoveryPhrase).toHaveBeenCalledWith(true);
      expect(await screen.findByText('my secret phrase')).toBeInTheDocument();
    });

    it('reveals NOTHING when the user declines', async () => {
      (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
      const getRecoveryPhrase = vi.fn(async (_confirmed: boolean) => 'my secret phrase');
      render(
        <SyncSettingsTab
          sync={fakeSync({ state: enabled, getRecoveryPhrase })}
          onSetServerUrl={vi.fn()}
          settings={settings}
          update={update}
        />,
      );
      await userEvent.click(screen.getByRole('button', { name: /show recovery phrase/i }));
      expect(confirm).toHaveBeenCalled();
      expect(getRecoveryPhrase).not.toHaveBeenCalled();
      expect(screen.queryByText('my secret phrase')).not.toBeInTheDocument();
    });
  });

  it('enabled: maps each raw status to a friendly label', () => {
    const cases: Array<[SyncState['status'], RegExp]> = [
      ['idle', /status: up to date/i],
      ['syncing', /status: syncing/i],
      ['error', /status: sync error/i],
    ];
    for (const [status, re] of cases) {
      const { unmount } = render(
        <SyncSettingsTab
          sync={fakeSync({ state: { ...enabled, status } })}
          onSetServerUrl={vi.fn()}
          settings={settings}
          update={update}
        />,
      );
      expect(screen.getByText(re)).toBeInTheDocument();
      unmount();
    }
  });

  it('enabled: maps each vaultBacking to a friendly label', () => {
    const cases: Array<[SyncState['vaultBacking'], RegExp]> = [
      ['keychain', /key storage: device keychain/i],
      ['passphrase', /key storage: passphrase-protected/i],
      ['none', /key storage: not protected/i],
    ];
    for (const [vaultBacking, re] of cases) {
      const { unmount } = render(
        <SyncSettingsTab
          sync={fakeSync({ state: { ...enabled, vaultBacking } })}
          onSetServerUrl={vi.fn()}
          settings={settings}
          update={update}
        />,
      );
      expect(screen.getByText(re)).toBeInTheDocument();
      unmount();
    }
  });

  it('disabled: a failed action shows a friendly message (not the raw error)', async () => {
    const enableNew = vi.fn(async () => {
      throw new Error('ECONNREFUSED 127.0.0.1:8787');
    });
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableNew })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    expect(await screen.findByText(/couldn't reach the sync server/i)).toBeInTheDocument();
    // The raw error string must NOT be surfaced to the user.
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it('disabled: Copy writes the phrase to the clipboard and toasts success', async () => {
    const enableNew = vi.fn(async () => 'alpha bravo charlie');
    render(
      <SyncSettingsTab
        sync={fakeSync({ enableNew })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    await screen.findByText('alpha bravo charlie');
    await userEvent.click(screen.getByRole('button', { name: /copy recovery phrase/i }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith('alpha bravo charlie');
    expect(toast.success).toHaveBeenCalledWith('Recovery phrase copied');
  });

  it('enabled: Copy toasts an error when the clipboard write fails', async () => {
    Object.assign(navigator, {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('denied');
        }),
      },
    });
    const getRecoveryPhrase = vi.fn(async () => 'my secret phrase');
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, getRecoveryPhrase })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /show recovery phrase/i }));
    await screen.findByText('my secret phrase');
    await userEvent.click(screen.getByRole('button', { name: /copy recovery phrase/i }));
    expect(toast.error).toHaveBeenCalled();
  });

  it('enabled: Disable sync does NOTHING when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const disable = vi.fn(async () => {});
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, disable })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    await userEvent.click(screen.getByRole('button', { name: /disable sync/i }));
    expect(confirm).toHaveBeenCalled();
    expect(disable).not.toHaveBeenCalled();
  });

  it('enabled: Remove device confirms before removing', async () => {
    const removeDevice = vi.fn(async () => []);
    const listDevices = vi.fn(async () => [
      { deviceId: 'devA', label: 'This laptop', isThisDevice: true },
      { deviceId: 'devB', label: 'Old phone', isThisDevice: false },
    ]);
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, removeDevice, listDevices })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    const removeBtn = await screen.findByRole('button', { name: /^remove$/i });
    await userEvent.click(removeBtn);
    expect(confirm).toHaveBeenCalled();
    expect(removeDevice).toHaveBeenCalledWith('devB');
  });

  it('enabled: Remove device does NOTHING when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const removeDevice = vi.fn(async () => []);
    const listDevices = vi.fn(async () => [
      { deviceId: 'devB', label: 'Old phone', isThisDevice: false },
    ]);
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, removeDevice, listDevices })}
        onSetServerUrl={vi.fn()}
        settings={settings}
        update={update}
      />,
    );
    const removeBtn = await screen.findByRole('button', { name: /^remove$/i });
    await userEvent.click(removeBtn);
    expect(removeDevice).not.toHaveBeenCalled();
  });
});

describe('SyncSettingsTab - the password-vault opt-in', () => {
  const vaultOff = {
    exists: true,
    unlocked: true,
    count: 0,
    undecryptable: 0,
    syncEnabled: false,
  };

  beforeEach(() => {
    vaultGetState.mockResolvedValue(vaultOff);
  });

  function renderEnabled(settingsOverrides: Partial<Settings> = {}, over: Partial<UseSync> = {}) {
    const localSettings = { ...settings, ...settingsOverrides } as Settings;
    const localUpdate = vi.fn();
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, ...over })}
        onSetServerUrl={vi.fn()}
        settings={localSettings}
        update={localUpdate}
      />,
    );
    return localUpdate;
  }

  it('defaults the checkbox to unchecked and reports the opt-in on check', async () => {
    const update = renderEnabled({ syncVault: false });
    const box = screen.getByRole('checkbox', { name: /sync my password vault/i });
    expect(box).not.toBeChecked();
    await userEvent.click(box);
    expect(update).toHaveBeenCalledWith({ syncVault: true });
  });

  it('checks the box when the opt-in is already on', async () => {
    renderEnabled({ syncVault: true });
    expect(screen.getByRole('checkbox', { name: /sync my password vault/i })).toBeChecked();
  });

  it('explains that joining waits for the next unlock while the core says it is not syncing', async () => {
    renderEnabled({ syncVault: true });
    expect(await screen.findByText(/not syncing yet/i)).toBeInTheDocument();
  });

  it('says nothing once the core reports the vault is actually syncing', async () => {
    vaultGetState.mockResolvedValue({ ...vaultOff, syncEnabled: true });
    renderEnabled({ syncVault: true });
    await screen.findByRole('checkbox', { name: /sync my password vault/i });
    expect(screen.queryByText(/not syncing yet/i)).not.toBeInTheDocument();
  });

  it('warns that undecryptable records hold adoption back rather than being dropped', async () => {
    vaultGetState.mockResolvedValue({ ...vaultOff, undecryptable: 3 });
    renderEnabled({ syncVault: true });
    expect(await screen.findByText(/3 undecryptable record/i)).toBeInTheDocument();
  });

  it('hides the whole section while sync is not enabled at all', async () => {
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: disabled })}
        onSetServerUrl={vi.fn()}
        settings={{ ...settings, syncVault: true } as Settings}
        update={vi.fn()}
      />,
    );
    expect(screen.queryByRole('checkbox', { name: /sync my password vault/i })).toBeNull();
    expect(vaultGetState).toHaveBeenCalled();
  });

  // ── Transport security (the plaintext-HTTP waiver) ───────────────────────

  describe('unencrypted-HTTP waiver', () => {
    const waiver = () => screen.getByRole('checkbox', { name: /allow an unencrypted http/i });

    /** The panel is PROPS-driven (same contract as the `syncVault` opt-in): `update` is the
     * parent's setter, and the parent re-renders with the merged value. Rendering through a
     * real stateful parent is what makes a write observable here — a bare `vi.fn()` would
     * leave the checkbox stuck, which is a test-harness artifact, not app behaviour. */
    const Harness = ({
      syncState = disabled,
      initial = {},
      onUpdate,
    }: {
      syncState?: SyncState;
      initial?: Partial<Settings>;
      onUpdate?: (patch: Partial<Settings>) => void;
    }) => {
      const [s, setS] = useState<Settings>(initial as Settings);
      return (
        <SyncSettingsTab
          sync={fakeSync({ state: syncState })}
          onSetServerUrl={vi.fn()}
          settings={s}
          update={(p) => {
            setS((prev) => ({ ...prev, ...p }));
            onUpdate?.(p);
          }}
        />
      );
    };

    it('is off by default and turns on with a single click', async () => {
      const onUpdate = vi.fn();
      render(<Harness onUpdate={onUpdate} />);
      expect(waiver()).not.toBeChecked();
      await userEvent.click(waiver());
      expect(onUpdate).toHaveBeenCalledWith({ syncAllowInsecure: true });
      await waitFor(() => expect(waiver()).toBeChecked());
    });

    it('refuses a plaintext REMOTE server until the waiver is ticked', async () => {
      render(<Harness />);
      await userEvent.type(
        screen.getByLabelText(/sync server url/i),
        'http://sync.example.com:8787',
      );
      expect(await screen.findByText(/unencrypted over the internet/i)).toBeInTheDocument();
      // The refusal is explicit: the user is told nothing was sent, and why.
      expect(screen.getByText(/nothing has been sent to it/i)).toBeInTheDocument();

      await userEvent.click(waiver());
      // The panel reports the decision now in force — the refusal must not linger.
      await waitFor(() =>
        expect(screen.queryByText(/nothing has been sent to it/i)).not.toBeInTheDocument(),
      );
      expect(
        screen.getByText(/anyone on the network path can see which server/i),
      ).toBeInTheDocument();
    });

    it.each([
      ['http://localhost:8787', /local to this machine/i],
      ['http://127.0.0.1:8787', /local to this machine/i],
      ['https://sync.example.com', /encrypted \(https\)/i],
    ])('treats %s as needing no waiver', async (url, label) => {
      render(<Harness />);
      await userEvent.type(screen.getByLabelText(/sync server url/i), url);
      expect(await screen.findByText(label)).toBeInTheDocument();
      // No refusal: loopback and https are fine on the default posture.
      expect(screen.queryByText(/nothing has been sent to it/i)).not.toBeInTheDocument();
    });

    it('classifies loopback the same way the core does', () => {
      // `URL` parsing (not string splitting) is what makes the suffix trick correct — the
      // same class of thing the Rust validator rejects. The IPv6 literal can't go through
      // `userEvent.type` (it parses `[`/`:` as key descriptors), so it is covered here.
      expect(isInsecureRemoteUrl('http://localhost.evil.com')).toBe(true);
      expect(isInsecureRemoteUrl('http://notlocalhost')).toBe(true);
      expect(isInsecureRemoteUrl('http://192.168.1.10:8787')).toBe(true);
      expect(isInsecureRemoteUrl('http://localhost')).toBe(false);
      expect(isInsecureRemoteUrl('http://127.0.0.1:8787')).toBe(false);
      expect(isInsecureRemoteUrl('http://[::1]:8787')).toBe(false);
      expect(isInsecureRemoteUrl('https://sync.example.com')).toBe(false);
      expect(isInsecureRemoteUrl('not a url')).toBe(false);
    });

    it('renders the section while sync is running, so the waiver can be revoked', async () => {
      const onUpdate = vi.fn();
      render(<Harness syncState={{ ...enabled, allowInsecure: true }} onUpdate={onUpdate} />);
      // The CORE's state wins, so an enabled device reports the waiver actually in force…
      await waitFor(() => expect(waiver()).toBeChecked());
      // …and turning it back off writes the revocation.
      await userEvent.click(waiver());
      expect(onUpdate).toHaveBeenCalledWith({ syncAllowInsecure: false });
    });
  });
});
