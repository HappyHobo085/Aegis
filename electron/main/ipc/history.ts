// electron/main/ipc/history.ts
import { IPC } from '../../../shared/types';
import type { HistoryEntry } from '../../../shared/types';
import type { HistoryRepo } from '../db/historyRepo';

/**
 * Builds the history IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Recording happens main-side
 * via HistoryRecorder; these handlers are read/mutate only (list/search/remove/clear).
 */
export function buildHistoryHandlers(
  repo: HistoryRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.historyList]: (opts?: { limit?: number; offset?: number }): HistoryEntry[] =>
      repo.list(opts),
    [IPC.historySearch]: (q: string): HistoryEntry[] => repo.search(q),
    [IPC.historyRemove]: (id: number): void => repo.remove(id),
    [IPC.historyClear]: (): void => repo.clear(),
  };
}
