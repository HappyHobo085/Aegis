// electron/main/downloads.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron's app + node:fs/node:path so wireDownloads stays Node-testable.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/os/Downloads') },
}));
const fsExists = vi.fn(() => false);
vi.mock('node:fs', () => ({ existsSync: (p: string) => fsExists(p) }));

import { wireDownloads } from './downloads';
import type { DownloadEntry } from '../../shared/types';

type Listener = (...a: any[]) => void;

function makeSession() {
  const listeners = new Map<string, Listener[]>();
  return {
    on(channel: string, cb: Listener) {
      const arr = listeners.get(channel) ?? [];
      arr.push(cb);
      listeners.set(channel, arr);
      return this;
    },
    _emit(channel: string, ...args: any[]) {
      for (const l of listeners.get(channel) ?? []) l(...args);
    },
  };
}

function makeItem(over: Partial<Record<string, any>> = {}) {
  const handlers = new Map<string, Listener>();
  return {
    setSavePath: vi.fn(),
    getFilename: vi.fn(() => over.filename ?? 'doc.pdf'),
    getURL: vi.fn(() => over.url ?? 'https://dl.test/doc.pdf'),
    getTotalBytes: vi.fn(() => over.total ?? 1000),
    getReceivedBytes: vi.fn(() => over.received ?? 0),
    getState: vi.fn(() => over.state ?? 'progressing'),
    getStartTime: vi.fn(() => 12345),
    cancel: vi.fn(),
    on(evt: string, cb: Listener) {
      handlers.set(evt, cb);
      return this;
    },
    _fire(evt: string, ...args: any[]) {
      handlers.get(evt)?.(...args);
    },
  };
}

function makeRepo() {
  let nextId = 1;
  const rows: DownloadEntry[] = [];
  return {
    rows,
    record: vi.fn((input: Omit<DownloadEntry, 'id'>): DownloadEntry => {
      const row = { id: nextId++, ...input };
      rows.push(row);
      return row;
    }),
    update: vi.fn((id: number, partial: Partial<DownloadEntry>) => {
      const r = rows.find((x) => x.id === id);
      if (r) Object.assign(r, partial);
    }),
    list: vi.fn(() => rows),
    remove: vi.fn(),
    clear: vi.fn(),
    get: vi.fn((id: number) => rows.find((x) => x.id === id)),
  };
}

describe('wireDownloads', () => {
  beforeEach(() => {
    fsExists.mockReset();
    fsExists.mockReturnValue(false);
  });

  it('sets the save path synchronously inside will-download and records a row', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const settingsRepo = { get: vi.fn(() => ({ downloadDir: '' })) };
    const liveItems = new Map<number, any>();
    const onChanged = vi.fn();
    wireDownloads(session as any, { downloadsRepo, settingsRepo: settingsRepo as any, onChanged, liveItems });

    const item = makeItem();
    session._emit('will-download', {}, item, {});

    expect(item.setSavePath).toHaveBeenCalledWith('/os/Downloads/doc.pdf');
    expect(downloadsRepo.record).toHaveBeenCalledTimes(1);
    const recorded = downloadsRepo.record.mock.calls[0][0];
    expect(recorded).toMatchObject({
      url: 'https://dl.test/doc.pdf',
      filename: 'doc.pdf',
      savePath: '/os/Downloads/doc.pdf',
      state: 'progressing',
      receivedBytes: 0,
      totalBytes: 1000,
    });
    expect(liveItems.get(1)).toBe(item);
  });

  it('uses the configured downloadDir and uniquifies a colliding filename', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const settingsRepo = { get: vi.fn(() => ({ downloadDir: '/my/dl' })) };
    fsExists.mockImplementation((p: string) => p === '/my/dl/doc.pdf');
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: settingsRepo as any, onChanged: vi.fn(), liveItems: new Map(),
    });
    const item = makeItem();
    session._emit('will-download', {}, item, {});
    expect(item.setSavePath).toHaveBeenCalledWith('/my/dl/doc (1).pdf');
  });

  it('updates progress on item "updated" and fires onChanged', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const onChanged = vi.fn();
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: { get: () => ({ downloadDir: '' }) } as any, onChanged, liveItems: new Map(),
    });
    const item = makeItem({ received: 500 });
    session._emit('will-download', {}, item, {});
    onChanged.mockClear();
    item._fire('updated', {}, 'progressing');
    expect(downloadsRepo.update).toHaveBeenCalledWith(1, {
      receivedBytes: 500,
      totalBytes: 1000,
      state: 'progressing',
    });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('on "done" persists the final state, removes the live item, and fires onChanged', () => {
    const session = makeSession();
    const downloadsRepo = makeRepo();
    const onChanged = vi.fn();
    const liveItems = new Map<number, any>();
    wireDownloads(session as any, {
      downloadsRepo, settingsRepo: { get: () => ({ downloadDir: '' }) } as any, onChanged, liveItems,
    });
    const item = makeItem({ received: 1000 });
    session._emit('will-download', {}, item, {});
    onChanged.mockClear();
    item._fire('done', {}, 'completed');
    expect(downloadsRepo.update).toHaveBeenLastCalledWith(1, {
      receivedBytes: 1000,
      totalBytes: 1000,
      state: 'completed',
    });
    expect(liveItems.has(1)).toBe(false);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
