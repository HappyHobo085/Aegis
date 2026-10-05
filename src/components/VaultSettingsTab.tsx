// src/components/VaultSettingsTab.tsx
//
// The "Passwords" settings tab — Phase A+B password vault (credential manager
// with autofill). Mirrors SyncSettingsTab.tsx's three-state structure + run/busy/error
// helper pattern.
//
// Security:
// - Master-password inputs are always type="password".
// - New-entry password input is always type="password".
// - Decrypted record passwords are masked by default; revealed only on demand per row.
// - Nothing is written to localStorage / sessionStorage / IndexedDB / the URL.
// - No credential values are logged.
import { useEffect, useRef, useState } from 'react';
import type { VaultRecord, VaultRecordInput } from '../../shared/types';
import type { UseVault } from '../hooks/useVault';
import { confirm, toast } from '../lib/toast';

export function VaultSettingsTab({ vault }: { vault: UseVault }) {
  const { state } = vault;

  // ---- shared async helper ----
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const CLIPBOARD_CLEAR_MS = 60_000;
  // BUG(F6): the clear-timer handle was never stored, so a second Copy could not cancel the
  // first. Copying two secrets in quick succession meant the FIRST timer wiped the SECOND
  // secret off the clipboard right after the UI had promised it would survive for 60s; and
  // closing Settings left the timer running, so it blanked whatever the user had copied
  // since. One handle, always the newest timer, cleared on unmount.
  const clipboardClearRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // `handleCopy` awaits the clipboard write before arming the timer, so a copy whose write
  // resolves after the tab closed would leave a timer with no owner. Track liveness so the
  // timer is disarmed instead of stranding a stray 60s wipe.
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (clipboardClearRef.current !== null) {
        clearTimeout(clipboardClearRef.current);
        clipboardClearRef.current = null;
      }
    };
  }, []);

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

  // ---- create-vault form state ----
  const [createPw, setCreatePw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [createMismatch, setCreateMismatch] = useState(false);

  // ---- unlock form state ----
  const [unlockPw, setUnlockPw] = useState('');
  const [wrongPassword, setWrongPassword] = useState(false);

  // ---- records list state ----
  const [records, setRecords] = useState<VaultRecord[]>([]);
  const [revealedUuids, setRevealedUuids] = useState<Set<string>>(new Set());

  // ---- add-entry form state ----
  const [addSite, setAddSite] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addNotes, setAddNotes] = useState('');

  // ---- search state ----
  const [searchQuery, setSearchQuery] = useState('');

  // Use a ref for vault to avoid stale closures while keeping stable deps
  const vaultRef = useRef(vault);
  vaultRef.current = vault;

  // Load records on mount (or when state transitions to unlocked).
  useEffect(() => {
    if (!state.unlocked) {
      setRecords([]);
      setRevealedUuids(new Set());
      setSearchQuery('');
      return;
    }
    void vaultRef.current.list().then(setRecords);
  }, [state.unlocked]);

  const refreshList = async () => {
    const q = searchQuery.trim();
    const updated = q ? await vault.search(q) : await vault.list();
    setRecords(updated);
  };

  // ---------------------------------------------------------------------------
  // STATE 1 — no vault yet
  // ---------------------------------------------------------------------------
  if (!state.exists) {
    const handleCreate = () => {
      if (createPw !== confirmPw) {
        setCreateMismatch(true);
        return;
      }
      setCreateMismatch(false);
      void run(async () => {
        await vault.create(createPw);
        setCreatePw('');
        setConfirmPw('');
      });
    };

    return (
      <div className="settings-panel vault-tab">
        <section className="settings-section" aria-label="Create vault">
          <h3 id="vault-create-heading" className="settings-section__title">
            Create vault
          </h3>
          <p className="settings-hint">
            Your passwords are stored encrypted on this device. Aegis can autofill login forms on
            websites. Copy values manually when needed.
          </p>
          <p className="settings-hint">
            Choose a master password to protect your vault. You will need it every time you open the
            Passwords tab.
          </p>
          <label className="settings-row">
            <span className="settings-row__label">Master password</span>
            <input
              type="password"
              aria-label="Master password"
              value={createPw}
              autoComplete="new-password"
              onChange={(e) => {
                setCreatePw(e.target.value);
                setCreateMismatch(false);
              }}
            />
          </label>
          <label className="settings-row">
            <span className="settings-row__label">Confirm password</span>
            <input
              type="password"
              aria-label="Confirm password"
              value={confirmPw}
              autoComplete="new-password"
              onChange={(e) => {
                setConfirmPw(e.target.value);
                setCreateMismatch(false);
              }}
            />
          </label>
          {createMismatch && (
            <p className="vault-tab__error" role="alert">
              Passwords do not match.
            </p>
          )}
          {error && (
            <p className="vault-tab__error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              aria-label="Create vault"
              disabled={busy || createPw.length === 0}
              onClick={handleCreate}
            >
              Create vault
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // STATE 2 — vault exists but is locked
  // ---------------------------------------------------------------------------
  if (!state.unlocked) {
    const handleUnlock = () => {
      setWrongPassword(false);
      void run(async () => {
        try {
          await vault.unlock(unlockPw);
          setUnlockPw('');
          // list() is called by the unlocked useEffect once state.unlocked flips
          // but also call it immediately in case the parent drives state externally
          const loaded = await vault.list();
          setRecords(loaded);
        } catch (e) {
          setWrongPassword(true);
          // re-throw so run() captures it in its error state too
          throw e;
        }
      });
    };

    return (
      <div className="settings-panel vault-tab">
        <section className="settings-section" aria-label="Unlock vault">
          <h3 className="settings-section__title">Unlock vault</h3>
          <p className="settings-hint">
            {state.count} saved password{state.count !== 1 ? 's' : ''}.
          </p>
          <p className="settings-hint">
            Stored encrypted on this device. Aegis does not fill login forms for you yet &mdash;
            copying is the only way to use a saved password.
          </p>
          <label className="settings-row">
            <span className="settings-row__label">Master password</span>
            <input
              type="password"
              aria-label="Master password"
              value={unlockPw}
              autoComplete="current-password"
              onChange={(e) => {
                setUnlockPw(e.target.value);
                setWrongPassword(false);
              }}
            />
          </label>
          {wrongPassword && (
            <p className="vault-tab__error" role="alert">
              Wrong password. Please try again.
            </p>
          )}
          {error && !wrongPassword && (
            <p className="vault-tab__error" role="alert">
              {error}
            </p>
          )}
          <div className="settings-actions">
            <button
              type="button"
              className="settings-btn settings-btn--primary"
              aria-label="Unlock"
              disabled={busy || unlockPw.length === 0}
              onClick={handleUnlock}
            >
              Unlock
            </button>
          </div>
        </section>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // STATE 3 — unlocked
  // ---------------------------------------------------------------------------
  const toggleReveal = (uuid: string) => {
    setRevealedUuids((prev) => {
      const next = new Set(prev);
      if (next.has(uuid)) {
        next.delete(uuid);
      } else {
        next.add(uuid);
      }
      return next;
    });
  };

  const handleSearch = async (q: string) => {
    setSearchQuery(q);
    if (q.trim() === '') {
      const all = await vault.list();
      setRecords(all);
    } else {
      const results = await vault.search(q);
      setRecords(results);
    }
  };

  const handleAdd = () => {
    void run(async () => {
      const input: VaultRecordInput = {
        site: addSite.trim(),
        username: addUsername.trim(),
        password: addPassword,
        notes: addNotes.trim(),
      };
      await vault.add(input);
      setAddSite('');
      setAddUsername('');
      setAddPassword('');
      setAddNotes('');
      await refreshList();
    });
  };

  const handleDelete = (uuid: string) => {
    void (async () => {
      if (
        !(await confirm('Delete this saved password? This can’t be undone.', { destructive: true }))
      )
        return;
      void run(async () => {
        await vault.remove(uuid);
        await refreshList();
      });
    })();
  };

  const handleCopy = (text: string) => {
    void (async () => {
      try {
        await navigator.clipboard.writeText(text);
        toast.success('Copied — clipboard clears in 60s');
        if (clipboardClearRef.current !== null) clearTimeout(clipboardClearRef.current);
        // Clear clipboard after delay to avoid leaving passwords exposed
        clipboardClearRef.current = setTimeout(() => {
          clipboardClearRef.current = null;
          void navigator.clipboard.writeText('').catch(() => {
            // Best-effort: clipboard may have been overwritten by user
          });
        }, CLIPBOARD_CLEAR_MS);
        if (!mountedRef.current) {
          clearTimeout(clipboardClearRef.current);
          clipboardClearRef.current = null;
        }
      } catch (e) {
        console.error('Clipboard copy failed:', e);
        toast.error('Couldn\u0027t copy');
      }
    })();
  };

  return (
    <div className="settings-panel vault-tab">
      <section className="settings-section" aria-label="Vault status">
        <div className="settings-row settings-row--between">
          <h3 className="settings-section__title">Passwords</h3>
          <div className="settings-actions">
            <button
              type="button"
              className="settings-btn settings-btn--quiet"
              aria-label="Lock vault"
              disabled={busy}
              onClick={() => void run(() => vault.lock())}
            >
              Lock
            </button>
          </div>
        </div>

        <p className="settings-hint">
          Stored encrypted on this device. Copy the value when you need it. Aegis does not fill
          login forms for you yet &mdash; copying is the only way to use a saved password.
        </p>

        {/* Sync status indicator */}
        <div className="vault-tab__sync" aria-label="Vault sync status">
          <span
            className={`vault-tab__sync-dot ${state.syncEnabled ? 'vault-tab__sync-dot--on' : 'vault-tab__sync-dot--off'}`}
            aria-hidden="true"
          />
          {state.syncEnabled
            ? 'Synced across your devices via E2E encryption'
            : 'Sync is not enabled — passwords stay on this device'}
        </div>

        {state.undecryptable > 0 && (
          <p className="vault-tab__warning" role="alert">
            {state.undecryptable} saved password{state.undecryptable !== 1 ? 's' : ''} could not be
            decrypted and {state.undecryptable !== 1 ? 'are' : 'is'} hidden. They are kept on disk
            (not deleted) &mdash; this can happen if the vault file was damaged. Restore a backup if
            you have one.
          </p>
        )}

        {error && (
          <p className="vault-tab__error" role="alert">
            {error}
          </p>
        )}
      </section>

      <section className="settings-section" aria-label="Saved passwords">
        <h3 className="settings-section__title">Saved passwords</h3>

        {/* Search */}
        <label className="settings-row">
          <span className="settings-row__label">Search</span>
          <input
            type="search"
            role="searchbox"
            aria-label="Search passwords"
            value={searchQuery}
            placeholder="Filter by site or username…"
            onChange={(e) => void handleSearch(e.target.value)}
          />
        </label>

        {records.length === 0 ? (
          <p className="settings-hint">No saved passwords.</p>
        ) : (
          <ul className="settings-list" aria-label="Saved passwords">
            {records.map((r) => {
              const revealed = revealedUuids.has(r.uuid);
              return (
                <li key={r.uuid} className="settings-list__row vault-row">
                  {/* The site and username stack: a record row has to carry FOUR actions
                      (show, copy password, copy username, delete), so at this panel width a
                      single horizontal line wraps the actions onto a second row anyway.
                      Stacking the identity above them keeps the actions on one tidy line. */}
                  <div className="vault-row__identity">
                    <span className="vault-row__site" title={r.site}>
                      {r.site}
                    </span>
                    <span className="vault-row__username">{r.username}</span>
                  </div>
                  <span className="vault-row__password" data-revealed={revealed}>
                    {revealed ? r.password : '••••••••'}
                  </span>
                  <div className="settings-actions vault-row__actions">
                    <button
                      type="button"
                      className="settings-btn settings-btn--quiet"
                      aria-label={`${revealed ? 'Hide' : 'Show'} password for ${r.site}`}
                      onClick={() => toggleReveal(r.uuid)}
                    >
                      {revealed ? 'Hide' : 'Show'}
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn--quiet"
                      aria-label={`Copy password for ${r.site}`}
                      onClick={() => handleCopy(r.password)}
                    >
                      Copy password
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn--quiet"
                      aria-label={`Copy username for ${r.site}`}
                      onClick={() => handleCopy(r.username)}
                    >
                      Copy username
                    </button>
                    <button
                      type="button"
                      className="settings-btn settings-btn--quiet"
                      aria-label={`Delete entry for ${r.site}`}
                      onClick={() => handleDelete(r.uuid)}
                      disabled={busy}
                    >
                      Delete
                    </button>
                  </div>
                  {r.notes && <p className="vault-row__notes">{r.notes}</p>}
                </li>
              );
            })}
          </ul>
        )}

        {/* Add entry form */}
        <details className="vault-tab__add">
          <summary>Add entry</summary>
          <div className="settings-row vault-tab__add-form">
            <label className="settings-row">
              <span className="settings-row__label">Site</span>
              <input
                type="url"
                aria-label="Site"
                value={addSite}
                placeholder="https://example.com"
                onChange={(e) => setAddSite(e.target.value)}
              />
            </label>
            <label className="settings-row">
              <span className="settings-row__label">Username</span>
              <input
                type="text"
                aria-label="Username"
                value={addUsername}
                autoComplete="off"
                onChange={(e) => setAddUsername(e.target.value)}
              />
            </label>
            <label className="settings-row">
              <span className="settings-row__label">Password</span>
              <input
                type="password"
                aria-label="Password"
                value={addPassword}
                autoComplete="new-password"
                onChange={(e) => setAddPassword(e.target.value)}
              />
            </label>
            <label className="settings-row">
              <span className="settings-row__label">Notes</span>
              <textarea
                aria-label="Notes"
                value={addNotes}
                onChange={(e) => setAddNotes(e.target.value)}
              />
            </label>
            <div className="settings-actions">
              <button
                type="button"
                className="settings-btn settings-btn--primary"
                aria-label="Add entry"
                disabled={busy || addSite.trim().length === 0 || addPassword.length === 0}
                onClick={handleAdd}
              >
                Add entry
              </button>
            </div>
          </div>
        </details>
      </section>
    </div>
  );
}

export default VaultSettingsTab;
