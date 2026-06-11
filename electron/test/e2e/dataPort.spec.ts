// electron/test/e2e/dataPort.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Favorite, SavedItem, HistoryEntry, Settings } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

async function launchApp(
  userDataDir: string,
  extraEnv?: Record<string, string>,
): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, ...extraEnv },
  });
  await expect
    .poll(
      async () => {
        try {
          return await app.evaluate(() => {
            const reg = (globalThis as any).__aegisTest;
            return reg?.primary ? reg.primary.getState().url : '';
          });
        } catch {
          return '';
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

interface ExportPayload {
  version: 1;
  favorites: Favorite[];
  history: HistoryEntry[];
  saved: SavedItem[];
  settings: Settings;
}

/** Build the export payload the same way data.export() does (§2.5). */
function buildExport(app: ElectronApplication): Promise<ExportPayload> {
  return app.evaluate(() => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    return {
      version: 1,
      favorites: places.favoritesRepo.list(),
      history: places.historyRepo.list({ limit: 100000 }),
      saved: places.savedRepo.list(),
      settings: phase4.settingsRepo.get(),
    };
  });
}

/** Apply a payload in REPLACE mode the same way data.import('replace') does (§2.5). */
function applyReplace(app: ElectronApplication, payload: ExportPayload): Promise<void> {
  return app.evaluate((_e, p) => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    places.favoritesRepo.clear();
    places.savedRepo.clear();
    places.historyRepo.clear();
    for (const f of p.favorites) {
      places.favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
    }
    for (const s of p.saved) {
      places.savedRepo.add({ url: s.url, title: s.title });
    }
    for (const h of p.history) {
      // record(e, ()=>e.visitedAt) preserves the original timestamp on import.
      places.historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
    }
    phase4.settingsRepo.set(p.settings);
  }, payload);
}

/** Apply a payload in MERGE mode: insert rows whose url is not already present (§2.5). */
function applyMerge(app: ElectronApplication, payload: ExportPayload): Promise<void> {
  return app.evaluate((_e, p) => {
    const places = (globalThis as any).__aegisTest.places;
    const phase4 = (globalThis as any).__aegisTest.phase4;
    const favUrls = new Set(places.favoritesRepo.list().map((f: any) => f.url));
    for (const f of p.favorites) {
      if (!favUrls.has(f.url)) places.favoritesRepo.add({ name: f.name, url: f.url, tags: f.tags });
    }
    const savedUrls = new Set(places.savedRepo.list().map((s: any) => s.url));
    for (const s of p.saved) {
      if (!savedUrls.has(s.url)) places.savedRepo.add({ url: s.url, title: s.title });
    }
    const histUrls = new Set(places.historyRepo.list({ limit: 100000 }).map((h: any) => h.url));
    for (const h of p.history) {
      if (!histUrls.has(h.url)) places.historyRepo.record({ url: h.url, title: h.title }, () => h.visitedAt);
    }
    phase4.settingsRepo.set(p.settings);
  }, payload);
}

function favList(app: ElectronApplication): Promise<Favorite[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.favoritesRepo.list());
}
function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}
function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list({ limit: 100000 }));
}
function settingsGet(app: ElectronApplication): Promise<Settings> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.settingsRepo.get());
}

test('export → REPLACE import round-trips favorites/saved/history/settings into a fresh profile', async () => {
  const srcDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-src-'));
  const dstDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-dst-'));
  const favUrl = `${fixtures.baseUrl}/spa.html`;
  const savedUrl = `${fixtures.baseUrl}/late-title.html`;

  // Source app: seed data + a non-default settings value, then export.
  const src = await launchApp(srcDir, { AEGIS_HOME_URL: 'about:blank' });
  let payload: ExportPayload;
  try {
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Fav A', url: u, tags: ['x'] }),
      favUrl,
    );
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.savedRepo.add({ url: u, title: 'Saved A' }),
      savedUrl,
    );
    await src.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.historyRepo.record({ url: u, title: 'Hist A' }),
      favUrl,
    );
    await src.evaluate(() =>
      (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: '/tmp/aegis-imported' }),
    );
    payload = await buildExport(src);
    expect(payload.favorites.map((f) => f.url)).toContain(favUrl);
    expect(payload.settings.downloadDir).toBe('/tmp/aegis-imported');
  } finally {
    await src.close();
  }

  // Destination app (fresh profile): seed a row that REPLACE must wipe, then import.
  const dst = await launchApp(dstDir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await dst.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Stale', url: u, tags: [] }),
      `${fixtures.baseUrl}/stale.html`,
    );
    await applyReplace(dst, payload);

    // REPLACE wiped the stale row; only the imported one remains.
    const favs = await favList(dst);
    expect(favs.map((f) => f.url)).toEqual([favUrl]);
    expect(favs[0].tags).toEqual(['x']);
    expect((await savedList(dst)).map((s) => s.url)).toEqual([savedUrl]);
    expect((await historyList(dst)).some((h) => h.url === favUrl)).toBe(true);
    expect((await settingsGet(dst)).downloadDir).toBe('/tmp/aegis-imported');
  } finally {
    await dst.close();
    rmSync(srcDir, { recursive: true, force: true });
    rmSync(dstDir, { recursive: true, force: true });
  }
});

test('MERGE import keeps existing rows and only adds non-duplicate urls', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-data-merge-'));
  const existingUrl = `${fixtures.baseUrl}/existing.html`;
  const newUrl = `${fixtures.baseUrl}/new.html`;
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Seed an existing favorite that the payload also contains (dup) + one only in the app.
    await app.evaluate(
      (_e, u) => (globalThis as any).__aegisTest.places.favoritesRepo.add({ name: 'Existing', url: u, tags: [] }),
      existingUrl,
    );
    const current = await settingsGet(app);
    const payload: ExportPayload = {
      version: 1,
      favorites: [
        { id: 999, name: 'Existing dup', url: existingUrl, tags: ['dup'] },
        { id: 1000, name: 'Brand New', url: newUrl, tags: ['new'] },
      ] as Favorite[],
      history: [],
      saved: [],
      settings: { ...current, downloadDir: '/tmp/aegis-merge' },
    };

    await applyMerge(app, payload);

    const favs = await favList(app);
    const urls = favs.map((f) => f.url);
    // The duplicate url is NOT re-added (still one Existing); the new url IS added.
    expect(urls.filter((u) => u === existingUrl)).toHaveLength(1);
    expect(urls).toContain(newUrl);
    // Settings shallow-merged.
    expect((await settingsGet(app)).downloadDir).toBe('/tmp/aegis-merge');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
