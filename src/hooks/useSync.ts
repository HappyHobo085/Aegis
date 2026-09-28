// src/hooks/useSync.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { SyncState, SyncVaultQuarantined } from '../../shared/types';
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
  hasStoredRoot: false,
};

export interface UseSync {
  state: SyncState;
  /** Start fresh — returns the 24-word recovery phrase ONCE (caller shows then discards). */
  enableNew(passphrase?: string): Promise<string>;
  enableFromPhrase(phrase: string, passphrase?: string): Promise<void>;
  unlock(passphrase: string): Promise<void>;
  disable(forget?: boolean): Promise<void>;
  syncNow(): Promise<void>;
  testConnection: (url: string) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  /**
   * Reveal the 24-word recovery phrase. `confirmed` MUST be the result of a real user
   * confirmation — the core refuses the channel without `confirm: true`, and hardcoding that
   * flag here would turn the gate into a bypass.
   */
  getRecoveryPhrase(confirmed: boolean): Promise<string>;
  /**
   * The most recent rejected-write report — a peer tried to write to the vault and the record
   * was quarantined — or `null` when there is nothing to report. The Sync tab renders this and
   * nothing else should.
   */
  quarantined: SyncVaultQuarantined | null;
  listDevices: typeof aegis.sync.listDevices;
  removeDevice: typeof aegis.sync.removeDevice;
}

export function useSync(): UseSync {
  const [state, setState] = useState<SyncState>(EMPTY);
  // Kept OUT of `SyncState` on purpose: that is the CORE's own view of the sync engine, and the
  // quarantine list is not part of it — it is a peer-supplied fact the renderer observed.
  // Folding it into `SyncState` would make a renderer-observed value look like core state, and
  // the core's own `sync.getState` reply would then be missing a field the type promises.
  const [quarantined, setQuarantined] = useState<SyncVaultQuarantined | null>(null);

  // Monotonic sequence for the mutating actions below. Every action takes a ticket BEFORE its
  // await and only writes state if its ticket is still the newest. Without it the actions were
  // plain last-resolved-wins, so a slow `unlock` that resolved after a fast `disable` left the
  // UI advertising a sync state the core had already left.
  const seqRef = useRef(0);
  const nextTicket = (): number => ++seqRef.current;
  const isCurrent = (ticket: number): boolean => ticket === seqRef.current;

  useEffect(() => {
    let active = true;
    // BUG(F2): subscribe BEFORE the seed fetch. `sync.onState` registers its backend listener
    // only when the `listen` IPC is processed, so a `sync.state` transition emitted while the
    // `sync.getState` round-trip was still queued was lost with nothing to refetch it. That is
    // what could strand the UI in the setup view right after `enableNew`.
    const offState = aegis.sync.onState((s) => setState(s));
    // Relay the engine's targeted change notice to the per-store bus (no full reload).
    const offChanged = aegis.sync.onChanged((c) => publishSyncChange(c.namespace, c.changedUuids));
    void aegis.sync.getState().then((s) => {
      if (active) setState(s);
    });
    // A peer that pushes a forged or wrong-keyed vault record has it quarantined: never
    // written, never merged, the local record of that uuid untouched. The core emits that as an
    // EVENT and deliberately does NOT fail the pass — a rejected forgery is a security outcome,
    // not a sync error, so failing the pass would have mislabelled it and reported the user's
    // other namespaces as failed too. That makes this event the ONLY channel by which the user
    // can learn somebody tried to write to their vault, and nothing in the renderer subscribed
    // to it, so the report went nowhere. (Found by `shared/ipcCatalog.drift.test.ts`'s
    // direction 3, which had been blind because the transport satisfied its own search.)
    //
    // An empty payload clears the report rather than being ignored: a security warning that can
    // only be dismissed by restarting the app is a warning users learn to ignore.
    const offQuarantine = aegis.sync.onVaultQuarantined((q) => {
      if (active) setQuarantined(q.count > 0 ? q : null);
    });
    return () => {
      active = false;
      offState();
      offChanged();
      offQuarantine();
    };
  }, []);

  // State updates arrive via onState (the engine emits sync.state on every transition);
  // the action results also return the fresh state where the backend provides it.
  const enableNew = useCallback(async (passphrase?: string): Promise<string> => {
    const ticket = nextTicket();
    const r = await aegis.sync.enableNew(passphrase ? { passphrase } : undefined);
    // `enableNew` returns ONLY the recovery phrase, so there is no state to adopt from the
    // action result — the UI used to depend entirely on the `sync.state` event and could be
    // stranded in the setup view with no in-app recovery if that event was missed. Re-seed
    // from the core so the transition is guaranteed (and still guarded).
    const next = await aegis.sync.getState();
    if (isCurrent(ticket)) setState(next);
    return r.recoveryPhrase;
  }, []);

  const enableFromPhrase = useCallback(
    async (phrase: string, passphrase?: string): Promise<void> => {
      const ticket = nextTicket();
      const next = await aegis.sync.enableFromPhrase({ phrase, passphrase });
      if (isCurrent(ticket)) setState(next);
    },
    [],
  );

  const unlock = useCallback(async (passphrase: string): Promise<void> => {
    const ticket = nextTicket();
    const next = await aegis.sync.unlock({ passphrase });
    if (isCurrent(ticket)) setState(next);
  }, []);

  const disable = useCallback(async (forget?: boolean): Promise<void> => {
    const ticket = nextTicket();
    const next = await aegis.sync.disable({ forget });
    if (isCurrent(ticket)) setState(next);
  }, []);

  const syncNow = useCallback(async (): Promise<void> => {
    const ticket = nextTicket();
    const next = await aegis.sync.syncNow();
    if (isCurrent(ticket)) setState(next);
  }, []);

  const testConnection = useCallback((url: string) => aegis.sync.testConnection(url), []);

  const getRecoveryPhrase = useCallback(async (confirmed: boolean): Promise<string> => {
    // The channel is the highest-sensitivity one in the app and the core rejects it outright
    // unless `confirm: true`. That flag used to be HARDCODED here, which made the "gated on an
    // explicit confirm" contract a bypass: the gate has to be the user's own action, so the
    // caller must pass the confirmation through.
    if (!confirmed) throw new Error('Showing the recovery phrase needs an explicit confirmation');
    const r = await aegis.sync.getRecoveryPhrase({ confirm: true });
    return r.recoveryPhrase;
  }, []);

  const listDevices = useCallback(() => aegis.sync.listDevices(), []);
  const removeDevice = useCallback((id: string) => aegis.sync.removeDevice(id), []);

  return {
    state,
    quarantined,
    enableNew,
    enableFromPhrase,
    unlock,
    disable,
    syncNow,
    testConnection,
    getRecoveryPhrase,
    listDevices,
    removeDevice,
  };
}
