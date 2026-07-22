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
import { useEffect, useState } from 'react';
import type { VaultRecord, VaultRecordInput } from '../../shared/types';
import type { UseVault } from '../hooks/useVault';
import { confirm, toast } from '../lib/toast';

// Import autofill hooks for future integration
import { useVaultDomainSuggestions } from '../hooks/useVaultDomainSuggestions';

export function VaultSettingsTab({ vault }: { vault: UseVault }) {
  const { state } = vault;

  // Autofill suggestions hook (for future UI integration)
  const { suggestions: autofillSuggestions, loading: autofillLoading, error: autofillError, refetch: refetchAutofill } = useVaultDomainSuggestions();

  // ---- shared async helper ----
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

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

  // Dev/autopilot seam: register the setRecords setter in the vault hook's ref so
  // the autopilot control can seed records directly via flushSync (no async list() call).
  // No-op in production (the ref is never read by non-autopilot code).
  const _setRecordsRef = vault._setRecordsRef;
  useEffect(() => {
    _setRecordsRef.current = setRecords;
    return () => {
      _setRecordsRef.current = null;
    };
  }, [_setRecordsRef]);

  // ---- add-entry form state ----
  const [addSite, setAddSite] = useState('');
  const [addUsername, setAddUsername] = useState('');
  const [addPassword, setAddPassword] = useState('');
  const [addNotes, setAddNotes] = useState('');

  // ---- search state ----
  const [searchQuery, setSearchQuery] = useState('');

  // Load records on mount (or when state transitions to unlocked).
  useEffect(() => {
    if (!state.unlocked) {
      setRecords([]);
      setRevealedUuids(new Set());
      setSearchQuery('');
      return;
    }
    void vault.list().then(setRecords);
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      <div className="vault-tab">
        <h3 id="vault-create-heading">Create vault</h3>
        <p>
          Your passwords are stored encrypted on this device. Aegis can autofill login forms on
          websites. Copy values manually when needed.
        </p>
        <p>
          Choose a master password to protect your vault. You will need it every time you open the
          Passwords tab.
        </p>
        <label className="vault-tab__field">
          <span>Master password</span>
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
        <label className="vault-tab__field">
          <span>Confirm password</span>
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
        <button
          type="button"
          aria-label="Create vault"
          disabled={busy || createPw.length === 0}
          onClick={handleCreate}
        >
          Create vault
        </button>
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
      <div className="vault-tab">
        <h3>Unlock vault</h3>
        <p>
          {state.count} saved password{state.count !== 1 ? 's' : ''}.
        </p>
        <p className="vault-tab__notice">
          Stored encrypted on this device. Aegis can autofill login forms on websites. Copy the
          value when you need it.
        </p>
        <label className="vault-tab__field">
          <span>Master password</span>
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
        <button
          type="button"
          aria-label="Unlock"
          disabled={busy || unlockPw.length === 0}
          onClick={handleUnlock}
        >
          Unlock
        </button>
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
        toast.success('Copied');
      } catch (e) {
        console.error('Clipboard copy failed:', e);
        toast.error('Couldn’t copy');
      }
    })();
  };

  return (
    <div className="vault-tab">
      <div className="vault-tab__header">
        <h3>Passwords</h3>
        <button
          type="button"
          aria-label="Lock vault"
          disabled={busy}
          onClick={() => void run(() => vault.lock())}
        >
          Lock
        </button>
      </div>

      <p className="vault-tab__notice">
        Stored encrypted on this device. Aegis can autofill login forms on websites. Copy the
        value when you need it.
      </p>

      {/* Autofill notice when vault is unlocked */}
      {!autofillLoading && !autofillError && autofillSuggestions.length > 0 && (
        <p className="vault-tab__notice">
          {autofillSuggestions.length} credential{autofillSuggestions.length !== 1 ? 's' : ''} available for
          autofill on the current site.
        </p>
      )}
      {autofillLoading && (
        <p className="vault-tab__notice">
          Checking for autofill credentials...
        </p>
      )}
      {autofillError && (
        <p className="vault-tab__error" role="alert">
          Autofill error: {autofillError}
        </p>
      )}

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

      {/* Search */}
      <label className="vault-tab__field">
        <span>Search</span>
        <input
          type="search"
          role="searchbox"
          aria-label="Search passwords"
          value={searchQuery}
          placeholder="Filter by site or username…"
          onChange={(e) => void handleSearch(e.target.value)}
        />
      </label>

      {/* Records list */}
      {records.length === 0 ? (
        <p className="vault-tab__empty">No saved passwords.</p>
      ) : (
        <ul className="vault-tab__list" aria-label="Saved passwords">
          {records.map((r) => {
            const revealed = revealedUuids.has(r.uuid);
            return (
              <li key={r.uuid} className="vault-tab__row">
                <span className="vault-tab__site" title={r.site}>
                  {r.site}
                </span>
                <span className="vault-tab__username">{r.username}</span>
                <span className="vault-tab__password">{revealed ? r.password : '••••••••'}</span>
                <div className="vault-tab__row-actions">
                  <button
                    type="button"
                    aria-label={`${revealed ? 'Hide' : 'Show'} password for ${r.site}`}
                    onClick={() => toggleReveal(r.uuid)}
                  >
                    {revealed ? 'Hide' : 'Show'}
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy password for ${r.site}`}
                    onClick={() => handleCopy(r.password)}
                  >
                    Copy password
                  </button>
                  <button
                    type="button"
                    aria-label={`Copy username for ${r.site}`}
                    onClick={() => handleCopy(r.username)}
                  >
                    Copy username
                  </button>
                  <button
                    type="button"
                    aria-label={`Delete entry for ${r.site}`}
                    onClick={() => handleDelete(r.uuid)}
                    disabled={busy}
                  >
                    Delete
                  </button>
                </div>
                {r.notes && <p className="vault-tab__notes">{r.notes}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {/* Add entry form */}
      <details className="vault-tab__add">
        <summary>Add entry</summary>
        <div className="vault-tab__add-form">
          <label className="vault-tab__field">
            <span>Site</span>
            <input
              type="url"
              aria-label="Site"
              value={addSite}
              placeholder="https://example.com"
              onChange={(e) => setAddSite(e.target.value)}
            />
          </label>
          <label className="vault-tab__field">
            <span>Username</span>
            <input
              type="text"
              aria-label="Username"
              value={addUsername}
              autoComplete="off"
              onChange={(e) => setAddUsername(e.target.value)}
            />
          </label>
          <label className="vault-tab__field">
            <span>Password</span>
            <input
              type="password"
              aria-label="Password"
              value={addPassword}
              autoComplete="new-password"
              onChange={(e) => setAddPassword(e.target.value)}
            />
          </label>
          <label className="vault-tab__field">
            <span>Notes</span>
            <textarea
              aria-label="Notes"
              value={addNotes}
              onChange={(e) => setAddNotes(e.target.value)}
            />
          </label>
          <button
            type="button"
            aria-label="Add entry"
            disabled={busy || addSite.trim().length === 0 || addPassword.length === 0}
            onClick={handleAdd}
          >
            Add entry
          </button>
        </div>
      </details>
    </div>
  );
}