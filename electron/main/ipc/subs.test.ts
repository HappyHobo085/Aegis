// electron/main/ipc/subs.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Subscription } from '../../../shared/types';
import { buildSubsHandlers } from './subs';

function makeRepo(initial: Subscription[]) {
  let rows = [...initial];
  return {
    rows: () => rows,
    all: vi.fn((): Subscription[] => rows),
    setEnabled: vi.fn((listId: string, enabled: boolean): void => {
      rows = rows.map((r) => (r.listId === listId ? { ...r, enabled } : r));
    }),
    add: vi.fn((url: string): Subscription[] => {
      rows = [...rows, { listId: 'added', url, enabled: true, lastUpdated: null, etag: null, hash: null }];
      return rows;
    }),
    remove: vi.fn((listId: string): void => {
      rows = rows.filter((r) => r.listId !== listId);
    }),
  };
}

const base: Subscription[] = [
  { listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true, lastUpdated: null, etag: null, hash: null },
];

describe('buildSubsHandlers', () => {
  it('registers exactly the four subs channels', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove].sort(),
    );
  });

  it('subsList returns subsRepo.all()', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    const out = handlers[IPC.subsList]();
    expect(repo.all).toHaveBeenCalledTimes(1);
    expect(out).toEqual(base);
  });

  it('subsSetEnabled mutates, rebuilds from cache, and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh });
    const out = handlers[IPC.subsSetEnabled]('easylist', false);
    expect(repo.setEnabled).toHaveBeenCalledWith('easylist', false);
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(out[0].enabled).toBe(false);
  });

  it('subsAdd validates+inserts an HTTPS url, kicks a refresh (not rebuild), and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh });
    const out = handlers[IPC.subsAdd]('https://new.test/list.txt');
    expect(repo.add).toHaveBeenCalledWith('https://new.test/list.txt');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(rebuildFromCache).not.toHaveBeenCalled();
    expect(out).toHaveLength(2);
  });

  it('subsAdd accepts an http loopback url (matches the listManager guard)', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(() => handlers[IPC.subsAdd]('http://127.0.0.1:5055/lists/x.txt')).not.toThrow();
    expect(repo.add).toHaveBeenCalledWith('http://127.0.0.1:5055/lists/x.txt');
  });

  it('subsAdd rejects a non-HTTPS (non-loopback) url BEFORE touching the repo', () => {
    const repo = makeRepo(base);
    const refresh = vi.fn(async () => undefined);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh });
    expect(() => handlers[IPC.subsAdd]('http://evil.test/list.txt')).toThrow(/non-HTTPS/i);
    expect(repo.add).not.toHaveBeenCalled();
    expect(refresh).not.toHaveBeenCalled();
  });

  it('subsAdd rejects an unparseable url BEFORE touching the repo', () => {
    const repo = makeRepo(base);
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache: vi.fn(), refresh: vi.fn(async () => undefined) });
    expect(() => handlers[IPC.subsAdd]('not a url')).toThrow();
    expect(repo.add).not.toHaveBeenCalled();
  });

  it('subsRemove deletes, rebuilds from cache, and returns all()', () => {
    const repo = makeRepo(base);
    const rebuildFromCache = vi.fn();
    const handlers = buildSubsHandlers(repo as any, { rebuildFromCache, refresh: vi.fn(async () => undefined) });
    const out = handlers[IPC.subsRemove]('easylist');
    expect(repo.remove).toHaveBeenCalledWith('easylist');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(out).toEqual([]);
  });
});
