// src/components/SyncSettingsTab.tsx
import { useEffect, useRef, useState } from 'react';
import type { SyncDevice, SyncState } from '../../shared/types';
import type { UseSync } from '../hooks/useSync';
import { confirm, toast } from '../lib/toast';

/** Friendly label for the raw sync-engine status enum. */
function statusLabel(status: SyncState['status']): string {
  switch (status) {
    case 'idle':
      return 'Up to date';
    case 'syncing':
      return 'Syncing…';
    case 'error':
      return 'Sync error';
    case 'disabled':
      return 'Off';
    default:
      return status;
  }
}

/** Friendly label for where the encryption keys are stored. */
function vaultBackingLabel(backing: SyncState['vaultBacking']): string {
  switch (backing) {
    case 'keychain':
      return 'Device keychain';
    case 'passphrase':
      return 'Passphrase-protected';
    case 'none':
      return 'Not protected';
    default:
      return backing;
  }
}

export function SyncSettingsTab({
  sync,
  onSetServerUrl,
}: {
  sync: UseSync;
  onSetServerUrl: (url: string) => void | Promise<void>;
}) {
  const { state } = sync;
  const [serverUrl, setServerUrl] = useState(state.serverUrl);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [restore, setRestore] = useState('');
  const [setupPassphrase, setSetupPassphrase] = useState('');
  const [restorePassphrase, setRestorePassphrase] = useState('');
  const [unlockPassphrase, setUnlockPassphrase] = useState('');
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [testStatus, setTestStatus] = useState('');

  // Keep the URL field in step with the backend value (e.g. after enable/import).
  useEffect(() => {
    setServerUrl(state.serverUrl);
  }, [state.serverUrl]);

  // Never let a revealed recovery phrase linger across an enable/disable transition (it
  // would otherwise carry from the enabled view into the setup view, or vice versa).
  useEffect(() => {
    setPhrase(null);
  }, [state.enabled]);

  // Refresh the device list while enabled (and after each sync). Use a ref for sync
  // to avoid stale closures while keeping stable deps.
  const syncRef = useRef(sync);
  syncRef.current = sync;

  useEffect(() => {
    if (!state.enabled) return;
    let active = true;
    void syncRef.current.listDevices().then((d) => {
      if (active) setDevices(d);
    });
    return () => {
      active = false;
    };
  }, [state.enabled, state.lastSyncMs]);

  const run = async (
    fn: () => Promise<void>,
    message:
      | string
      | ((
          error: unknown,
        ) => string) = "Couldn't reach the sync server — check the URL and your connection.",
  ) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      console.error('Sync action failed:', e);
      setError(typeof message === 'function' ? message(e) : message);
    } finally {
      setBusy(false);
    }
  };

  const commitServerUrl = async (): Promise<string> => {
    const next = serverUrl.trim();
    await onSetServerUrl(next);
    return next;
  };

  const enableNew = async () => {
    await commitServerUrl();
    const passphrase = setupPassphrase.trim();
    setPhrase(passphrase ? await sync.enableNew(passphrase) : await sync.enableNew());
  };

  const enableFromPhrase = async () => {
    await commitServerUrl();
    const phraseText = restore.trim();
    const passphrase = restorePassphrase.trim();
    if (passphrase) {
      await sync.enableFromPhrase(phraseText, passphrase);
    } else {
      await sync.enableFromPhrase(phraseText);
    }
  };

  const unlock = async () => {
    await commitServerUrl();
    await sync.unlock(unlockPassphrase.trim());
  };

  const copyPhrase = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      toast.success('Recovery phrase copied');
    } catch (e) {
      console.error('Failed to copy recovery phrase:', e);
      toast.error("Couldn't copy the recovery phrase");
    }
  };

  if (!state.enabled) {
    return (
      <div className="sync-tab">
        <h3>Sync server</h3>
        <p>
          End-to-end encrypted sync across your devices. The server only ever stores encrypted data
          &mdash; it can&apos;t read your bookmarks, saved items, or allowlist.
        </p>
        <label className="sync-tab__field">
          <span>Server URL</span>
          <input
            type="url"
            value={serverUrl}
            placeholder="https://your-sync-server.example"
            aria-label="Sync server URL"
            onChange={(e) => {
              setServerUrl(e.target.value);
              setTestStatus('');
            }}
            onBlur={() => void commitServerUrl()}
          />
        </label>
        <button
          type="button"
          disabled={busy || serverUrl.trim().length === 0}
          onClick={() =>
            void run(async () => {
              const url = await commitServerUrl();
              const r = await sync.testConnection(url);
              setTestStatus(
                r.ok ? `Connected — ${r.latencyMs} ms` : `Failed: ${r.error ?? 'unreachable'}`,
              );
            })
          }
        >
          Test connection
        </button>
        {testStatus && (
          <p className="sync-tab__status" role="status">
            {testStatus}
          </p>
        )}

        {phrase ? (
          <div className="sync-tab__phrase" role="alert">
            <h3>Your recovery phrase</h3>
            <p>
              Write these 24 words down and keep them safe. They are the ONLY way to recover your
              synced data &mdash; no one (including us) can reset them.
            </p>
            <code className="sync-tab__phrase-words">{phrase}</code>
            <button
              type="button"
              onClick={() => void copyPhrase(phrase)}
              aria-label="Copy recovery phrase"
            >
              Copy
            </button>
            <button type="button" onClick={() => setPhrase(null)}>
              I&apos;ve saved it
            </button>
          </div>
        ) : (
          <>
            {state.hasStoredRoot && (
              <>
                <h3>Unlock sync</h3>
                <p>A sync vault is saved on this device. Enter its passphrase to resume syncing.</p>
                <label className="sync-tab__field">
                  <span>Sync passphrase</span>
                  <input
                    type="password"
                    value={unlockPassphrase}
                    placeholder="Enter your sync passphrase"
                    aria-label="Sync unlock passphrase"
                    autoComplete="current-password"
                    onChange={(e) => setUnlockPassphrase(e.target.value)}
                  />
                </label>
                <button
                  type="button"
                  disabled={busy || unlockPassphrase.trim().length === 0}
                  onClick={() =>
                    void run(unlock, (e) =>
                      e instanceof Error && e.message
                        ? e.message
                        : "Couldn't unlock sync — check the passphrase.",
                    )
                  }
                >
                  Unlock sync
                </button>
              </>
            )}

            <h3>Set up sync</h3>
            <label className="sync-tab__field">
              <span>Sync passphrase (optional)</span>
              <input
                type="password"
                value={setupPassphrase}
                placeholder="Protect keys if the device keychain is unavailable"
                aria-label="Sync passphrase optional"
                autoComplete="new-password"
                onChange={(e) => setSetupPassphrase(e.target.value)}
              />
            </label>
            <p className="sync-tab__status">
              Recommended if your device keychain is unavailable; otherwise sync keys may only last
              until the app closes.
            </p>
            <button type="button" disabled={busy} onClick={() => void run(enableNew)}>
              Start new sync
            </button>

            <h3>Restore from a recovery phrase</h3>
            <textarea
              value={restore}
              aria-label="Recovery phrase"
              placeholder="Enter your 24-word recovery phrase"
              onChange={(e) => setRestore(e.target.value)}
            />
            <label className="sync-tab__field">
              <span>Sync passphrase (if used)</span>
              <input
                type="password"
                value={restorePassphrase}
                placeholder="Enter the passphrase for this sync vault"
                aria-label="Sync passphrase for restore"
                autoComplete="current-password"
                onChange={(e) => setRestorePassphrase(e.target.value)}
              />
            </label>
            <button
              type="button"
              disabled={busy || restore.trim().length === 0}
              onClick={() => void run(enableFromPhrase)}
            >
              Restore
            </button>
          </>
        )}
        {error && (
          <p className="sync-tab__error" role="alert">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="sync-tab">
      <h3>Sync</h3>
      <p>
        Status: {statusLabel(state.status)}
        {state.lastError ? ` — ${state.lastError}` : ''}
      </p>
      <p>Key storage: {vaultBackingLabel(state.vaultBacking)}</p>
      <button type="button" disabled={busy} onClick={() => void run(() => sync.syncNow())}>
        Sync now
      </button>

      <h3>Recovery phrase</h3>
      {phrase ? (
        <div className="sync-tab__phrase" role="alert">
          <code className="sync-tab__phrase-words">{phrase}</code>
          <button
            type="button"
            onClick={() => void copyPhrase(phrase)}
            aria-label="Copy recovery phrase"
          >
            Copy
          </button>
          <button type="button" onClick={() => setPhrase(null)}>
            Hide
          </button>
        </div>
      ) : (
        <button
          type="button"
          disabled={busy}
          onClick={() => void run(async () => setPhrase(await sync.getRecoveryPhrase()))}
        >
          Show recovery phrase
        </button>
      )}

      <h3>Devices</h3>
      <p>
        Restoring from your phrase adds a new device entry each time &mdash; remove any you no
        longer use.
      </p>
      <ul className="sync-tab__devices">
        {devices.map((d) => (
          <li key={d.deviceId}>
            <span>
              {d.label}
              {d.isThisDevice ? ' (this device)' : ''}
            </span>
            {!d.isThisDevice && (
              <button
                type="button"
                disabled={busy}
                onClick={() =>
                  void (async () => {
                    if (
                      await confirm(
                        `Remove “${d.label}” from your synced devices? It will need your recovery phrase to sync again.`,
                        { destructive: true },
                      )
                    ) {
                      void run(async () => setDevices(await sync.removeDevice(d.deviceId)));
                    }
                  })()
                }
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <h3>Disable sync</h3>
      <label className="sync-tab__field">
        <input type="checkbox" checked={forget} onChange={(e) => setForget(e.target.checked)} />
        <span>Also forget the encryption keys on this device</span>
      </label>
      <button
        type="button"
        disabled={busy}
        onClick={() =>
          void (async () => {
            if (
              await confirm(
                'Disable sync and forget the encryption keys on this device? You will need your recovery phrase to re-enable.',
                { destructive: true },
              )
            ) {
              void run(() => sync.disable(forget));
            }
          })()
        }
      >
        Disable sync
      </button>
      {error && (
        <p className="sync-tab__error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default SyncSettingsTab;
