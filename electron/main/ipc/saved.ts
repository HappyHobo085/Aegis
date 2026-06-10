// electron/main/ipc/saved.ts
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import type { SavedRepo } from '../db/savedRepo';

/**
 * Builds the saved-list IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). add/remove return the updated
 * SavedItem[]; has(url) backs the toolbar bookmark fill-in.
 */
export function buildSavedHandlers(
  repo: SavedRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.savedList]: (): SavedItem[] => repo.list(),
    [IPC.savedAdd]: (input: { url: string; title: string }): SavedItem[] => repo.add(input),
    [IPC.savedRemove]: (id: number): SavedItem[] => repo.remove(id),
    [IPC.savedHas]: (url: string): boolean => repo.has(url),
  };
}
