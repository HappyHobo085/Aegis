// electron/main/ipc/lists.ts
import { IPC } from '../../../shared/types';
import type { ListUpdateResult } from '../../../shared/types';

/**
 * Builds the lists IPC handler map (channel -> handler). updateNow is the boot-
 * supplied canonical refresh (runRefresh()) — a single-fire manual update that
 * returns the per-source result; it never re-enters the 24h scheduler.
 */
export function buildListsHandlers(
  updateNow: () => Promise<ListUpdateResult>,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.listsUpdateNow]: (): Promise<ListUpdateResult> => updateNow(),
  };
}
