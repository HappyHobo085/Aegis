// electron/main/ipc/downloads.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { DownloadEntry } from '../../../shared/types';

const openPath = vi.fn(async () => '');
const showItemInFolder = vi.fn();
vi.mock('electron', () => ({
  shell: { openPath: (p: string) => openPath(p), showItemInFolder: (p: string) => showItemInFolder(p) },
}));

import { buildDownloadsHandlers } from './downloads';

function makeRepo(rows: DownloadEntry[] = []) {
  return {
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
    get: vi.fn((id: number) => rows.find((r) => r.id === id)),
    record: vi.fn(),
    update: vi.fn(),
  };
}

const row = (id: number, savePath: string): DownloadEntry => ({
  id, url: 'https://d/', filename: 'f', savePath, state: 'completed',
  receivedBytes: 1, totalBytes: 1, startedAt: 0,
});

describe('buildDownloadsHandlers', () => {
  it('registers exactly the six download channels', () => {
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems: new Map() });
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.downloadsList, IPC.downloadsRemove, IPC.downloadsClear,
        IPC.downloadsOpenFile, IPC.downloadsShowInFolder, IPC.downloadsCancel,
      ].sort(),
    );
  });

  it('list returns repo.list()', () => {
    const rows = [row(1, '/d/f')];
    const handlers = buildDownloadsHandlers(makeRepo(rows) as any, { liveItems: new Map() });
    expect(handlers[IPC.downloadsList]()).toEqual(rows);
  });

  it('remove deletes the row and returns the fresh list', () => {
    const repo = makeRepo([row(1, '/d/f')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsRemove](1);
    expect(repo.remove).toHaveBeenCalledWith(1);
    expect(repo.list).toHaveBeenCalled();
  });

  it('clear empties the store and returns the fresh list', () => {
    const repo = makeRepo();
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsClear]();
    expect(repo.clear).toHaveBeenCalledTimes(1);
  });

  it('openFile opens the row savePath via shell.openPath', async () => {
    const repo = makeRepo([row(7, '/d/file.pdf')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    await handlers[IPC.downloadsOpenFile](7);
    expect(openPath).toHaveBeenCalledWith('/d/file.pdf');
  });

  it('showInFolder reveals the row savePath via shell.showItemInFolder', () => {
    const repo = makeRepo([row(7, '/d/file.pdf')]);
    const handlers = buildDownloadsHandlers(repo as any, { liveItems: new Map() });
    handlers[IPC.downloadsShowInFolder](7);
    expect(showItemInFolder).toHaveBeenCalledWith('/d/file.pdf');
  });

  it('cancel calls cancel() on the live item for that id', () => {
    const item = { cancel: vi.fn() };
    const liveItems = new Map<number, any>([[3, item]]);
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems });
    handlers[IPC.downloadsCancel](3);
    expect(item.cancel).toHaveBeenCalledTimes(1);
  });

  it('cancel is a no-op when there is no live item for that id', () => {
    const handlers = buildDownloadsHandlers(makeRepo() as any, { liveItems: new Map() });
    expect(() => handlers[IPC.downloadsCancel](999)).not.toThrow();
  });
});
