// electron/main/ipc/favorites.ts
import { IPC } from '../../../shared/types';
import type { Favorite } from '../../../shared/types';
import type { FavoritesRepo } from '../db/favoritesRepo';

/**
 * Builds the favorites IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). Every mutation returns the
 * updated Favorite[] (tagUnion returns the distinct sorted tag set) so the renderer
 * syncs from the result.
 */
export function buildFavoritesHandlers(
  repo: FavoritesRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.favoritesList]: (): Favorite[] => repo.list(),
    [IPC.favoritesAdd]: (input: { name: string; url: string; tags: string[] }): Favorite[] =>
      repo.add(input),
    [IPC.favoritesUpdate]: (
      id: number,
      partial: { name?: string; url?: string; tags?: string[] },
    ): Favorite[] => repo.update(id, partial),
    [IPC.favoritesRemove]: (id: number): Favorite[] => repo.remove(id),
    [IPC.favoritesReorder]: (ids: number[]): Favorite[] => repo.reorder(ids),
    [IPC.favoritesRenameTag]: (oldT: string, newT: string): Favorite[] => repo.renameTag(oldT, newT),
    [IPC.favoritesDeleteTag]: (tag: string): Favorite[] => repo.deleteTag(tag),
    [IPC.favoritesTagUnion]: (): string[] => repo.tagUnion(),
  };
}
