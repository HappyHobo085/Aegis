// electron/main/ipc/favorites.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Favorite } from '../../../shared/types';
import { buildFavoritesHandlers } from './favorites';

function fav(id: number, name: string, url: string, tags: string[], position: number): Favorite {
  return { id, name, url, tags, position };
}

function makeRepo() {
  const list: Favorite[] = [fav(1, 'A', 'https://a.test/', ['x'], 0)];
  return {
    list: vi.fn((): Favorite[] => list),
    add: vi.fn((): Favorite[] => list),
    update: vi.fn((): Favorite[] => list),
    remove: vi.fn((): Favorite[] => list),
    reorder: vi.fn((): Favorite[] => list),
    renameTag: vi.fn((): Favorite[] => list),
    deleteTag: vi.fn((): Favorite[] => list),
    tagUnion: vi.fn((): string[] => ['x', 'y']),
  };
}

describe('buildFavoritesHandlers', () => {
  it('registers exactly the eight favorites channels', () => {
    const handlers = buildFavoritesHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.favoritesList,
        IPC.favoritesAdd,
        IPC.favoritesUpdate,
        IPC.favoritesRemove,
        IPC.favoritesReorder,
        IPC.favoritesRenameTag,
        IPC.favoritesDeleteTag,
        IPC.favoritesTagUnion,
      ].sort(),
    );
  });

  it('favoritesList returns repo.list()', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const result = handlers[IPC.favoritesList]();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.list());
  });

  it('favoritesAdd forwards the input and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const input = { name: 'B', url: 'https://b.test/', tags: ['y'] };
    const result = handlers[IPC.favoritesAdd](input);
    expect(repo.add).toHaveBeenCalledWith(input);
    expect(result).toEqual(repo.list());
  });

  it('favoritesUpdate forwards (id, partial)', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesUpdate](1, { name: 'Renamed' });
    expect(repo.update).toHaveBeenCalledWith(1, { name: 'Renamed' });
  });

  it('favoritesRemove forwards the id', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
  });

  it('favoritesReorder forwards the id array', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesReorder]([3, 1, 2]);
    expect(repo.reorder).toHaveBeenCalledWith([3, 1, 2]);
  });

  it('favoritesRenameTag forwards (oldT, newT)', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesRenameTag]('x', 'z');
    expect(repo.renameTag).toHaveBeenCalledWith('x', 'z');
  });

  it('favoritesDeleteTag forwards the tag', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    handlers[IPC.favoritesDeleteTag]('x');
    expect(repo.deleteTag).toHaveBeenCalledWith('x');
  });

  it('favoritesTagUnion returns repo.tagUnion()', () => {
    const repo = makeRepo();
    const handlers = buildFavoritesHandlers(repo as any);
    const result = handlers[IPC.favoritesTagUnion]();
    expect(repo.tagUnion).toHaveBeenCalledTimes(1);
    expect(result).toEqual(['x', 'y']);
  });
});
