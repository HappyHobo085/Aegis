// src/hooks/useSync.ts
import { useCallback, useEffect, useState } from 'react';
import type { SyncState } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { publishSyncChange } from '../lib/syncBus';

const EMPTY: SyncState = {
  enabled: false,
  status: 'disabled',
  serverUrl: '',
  lastSyncMs: 0,
  lastError: '',
  deviceId: '',
  accountId: '',
  vaultBacking: 'none',
};

export interface UseSync {
  state: SyncState;
  /** Start fresh — returns the 24-word recovery phrase ONCE (caller shows then discards). */
  enableNew(passphrase?: string): Promise<string>;
  enableFromPhrase(phrase: string, passphrase?: string): Promise<void>;
  disable(forget?: boolean): Promise<void>;
  syncNow(): Promise<void>;
  getRecoveryPhrase(): Promise<string>;
  listDevices: typeof aegis.sync.listDevices;
  removeDevice: typeof aegis.sync.removeDevice;
}

export function useSync(): UseSync {
  const [state, setState] = useState<SyncState>(EMPTY);

  useEffect(() => {
    let active = true;
    void aegis.sync.getState().then((s) => {
      if (active) setState(s);
    });
    const offState = aegis.sync.onState((s) => setState(s));
    // Relay the engine's targeted change notice to the per-store bus (no full reload).
    const offChanged = aegis.sync.onChanged((c) => publishSyncChange(c.namespace, c.changedUuids));
    return () => {
      active = false;
      offState();
      offChanged();
    };
  }, []);

  // State updates arrive via onState (the engine emits sync.state on every transition);
  // the action results also return the fresh state where the backend provides it.
  const enableNew = useCallback(async (passphrase?: string): Promise<string> => {
    const r = await aegis.sync.enableNew(passphrase ? { passphrase } : undefined);
    return r.recoveryPhrase;
  }, []);

  const enableFromPhrase = useCallback(async (phrase: string, passphrase?: string): Promise<void> => {
    setState(await aegis.sync.enableFromPhrase({ phrase, passphrase }));
  }, []);

  const disable = useCallback(async (forget?: boolean): Promise<void> => {
    setState(await aegis.sync.disable({ forget }));
  }, []);

  const syncNow = useCallback(async (): Promise<void> => {
    setState(await aegis.sync.syncNow());
  }, []);

  const getRecoveryPhrase = useCallback(async (): Promise<string> => {
    const r = await aegis.sync.getRecoveryPhrase({ confirm: true });
    return r.recoveryPhrase;
  }, []);

  const listDevices = useCallback(() => aegis.sync.listDevices(), []);
  const removeDevice = useCallback((id: string) => aegis.sync.removeDevice(id), []);

  return {
    state,
    enableNew,
    enableFromPhrase,
    disable,
    syncNow,
    getRecoveryPhrase,
    listDevices,
    removeDevice,
  };
}
