// electron/main/ipc/history.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { HistoryEntry } from '../../../shared/types';
import { buildHistoryHandlers } from './history';

function entry(id: number, url: string, title: string, visitedAt: number): HistoryEntry {
  return { id, url, title, visitedAt };
}

function makeRepo() {
  const all: HistoryEntry[] = [entry(2, 'https://b.test/', 'B', 200), entry(1, 'https://a.test/', 'A', 100)];
  return {
    list: vi.fn((): HistoryEntry[] => all),
    search: vi.fn((): HistoryEntry[] => [all[0]]),
    remove: vi.fn((): void => undefined),
    clear: vi.fn((): void => undefined),
  };
}

describe('buildHistoryHandlers', () => {
  it('registers exactly the four history channels', () => {
    const handlers = buildHistoryHandlers(makeRepo() as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear].sort(),
    );
  });

  it('historyList forwards opts and returns repo.list(opts)', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    const result = handlers[IPC.historyList]({ limit: 50, offset: 10 });
    expect(repo.list).toHaveBeenCalledWith({ limit: 50, offset: 10 });
    expect(result).toEqual(repo.list({ limit: 50, offset: 10 }));
  });

  it('historyList works with no opts (undefined passed through)', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyList]();
    expect(repo.list).toHaveBeenCalledWith(undefined);
  });

  it('historySearch forwards the query and returns the matches', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    const result = handlers[IPC.historySearch]('b.test');
    expect(repo.search).toHaveBeenCalledWith('b.test');
    expect(result).toEqual([repo.list()[0]]);
  });

  it('historyRemove forwards the id', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyRemove](2);
    expect(repo.remove).toHaveBeenCalledWith(2);
  });

  it('historyClear calls repo.clear()', () => {
    const repo = makeRepo();
    const handlers = buildHistoryHandlers(repo as any);
    handlers[IPC.historyClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });
});
