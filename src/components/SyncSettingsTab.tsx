// src/components/SyncSettingsTab.tsx
import { useEffect, useState } from 'react';
import type { SyncDevice } from '../../shared/types';
import type { UseSync } from '../hooks/useSync';

export function SyncSettingsTab({
  sync,
  onSetServerUrl,
}: {
  sync: UseSync;
  onSetServerUrl: (url: string) => void;
}) {
  const { state } = sync;
  const [serverUrl, setServerUrl] = useState(state.serverUrl);
  const [phrase, setPhrase] = useState<string | null>(null);
  const [restore, setRestore] = useState('');
  const [devices, setDevices] = useState<SyncDevice[]>([]);
  const [forget, setForget] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // Keep the URL field in step with the backend value (e.g. after enable/import).
  useEffect(() => {
    setServerUrl(state.serverUrl);
  }, [state.serverUrl]);

  // Never let a revealed recovery phrase linger across an enable/disable transition (it
  // would otherwise carry from the enabled view into the setup view, or vice versa).
  useEffect(() => {
    setPhrase(null);
  }, [state.enabled]);

  // Refresh the device list while enabled (and after each sync). `sync` is intentionally
  // NOT a dep — useSync returns a fresh object each render, and listDevices is stable, so
  // depending on it would refetch on every parent re-render.
  useEffect(() => {
    if (!state.enabled) return;
    let active = true;
    void sync.listDevices().then((d) => {
      if (active) setDevices(d);
    });
    return () => {
      active = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.enabled, state.lastSyncMs]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  if (!state.enabled) {
    return (
      <div className="sync-tab">
        <h3>Sync server</h3>
        <p>
          End-to-end encrypted sync across your devices. The server only ever stores encrypted
          data &mdash; it can&apos;t read your bookmarks, saved items, or allowlist.
        </p>
        <label className="sync-tab__field">
          <span>Server URL</span>
          <input
            type="url"
            value={serverUrl}
            placeholder="https://your-sync-server.example"
            aria-label="Sync server URL"
            onChange={(e) => setServerUrl(e.target.value)}
            onBlur={() => onSetServerUrl(serverUrl.trim())}
          />
        </label>

        {phrase ? (
          <div className="sync-tab__phrase" role="alert">
            <h3>Your recovery phrase</h3>
            <p>
              Write these 24 words down and keep them safe. They are the ONLY way to recover your
              synced data &mdash; no one (including us) can reset them.
            </p>
            <code className="sync-tab__phrase-words">{phrase}</code>
            <button type="button" onClick={() => setPhrase(null)}>
              I&apos;ve saved it
            </button>
          </div>
        ) : (
          <>
            <h3>Set up sync</h3>
            <button
              type="button"
              disabled={busy}
              onClick={() => void run(async () => setPhrase(await sync.enableNew()))}
            >
              Start new sync
            </button>

            <h3>Restore from a recovery phrase</h3>
            <textarea
              value={restore}
              aria-label="Recovery phrase"
              placeholder="Enter your 24-word recovery phrase"
              onChange={(e) => setRestore(e.target.value)}
            />
            <button
              type="button"
              disabled={busy || restore.trim().length === 0}
              onClick={() => void run(() => sync.enableFromPhrase(restore.trim()))}
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
        Status: {state.status}
        {state.lastError ? ` — ${state.lastError}` : ''}
      </p>
      <p>Key storage: {state.vaultBacking}</p>
      <button type="button" disabled={busy} onClick={() => void run(() => sync.syncNow())}>
        Sync now
      </button>

      <h3>Recovery phrase</h3>
      {phrase ? (
        <div className="sync-tab__phrase" role="alert">
          <code className="sync-tab__phrase-words">{phrase}</code>
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
                onClick={() => void run(async () => setDevices(await sync.removeDevice(d.deviceId)))}
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
      <button type="button" disabled={busy} onClick={() => void run(() => sync.disable(forget))}>
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
