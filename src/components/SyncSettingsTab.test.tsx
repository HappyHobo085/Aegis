import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SyncSettingsTab } from './SyncSettingsTab';
import type { UseSync } from '../hooks/useSync';
import type { SyncState } from '../../shared/types';

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

  it('enabled: shows status, reveals the phrase on confirm, and disables', async () => {
    const getRecoveryPhrase = vi.fn(async () => 'my secret phrase');
    const disable = vi.fn(async () => {});
    render(
      <SyncSettingsTab
        sync={fakeSync({ state: enabled, getRecoveryPhrase, disable })}
        onSetServerUrl={vi.fn()}
      />,
    );
    expect(screen.getByText(/key storage: keychain/i)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show recovery phrase/i }));
    expect(getRecoveryPhrase).toHaveBeenCalled();
    expect(await screen.findByText('my secret phrase')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /disable sync/i }));
    expect(disable).toHaveBeenCalled();
  });
});
