// electron/main/ipc/saved.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { SavedItem } from '../../../shared/types';
import { buildSavedHandlers } from './saved';

function item(id: number, url: string, title: string, savedAt: number): SavedItem {
  return { id, url, title, savedAt };
}

function makeRepo() {
  const list: SavedItem[] = [item(1, 'https://a.test/', 'A', 100)];
  return {
    list: vi.fn((): SavedItem[] => list),
    add: vi.fn((): SavedItem[] => list),
    remove: vi.fn((): SavedItem[] => list),
    has: vi.fn((url: string): boolean => url === 'https://a.test/'),
    update: vi.fn((): SavedItem[] => list),
  };
}

describe('buildSavedHandlers', () => {
  it('registers exactly the five saved channels', () => {
    const handlers = buildSavedHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.savedList, IPC.savedAdd, IPC.savedRemove, IPC.savedHas, IPC.savedUpdate].sort(),
    );
  });

  it('savedList returns repo.list()', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const result = handlers[IPC.savedList]();
    expect(repo.list).toHaveBeenCalledTimes(1);
    expect(result).toEqual(repo.list());
  });

  it('savedAdd forwards the input and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const input = { url: 'https://b.test/', title: 'B' };
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

  it('savedUpdate forwards id + partial and returns the list', () => {
    const repo = makeRepo();
    const handlers = buildSavedHandlers(repo as any);
    const partial = { title: 'Updated Title' };
    const result = handlers[IPC.savedUpdate](1, partial);
    expect(repo.update).toHaveBeenCalledWith(1, partial);
    expect(result).toEqual(repo.list());
  });
});
