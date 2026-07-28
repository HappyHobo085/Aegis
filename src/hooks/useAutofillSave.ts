// src/hooks/useAutofillSave.ts
//
// Subscribes to the `form.willSubmit` event (emitted by vault_inject.js when
// the user submits a login form). When credentials arrive, this hook checks
// whether a matching record already exists in the vault and — if not — stores
// the pending credentials so the UI can offer a "Save password?" prompt.
//
// Security: plaintext credentials live ONLY in the hook's transient state
// while the save dialog is open. They are never written to localStorage,
// sessionStorage, IndexedDB, or the URL. Once the user saves or dismisses,
// the pending state is cleared.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { FormWillSubmit } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

export interface UseAutofillSave {
  /** Credentials awaiting the user's save/dismiss decision (null when idle). */
  pending: FormWillSubmit | null;
  /** Whether a vault record already covers these credentials. */
  alreadySaved: boolean;
  /** Save the pending credentials to the vault. */
  save(): Promise<void>;
  /** Dismiss without saving. */
  dismiss(): void;
}

export function useAutofillSave(): UseAutofillSave {
  const [pending, setPending] = useState<FormWillSubmit | null>(null);
  const [alreadySaved, setAlreadySaved] = useState(false);
  const pendingRef = useRef<FormWillSubmit | null>(null);

  // Check whether the submitted credentials already exist in the vault.
  const checkExisting = useCallback(async (cred: FormWillSubmit) => {
    try {
      const records = await aegis.vault.autofillSuggestions(cred.domain);
      const match = records.some(
        (r) =>
          r.username.toLowerCase() === cred.username.toLowerCase() && r.password === cred.password,
      );
      setAlreadySaved(match);
    } catch {
      // Vault locked or error — treat as "not already saved" so the
      // save dialog still appears (the user can unlock and save).
      setAlreadySaved(false);
    }
  }, []);

  useEffect(() => {
    const off = aegis.form.onWillSubmit((cred: FormWillSubmit) => {
      // If the vault is locked, silently drop — we can't save anyway.
      void aegis.vault.getState().then((st) => {
        if (!st.unlocked) return;
        pendingRef.current = cred;
        setPending(cred);
        void checkExisting(cred);
      });
    });
    return off;
  }, [checkExisting]);

  const save = useCallback(async () => {
    const cred = pendingRef.current;
    if (!cred) return;
    try {
      await aegis.vault.add({
        site: `https://${cred.domain}`,
        username: cred.username,
        password: cred.password,
      });
    } catch {
      // Best-effort — the save dialog closes regardless.
    } finally {
      pendingRef.current = null;
      setPending(null);
      setAlreadySaved(false);
    }
  }, []);

  const dismiss = useCallback(() => {
    pendingRef.current = null;
    setPending(null);
    setAlreadySaved(false);
  }, []);

  return { pending, alreadySaved, save, dismiss };
}
