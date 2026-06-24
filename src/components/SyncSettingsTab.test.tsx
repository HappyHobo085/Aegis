import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncSettingsTab } from './SyncSettingsTab';
import type { UseSync } from '../hooks/useSync';
import type { SyncState } from '../../shared/types';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
  toast: { success: vi.fn(), error: vi.fn() },
}));
import { confirm, toast } from '../lib/toast';

const disabled: SyncState = {
  enabled: false,
  status: 'disabled',
  serverUrl: '',
  lastSyncMs: 0,
  lastError: '',
  deviceId: '',
  accountId: '',
  vaultBacking: 'none',
};
const enabled: SyncState = {
  ...disabled,
  enabled: true,
  status: 'idle',
  serverUrl: 'https://s.example',
  deviceId: 'devA',
  vaultBacking: 'keychain',
};

function fakeSync(over: Partial<UseSync> = {}): UseSync {
  return {
    state: disabled,
    enableNew: vi.fn(async () => 'alpha bravo charlie'),
    enableFromPhrase: vi.fn(async () => {}),
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
    render(<SyncSettingsTab sync={fakeSync({ enableNew })} onSetServerUrl={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    expect(enableNew).toHaveBeenCalled();
    expect(await screen.findByText('alpha bravo charlie')).toBeInTheDocument();
    // Dismissing the phrase hides it.
    await userEvent.click(screen.getByRole('button', { name: /i've saved it/i }));
    expect(screen.queryByText('alpha bravo charlie')).not.toBeInTheDocument();
  });

  it('disabled: editing the server URL commits on blur', async () => {
    const onSetServerUrl = vi.fn();
    render(<SyncSettingsTab sync={fakeSync()} onSetServerUrl={onSetServerUrl} />);
    const input = screen.getByLabelText(/sync server url/i);
    await userEvent.type(input, 'https://x.example');
    await userEvent.tab();
    expect(onSetServerUrl).toHaveBeenCalledWith('https://x.example');
  });

  it('disabled: restore is blocked until a phrase is entered', async () => {
    const enableFromPhrase = vi.fn(async () => {});
    render(<SyncSettingsTab sync={fakeSync({ enableFromPhrase })} onSetServerUrl={vi.fn()} />);
    const restore = screen.getByRole('button', { name: /^restore$/i });
    expect(restore).toBeDisabled();
    await userEvent.type(screen.getByLabelText(/recovery phrase/i), 'word word word');
    expect(restore).toBeEnabled();
    await userEvent.click(restore);
    expect(enableFromPhrase).toHaveBeenCalledWith('word word word');
  });

  it('disabled: Test connection reports success with latency', async () => {
    const testConnection = vi.fn(async () => ({ ok: true, latencyMs: 42 }));
    render(<SyncSettingsTab sync={fakeSync({ testConnection })} onSetServerUrl={vi.fn()} />);
    const url = screen.getByLabelText(/sync server url/i);
    await userEvent.clear(url);
    await userEvent.type(url, 'http://localhost:8787');
    await userEvent.click(screen.getByRole('button', { name: /test connection/i }));
    expect(testConnection).toHaveBeenCalledWith('http://localhost:8787');
    expect(await screen.findByText(/connected/i)).toBeInTheDocument();
  });

  it('disabled: Test connection reports failure', async () => {
    const testConnection = vi.fn(async () => ({ ok: false, error: 'refused' }));
    render(<SyncSettingsTab sync={fakeSync({ testConnection })} onSetServerUrl={vi.fn()} />);
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
    render(<SyncSettingsTab sync={fakeSync({ enableNew })} onSetServerUrl={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: /start new sync/i }));
    expect(await screen.findByText(/couldn't reach the sync server/i)).toBeInTheDocument();
    // The raw error string must NOT be surfaced to the user.
    expect(screen.queryByText(/ECONNREFUSED/)).not.toBeInTheDocument();
  });

  it('disabled: Copy writes the phrase to the clipboard and toasts success', async () => {
    const enableNew = vi.fn(async () => 'alpha bravo charlie');
    render(<SyncSettingsTab sync={fakeSync({ enableNew })} onSetServerUrl={vi.fn()} />);
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
      <SyncSettingsTab sync={fakeSync({ state: enabled, disable })} onSetServerUrl={vi.fn()} />,
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
      />,
    );
    const removeBtn = await screen.findByRole('button', { name: /^remove$/i });
    await userEvent.click(removeBtn);
    expect(removeDevice).not.toHaveBeenCalled();
  });
});
