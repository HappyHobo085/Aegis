// src/components/SyncSettingsTab.tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Settings, SyncDevice, SyncState, VaultState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
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

/** True for a host that is genuinely loopback. Mirrors the Rust check in
 * `sync::validated_base` — used only to decide what to warn about, never to gate a
 * request (the core is the single enforcement point). */
function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1') return true;
  // 127.0.0.0/8 is all loopback.
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (!m) return false;
  const octets = [m[1], m[2], m[3], m[4]].map(Number);
  return octets.every((o) => o <= 255) && octets[0] === 127;
}

/** True when the URL is a plaintext `http://` server that is NOT loopback — i.e. exactly
 * the case the core refuses unless the user waives it. Drives the warning copy; the
 * `URL` parser (not string splitting) means `http://localhost.evil.com` is correctly
 * classified as remote, matching the Rust side. */
export function isInsecureRemoteUrl(url: string): boolean {
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return false; // unparseable / not yet typed — nothing to warn about
  }
  return u.protocol === 'http:' && !isLoopbackHost(u.hostname);
}

/** The sync transport's TLS posture for the configured server, in one place so the setup
 * view and the running view never disagree. */
function transportLabel(url: string): string {
  if (!url.trim()) return 'No server configured yet';
  let u: URL;
  try {
    u = new URL(url.trim());
  } catch {
    return 'Not a valid URL yet';
  }
  if (u.protocol === 'https:') return 'Encrypted (https)';
  if (isLoopbackHost(u.hostname)) return 'Unencrypted, but local to this machine';
  return 'Unencrypted over the internet';
}

/** The transport-security section: the current posture, the risk spelled out, and the
 * opt-in waiver. Rendered in BOTH the setup view and the running view — the setup view is
 * where a user is about to enter an `http://` URL, and the running view is the only place
 * they can turn the waiver back off once it is in force. */
function TransportSection({
  url,
  allowInsecure,
  onToggle,
}: {
  url: string;
  allowInsecure: boolean;
  onToggle: (on: boolean) => void;
}) {
  const insecure = isInsecureRemoteUrl(url);
  return (
    <div className="sync-tab__transport">
      <h3>Transport security</h3>
      <p className="sync-tab__status">This connection is {transportLabel(url)}.</p>
      {insecure && (
        <p className="sync-tab__error" role="alert">
          {allowInsecure
            ? 'Sync traffic is unencrypted on the way to this server. Anyone on the network path can see which server you sync with and when, and can delay, drop or replay traffic. Your synced data itself stays end-to-end encrypted.'
            : 'This server is unencrypted and not on this machine, so nothing has been sent to it. Tick the box below to allow it anyway.'}
        </p>
      )}
      <label className="sync-tab__check">
        <input
          type="checkbox"
          checked={allowInsecure}
          onChange={(e) => onToggle(e.target.checked)}
        />
        Allow an unencrypted HTTP sync server (insecure)
      </label>
      <p className="sync-tab__hint">
        Off by default. Your bookmarks, history and settings stay end-to-end encrypted either way
        &mdash; this only waives encryption of the connection to the server, so its address, timing
        and traffic volume are visible, and it can be blocked or replayed. This choice applies to
        this device only; it is never synced to your other devices.
      </p>
    </div>
  );
}

export function SyncSettingsTab({
  sync,
  onSetServerUrl,
  settings,
  update,
}: {
  sync: UseSync;
  onSetServerUrl: (url: string) => void | Promise<void>;
  settings: Settings;
  update: (patch: Partial<Settings>) => void;
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
  // The vault's own view of whether it is actually syncing — the opt-in flag alone is not
  // enough (the vault must also have adopted the account's shared salt), so the UI reports
  // what the core thinks rather than echoing the checkbox back at the user.
  const [vaultState, setVaultState] = useState<VaultState | null>(null);

  // The core's `state_json` is the source of truth for the waiver (it is what the sync
  // requests are actually validated against); the settings value is the fallback for a
  // stale/mocked state so the checkbox still reflects the last write immediately.
  const allowInsecure = state.allowInsecure ?? settings.syncAllowInsecure === true;
  const setAllowInsecure = (on: boolean) => {
    update({ syncAllowInsecure: on });
    if (on) toast.info('Sync traffic to this server will not be encrypted.');
  };

  const refreshVaultState = useCallback(() => {
    void aegis.vault
      .getState()
      .then(setVaultState)
      .catch(() => setVaultState(null));
  }, []);

  useEffect(() => {
    refreshVaultState();
  }, [refreshVaultState]);

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

        <TransportSection
          url={serverUrl}
          allowInsecure={allowInsecure}
          onToggle={setAllowInsecure}
        />

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
      {/*
        A rejected vault write is the ONLY signal the user gets that a peer tried to write to
        their vault and the core refused it: the record is quarantined rather than merged, and
        the sync pass itself still SUCCEEDS, because a forged record is a security outcome and
        not a sync failure. So it is reported here as its own alert rather than folded into
        `state.lastError` — folding it in would make a successful pass look like a failed one.
        `role="alert"` so a screen reader announces it; the count is pluralised so "1 record" is
        not copy-pasted into "1 records".
      */}
      {sync.quarantined && (
        <p className="sync-tab__error" role="alert">
          {sync.quarantined.count === 1
            ? 'A password record from another device failed its integrity check and was rejected. Nothing was changed.'
            : `${sync.quarantined.count} password records from another device failed their integrity check and were rejected. Nothing was changed.`}{' '}
          If you did not just add those records on another device, someone may have tried to change
          your vault — your existing passwords are unaffected.
        </p>
      )}
      <button type="button" disabled={busy} onClick={() => void run(() => sync.syncNow())}>
        Sync now
      </button>

      <TransportSection
        url={state.serverUrl}
        allowInsecure={allowInsecure}
        onToggle={setAllowInsecure}
      />

      <h3>Password vault</h3>
      <p>
        Off by default. When on, your password vault syncs too &mdash; still end&#8209;to&#8209;end
        encrypted, and readable on your other devices only with the same master password. A device
        holding just the recovery phrase can neither read these records nor write new ones.
      </p>
      <label className="sync-tab__check">
        <input
          type="checkbox"
          checked={settings.syncVault === true}
          onChange={(e) => {
            const on = e.target.checked;
            update({ syncVault: on });
            if (on) toast.info('Unlocking the vault will join it to this account.');
            refreshVaultState();
          }}
        />
        Sync my password vault
      </label>
      {settings.syncVault === true && vaultState && !vaultState.syncEnabled && (
        <p className="sync-tab__hint">
          Not syncing yet. The vault joins this account the next time you unlock it &mdash; its
          records are re-encrypted under a key every paired device can derive.
          {vaultState.undecryptable > 0 &&
            ` This vault has ${vaultState.undecryptable} undecryptable record(s), so joining is held back rather than dropping them.`}
        </p>
      )}

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
          onClick={() =>
            // The core refuses `sync.getRecoveryPhrase` unless `confirm: true`, and the hook
            // no longer hardcodes that flag — so the user has to actually say yes. This is
            // the highest-sensitivity value in the app; a single click that silently reveals
            // 24 words is not a confirmation.
            void (async () => {
              if (
                await confirm(
                  'Show your recovery phrase? Anyone who sees it can restore — and read — every item synced to this account. Make sure nobody can see your screen.',
                )
              ) {
                void run(async () => setPhrase(await syncRef.current.getRecoveryPhrase(true)));
              }
            })()
          }
        >
          Show recovery phrase
        </button>
      )}

      <h3>Devices</h3>
      <p>
        Restoring from your phrase adds a new device entry each time &mdash; remove any you no
        longer use. Removing one is permanent: it is revoked on the server and cannot sync again,
        even with your recovery phrase.
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
                        `Remove “${d.label}” from your synced devices? This revokes it permanently — ` +
                          `it cannot sync again, even with your recovery phrase.`,
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
