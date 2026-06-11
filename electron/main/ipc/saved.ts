// electron/main/ipc/saved.ts
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import type { SavedRepo } from '../db/savedRepo';

/**
 * Builds the saved-list IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). add/remove/update/tag-ops
 * return the updated SavedItem[] (tagUnion returns the distinct sorted tag set);
 * has(url) backs the toolbar bookmark fill-in.
 */
export function buildSavedHandlers(
  repo: SavedRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.savedList]: (): SavedItem[] => repo.list(),
    [IPC.savedAdd]: (input: { url: string; title: string; tags?: string[] }): SavedItem[] =>
      repo.add(input),
    [IPC.savedRemove]: (id: number): SavedItem[] => repo.remove(id),
    [IPC.savedHas]: (url: string): boolean => repo.has(url),
    [IPC.savedUpdate]: (id: number, partial: { title?: string; tags?: string[] }): SavedItem[] =>
      repo.update(id, partial),
    [IPC.savedRenameTag]: (oldT: string, newT: string): SavedItem[] => repo.renameTag(oldT, newT),
    [IPC.savedDeleteTag]: (tag: string): SavedItem[] => repo.deleteTag(tag),
    [IPC.savedTagUnion]: (): string[] => repo.tagUnion(),
  };
}
