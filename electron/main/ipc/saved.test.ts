// electron/main/ipc/saved.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import { buildSavedHandlers } from './saved';

function item(id: number, url: string, title: string, tags: string[], savedAt: number): SavedItem {
  return { id, url, title, tags, savedAt };
}

function makeRepo() {
  const list: SavedItem[] = [item(1, 'https://a.test/', 'A', ['news'], 100)];
  const tags: string[] = ['news'];
  return {
    list: vi.fn((): SavedItem[] => list),
    add: vi.fn((): SavedItem[] => list),
    remove: vi.fn((): SavedItem[] => list),
    has: vi.fn((url: string): boolean => url === 'https://a.test/'),
    update: vi.fn((): SavedItem[] => list),
    renameTag: vi.fn((): SavedItem[] => list),
    deleteTag: vi.fn((): SavedItem[] => list),
    tagUnion: vi.fn((): string[] => tags),
  };
}

describe('buildSavedHandlers', () => {
  it('registers exactly the eight saved channels', () => {
    const handlers = buildSavedHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.savedList,
        IPC.savedAdd,
        IPC.savedRemove,
        IPC.savedHas,
        IPC.savedUpdate,
        IPC.savedRenameTag,
        IPC.savedDeleteTag,
        IPC.savedTagUnion,
      ].sort(),
    );
  });

  it('savedList returns repo.list()', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedList]();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.list());
  });

  it('savedAdd forwards the input (incl. tags) and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const input = { url: 'https://b.test/', title: 'B', tags: ['blog', 'news'] };
    const result = handlers[IPC.savedAdd](input);
    expect(repo.add).toHaveBeenCalledWith(input);
    expect(result).toEqual(repo.list());
  });

  it('savedAdd forwards input without tags (repo defaults them)', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const input = { url: 'https://c.test/', title: 'C' };
    const result = handlers[IPC.savedAdd](input);
    expect(repo.add).toHaveBeenCalledWith(input);
    expect(result).toEqual(repo.list());
  });

  it('savedRemove forwards the id and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
    expect(result).toEqual(repo.list());
  });

  it('savedHas forwards the url and returns the boolean', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    expect(handlers[IPC.savedHas]('https://a.test/')).toBe(true);
    expect(handlers[IPC.savedHas]('https://missing.test/')).toBe(false);
    expect(repo.has).toHaveBeenCalledWith('https://missing.test/');
  });

  it('savedUpdate forwards id + partial (title and/or tags) and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const partial = { title: 'Updated Title', tags: ['blog'] };
    const result = handlers[IPC.savedUpdate](1, partial);
    expect(repo.update).toHaveBeenCalledWith(1, partial);
    expect(result).toEqual(repo.list());
  });

  it('savedRenameTag forwards old + new and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedRenameTag]('news', 'press');
    expect(repo.renameTag).toHaveBeenCalledWith('news', 'press');
    expect(result).toEqual(repo.list());
  });

  it('savedDeleteTag forwards the tag and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedDeleteTag]('news');
    expect(repo.deleteTag).toHaveBeenCalledWith('news');
    expect(result).toEqual(repo.list());
  });

  it('savedTagUnion returns repo.tagUnion()', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedTagUnion]();
    expect(repo.tagUnion).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.tagUnion());
  });
});
