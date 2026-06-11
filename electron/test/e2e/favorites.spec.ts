// electron/test/e2e/favorites.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, Favorite } from '../../../shared/types';

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

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

/** Drive the constructed FavoritesRepo inside the booted app (§9.1). */
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

test('favorites add → list reflects insertion order and ascending positions', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fav-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    let list = await favAdd(app, { name: 'Alpha', url: aUrl });
    expect(list.map((f) => f.name)).toEqual(['Alpha']);
    list = await favAdd(app, { name: 'Beta', url: bUrl });
    // Ordered by position (insertion order): Alpha first, Beta second.
    expect(list.map((f) => f.name)).toEqual(['Alpha', 'Beta']);
    expect(list[0].position).toBeLessThan(list[1].position);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening a favorite navigates the content view to its URL (chip → navigate wiring)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fav-nav-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const favUrl = `${fixtures.baseUrl}/spa.html`;
    await favAdd(app, { name: 'Alpha', url: favUrl });

    // FavoritesBar's chip onOpenFavorite === nav.navigate (component-tested);
    // here we prove the booted app navigates the content view to a favorite URL.
    const fav = (await favList(app))[0];
    await navigate(app, fav.url);
    await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(favUrl);
    await expect
      .poll(async () => (await state(app)).isLoading, { timeout: 15000 })
      .toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
