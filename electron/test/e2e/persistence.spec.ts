// electron/test/e2e/persistence.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Favorite, SavedItem, HistoryEntry } from '../../../shared/types';

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
          return ''; // transient startup race (context not ready) — let expect.poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function favAdd(
  app: ElectronApplication,
  input: { name: string; url: string },
): Promise<Favorite[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.favoritesRepo.add(i),
    input,
  );
}

function favList(app: ElectronApplication): Promise<Favorite[]> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.favoritesRepo.list(),
  );
}

function savedAdd(
  app: ElectronApplication,
  input: { url: string; title: string; tags?: string[] },
): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.savedRepo.add(i),
    input,
  );
}

function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}

/** Trigger a real top-frame navigation so the main-side recorder writes history. */
function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list());
}

test('favorites + history + saved-list (with tags) survive an app restart — the Phase-3 exit', async () => {
  // ONE userData dir reused across two launches (§9.3).
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-persist-'));
  const favUrl = `${fixtures.baseUrl}/spa.html`;
  const savedUrl = `${fixtures.baseUrl}/late-title.html`;

  // app1: seed a favorite + a saved item (with tags), then close cleanly so the
  // first process releases the DB before app2 opens it (better-sqlite3 writes are
  // synchronous + WAL-durable; the await close() guarantees the release).
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await favAdd(app1, { name: 'Persisted Fav', url: favUrl });
    await savedAdd(app1, { url: savedUrl, title: 'Persisted Saved', tags: ['keep', 'me'] });
    // Sanity within app1.
    expect((await favList(app1)).map((f) => f.name)).toEqual(['Persisted Fav']);
    expect((await savedList(app1)).map((s) => s.title)).toEqual(['Persisted Saved']);
    // Record a real history entry (auto-recorded by the main-side recorder on a real
    // http nav) and confirm it landed BEFORE closing, so we know it was written to disk.
    await navigate(app1, favUrl);
    await expect
      .poll(async () => (await historyList(app1)).some((h) => h.url === favUrl), { timeout: 15000 })
      .toBe(true);
  } finally {
    await app1.close();
  }

  // app2: SAME userData dir → the SQLite store must restore both rows.
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await favList(app2)).map((f) => f.name), { timeout: 15000 })
      .toEqual(['Persisted Fav']);
    const fav = (await favList(app2))[0];
    expect(fav.url).toBe(favUrl);

    await expect
      .poll(async () => (await savedList(app2)).map((s) => s.title), { timeout: 15000 })
      .toEqual(['Persisted Saved']);
    const savedItem = (await savedList(app2))[0];
    expect(savedItem.url).toBe(savedUrl);
    expect(savedItem.tags).toEqual(['keep', 'me']); // tags persisted as JSON, re-parsed

    // History (auto-recorded in app1) also survives the restart (spec §11.5).
    await expect
      .poll(async () => (await historyList(app2)).some((h) => h.url === favUrl), { timeout: 15000 })
      .toBe(true);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
