// electron/main/ipc/adblock.ts
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import type { AdblockController } from '../adblock/controller';

/**
 * Builds the adblock IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). All mutators return the new
 * AdblockState so the renderer syncs from the result. removeAllowlist/clearAllowlist
 * mutate the persisted allowlist only; re-blocking is deferred to the next-nav
 * reconcile (contract §2.3) — no direct session reconcile here.
 */
export function buildAdblockHandlers(
  c: AdblockController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.adblockSetEnabled]: (enabled: boolean): AdblockState => c.setEnabled(enabled),
    [IPC.adblockToggleAllowlist]: (host: string): AdblockState => c.toggleAllowlist(host),
    [IPC.adblockGetState]: (): AdblockState => c.getState(),
    [IPC.adblockRemoveAllowlist]: (host: string): AdblockState => c.removeAllowlist(host),
    [IPC.adblockClearAllowlist]: (): AdblockState => c.clearAllowlist(),
  };
}
