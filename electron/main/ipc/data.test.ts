// electron/main/ipc/data.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Favorite, HistoryEntry, SavedItem, Settings } from '../../../shared/types';

const showSaveDialog = vi.fn();
const showOpenDialog = vi.fn();
vi.mock('electron', () => ({
  dialog: {
    showSaveDialog: (...a: any[]) => showSaveDialog(...a),
    showOpenDialog: (...a: any[]) => showOpenDialog(...a),
  },
}));

const writeFile = vi.fn(async () => undefined);
const readFile = vi.fn(async () => '');
vi.mock('node:fs/promises', () => ({
  writeFile: (...a: any[]) => writeFile(...a),
  readFile: (...a: any[]) => readFile(...a),
}));

import { buildDataHandlers } from './data';

const settings: Settings = {
  siteName: 'Aegis', homeUrl: 'https://h/', primaryColor: '#000',
  defaultSearchTemplate: 'https://d/?q=%s', searchEngines: [], hideChromeByDefault: false,
  downloadDir: '',
};
const fav = (url: string): Favorite => ({ id: 1, name: 'n', url, position: 0 });
const hist = (url: string, visitedAt: number): HistoryEntry => ({ id: 1, url, title: 't', visitedAt });
const saved = (url: string): SavedItem => ({ id: 1, url, title: 't', tags: [], savedAt: 5 });

function makeRepos(over: any = {}) {
  return {
    favoritesRepo: {
      list: vi.fn(() => over.favorites ?? []),
      add: vi.fn(),
      clear: vi.fn(),
      ...over.favoritesRepo,
    },
    historyRepo: {
      list: vi.fn(() => over.history ?? []),
      record: vi.fn(),
      clear: vi.fn(),
      ...over.historyRepo,
    },
    savedRepo: {
      list: vi.fn(() => over.saved ?? []),
      add: vi.fn(),
      clear: vi.fn(),
      ...over.savedRepo,
    },
    settingsRepo: { get: vi.fn(() => settings), set: vi.fn() },
    // Fake better-sqlite3 handle: db.transaction(fn) returns a callable that
    // runs fn synchronously (mirrors better-sqlite3 semantics; a throw inside
    // propagates so the handler's try/catch can return {ok:false,error}).
    db: { transaction: (fn: (...a: any[]) => any) => (...a: any[]) => fn(...a) },
  };
}

const win = {} as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('buildDataHandlers export', () => {
  it('registers exactly the two data channels', () => {
    const handlers = buildDataHandlers(makeRepos() as any, win);
    expect(Object.keys(handlers).sort()).toEqual([IPC.dataExport, IPC.dataImport].sort());
  });

  it('writes a version-1 payload to the chosen path and returns {ok,path}', async () => {
    const repos = makeRepos({ favorites: [fav('https://a/')], history: [hist('https://a/', 7)], saved: [saved('https://a/')] });
    showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/out/aegis-export.json' });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataExport]();
    expect(repos.historyRepo.list).toHaveBeenCalledWith({ limit: 100000 });
    expect(writeFile).toHaveBeenCalledTimes(1);
    const [path, body] = writeFile.mock.calls[0];
    expect(path).toBe('/out/aegis-export.json');
    const parsed = JSON.parse(body as string);
    expect(parsed).toMatchObject({
      version: 1,
      favorites: [fav('https://a/')],
      history: [hist('https://a/', 7)],
      saved: [saved('https://a/')],
      settings,
    });
    expect(res).toEqual({ ok: true, path: '/out/aegis-export.json' });
  });

  it('returns {ok:false} and does not write when the save dialog is canceled', async () => {
    showSaveDialog.mockResolvedValue({ canceled: true, filePath: undefined });
    const handlers = buildDataHandlers(makeRepos() as any, win);
    const res = await handlers[IPC.dataExport]();
    expect(writeFile).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });
});

describe('buildDataHandlers import', () => {
  const exportJson = JSON.stringify({
    version: 1,
    favorites: [fav('https://have/'), fav('https://new/')],
    history: [hist('https://have/', 1), hist('https://new/', 2)],
    saved: [fav('https://new/')].map((f) => saved(f.url)),
    settings,
  });

  it('replace mode clears each store, inserts all, and overwrites settings', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos({
      favorites: [fav('https://have/')],
      saved: [saved('https://have/')],
      history: [hist('https://have/', 0)],
    });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('replace');
    expect(repos.favoritesRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.savedRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.historyRepo.clear).toHaveBeenCalledTimes(1);
    expect(repos.favoritesRepo.add).toHaveBeenCalledTimes(2);
    expect(repos.settingsRepo.set).toHaveBeenCalledWith(settings);
    expect(res).toEqual({ ok: true, counts: { favorites: 2, history: 2, saved: 1 } });
  });

  it('history inserts preserve the original visitedAt timestamps', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos();
    const handlers = buildDataHandlers(repos as any, win);
    await handlers[IPC.dataImport]('replace');
    // record(entry, nowFn) where nowFn() returns the entry's own visitedAt
    const firstCall = repos.historyRepo.record.mock.calls[0];
    expect(firstCall[0]).toMatchObject({ url: 'https://have/' });
    expect(firstCall[1]()).toBe(1);
    const secondCall = repos.historyRepo.record.mock.calls[1];
    expect(secondCall[1]()).toBe(2);
  });

  it('merge mode only inserts rows whose url is not already present', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/x.json'] });
    readFile.mockResolvedValue(exportJson);
    const repos = makeRepos({
      favorites: [fav('https://have/')],
      saved: [saved('https://have/')],
      history: [hist('https://have/', 0)],
    });
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(repos.favoritesRepo.clear).not.toHaveBeenCalled();
    expect(repos.favoritesRepo.add).toHaveBeenCalledTimes(1); // only https://new/
    expect(repos.settingsRepo.set).toHaveBeenCalledWith(settings);
    expect(res).toEqual({ ok: true, counts: { favorites: 1, history: 1, saved: 1 } });
  });

  it('returns {ok:false} when the open dialog is canceled', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const handlers = buildDataHandlers(makeRepos() as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(readFile).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false });
  });

  it('returns {ok:false,error} when the file fails validation', async () => {
    showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/in/bad.json'] });
    readFile.mockResolvedValue(JSON.stringify({ version: 2 }));
    const repos = makeRepos();
    const handlers = buildDataHandlers(repos as any, win);
    const res = await handlers[IPC.dataImport]('merge');
    expect(repos.favoritesRepo.add).not.toHaveBeenCalled();
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
  });
});
