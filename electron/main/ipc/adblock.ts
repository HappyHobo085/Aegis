// electron/main/ipc/adblock.ts
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import type { AdblockController } from '../adblock/controller';

/**
 * Builds the adblock IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). setEnabled/toggleAllowlist
 * return the new AdblockState so the renderer syncs from the result.
 */
export function buildAdblockHandlers(
  c: AdblockController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.adblockSetEnabled]: (enabled: boolean): AdblockState => c.setEnabled(enabled),
    [IPC.adblockToggleAllowlist]: (host: string): AdblockState => c.toggleAllowlist(host),
    [IPC.adblockGetState]: (): AdblockState => c.getState(),
  };
}
