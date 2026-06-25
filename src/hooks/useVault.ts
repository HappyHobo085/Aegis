// src/hooks/useVault.ts
//
// Hook for the password-vault feature (Phase A — manage only, NO autofill).
// Mirrors useSync.ts: seeds from getState on mount, subscribes to onState for
// live status updates, and proxies every action to the ipcClient's vault namespace.
//
// Security:
// - Decrypted records are NEVER held in React state — all list/add/update/remove/search
//   calls return the list directly from the IPC call without storing it here.
// - Nothing from the vault is written to localStorage, sessionStorage, IndexedDB,
//   cookies, or the URL.
// - No credential values are logged.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import type { VaultState, VaultRecord, VaultRecordInput } from '../../shared/types';
import { aegis } from '../lib/ipcClient';

const EMPTY: VaultState = { exists: false, unlocked: false, count: 0, undecryptable: 0 };

export interface UseVault {
  state: VaultState;
  create(masterPassword: string): Promise<void>;
  unlock(masterPassword: string): Promise<void>;
  lock(): Promise<void>;
  list(): Promise<VaultRecord[]>;
  add(input: VaultRecordInput): Promise<VaultRecord[]>;
  update(uuid: string, partial: Partial<VaultRecordInput>): Promise<VaultRecord[]>;
  remove(uuid: string): Promise<VaultRecord[]>;
  search(q: string): Promise<VaultRecord[]>;
  /**
   * Dev/autopilot seam: a ref that VaultSettingsTab writes its `setRecords` setter
   * into on mount.  Autopilot interaction specs can call this directly to seed the
   * displayed records list without going through the async vault.list() path.
   * Never written to or read by production code paths.
   */
  _setRecordsRef: React.MutableRefObject<Dispatch<SetStateAction<VaultRecord[]>> | null>;
}

export function useVault(): UseVault {
  const [state, setState] = useState<VaultState>(EMPTY);
  const _setRecordsRef = useRef<Dispatch<SetStateAction<VaultRecord[]>> | null>(null);

  useEffect(() => {
    let active = true;
    void aegis.vault.getState().then((s) => {
      if (active) setState(s);
    });
    const off = aegis.vault.onState((s) => setState(s));
    return () => {
      active = false;
      off();
    };
  }, []);

  const create = useCallback(async (pw: string) => {
    setState(await aegis.vault.create(pw));
  }, []);

  const unlock = useCallback(async (pw: string) => {
    setState(await aegis.vault.unlock(pw));
  }, []);

  const lock = useCallback(async () => {
    setState(await aegis.vault.lock());
  }, []);

  const list = useCallback(() => aegis.vault.list(), []);

  const add = useCallback((i: VaultRecordInput) => aegis.vault.add(i), []);

  const update = useCallback(
    (u: string, p: Partial<VaultRecordInput>) => aegis.vault.update(u, p),
    [],
  );

  const remove = useCallback((u: string) => aegis.vault.remove(u), []);

  const search = useCallback((q: string) => aegis.vault.search(q), []);

  return { state, create, unlock, lock, list, add, update, remove, search, _setRecordsRef };
}
