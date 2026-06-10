// electron/test/e2e/settings.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { Settings, Subscription, NavState } from '../../../shared/types';

let fixtures: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
});

test.afterAll(async () => {
  await fixtures.close();
});

/** Launch the built app with the test-only registry on, then wait for first nav to settle. */
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

function settingsGet(app: ElectronApplication): Promise<Settings> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.settingsRepo.get());
}

function settingsSet(
  app: ElectronApplication,
  partial: Partial<Settings>,
): Promise<Settings> {
  return app.evaluate(
    (_e, p) => (globalThis as any).__aegisTest.phase4.settingsRepo.set(p),
    partial,
  );
}

function subsAdd(app: ElectronApplication, url: string): Promise<Subscription[]> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.add(u);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, url);
}

function subsAll(app: ElectronApplication): Promise<Subscription[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.subsRepo.all());
}

function customFiltersGet(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.customFiltersRepo.get());
}

function customFiltersSet(app: ElectronApplication, text: string): Promise<string> {
  return app.evaluate((_e, t) => {
    (globalThis as any).__aegisTest.phase4.customFiltersRepo.set(t);
    return (globalThis as any).__aegisTest.phase4.customFiltersRepo.get();
  }, text);
}

/** Trigger a top-frame navigation (used to apply the engine swap + exercise nav.home). */
function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.primary.navigate(u);
  }, url);
}

async function navigateAndSettle(app: ElectronApplication, url: string): Promise<void> {
  await navigate(app, url);
  await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(url);
  await expect.poll(async () => (await state(app)).isLoading, { timeout: 15000 }).toBe(false);
}

test('settings round-trip: accent color, custom list, my-filters survive an app restart (Phase-4 §11.9)', async () => {
  // ONE userData dir reused across two launches (persistence proof, spec §11.9).
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-settings-persist-'));
  const customUrl = `${fixtures.baseUrl}/lists/custom-e2e.txt`;
  const accent = '#00ff88';
  const myFilters = '! e2e my-filters blob\n127.0.0.1##.aegis-ad-sentinel\n/ads/banner.js^';

  // app1: write an accent color, add a custom list URL, and save a my-filters blob.
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Accent color edit (Appearance tab → settings.set({ primaryColor })).
    await settingsSet(app1, { primaryColor: accent });
    expect((await settingsGet(app1)).primaryColor).toBe(accent);

    // Add a custom HTTPS-equivalent (loopback http allowed by the guard) list URL.
    const afterAdd = await subsAdd(app1, customUrl);
    expect(afterAdd.some((s) => s.url === customUrl)).toBe(true);

    // Save a my-filters blob.
    const savedText = await customFiltersSet(app1, myFilters);
    expect(savedText).toBe(myFilters);
  } finally {
    await app1.close();
  }

  // app2: SAME userData dir → every value must restore from SQLite.
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await settingsGet(app2)).primaryColor, { timeout: 15000 })
      .toBe(accent);

    await expect
      .poll(async () => (await subsAll(app2)).some((s) => s.url === customUrl), { timeout: 15000 })
      .toBe(true);

    await expect
      .poll(async () => await customFiltersGet(app2), { timeout: 15000 })
      .toBe(myFilters);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('editing homeUrl makes nav.home navigate to the configured URL (spec §11.4)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-settings-home-'));
  const homeTarget = `${fixtures.baseUrl}/spa.html`;
  // Boot to about:blank so the configured homeUrl is provably what nav.home resolves.
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Edit homeUrl via the settings repo (Home tab editor).
    await settingsSet(app, { homeUrl: homeTarget });
    expect((await settingsGet(app)).homeUrl).toBe(homeTarget);

    // nav.home resolves settingsRepo.get().homeUrl live (contract §1.1). Invoke it via the
    // phase4 registry's navHome (defined once in Task 9) and assert the top frame navigates.
    await app.evaluate(() => {
      (globalThis as any).__aegisTest.phase4.navHome();
    });
    await expect.poll(async () => (await state(app)).url, { timeout: 15000 }).toBe(homeTarget);
    await expect.poll(async () => (await state(app)).isLoading, { timeout: 15000 }).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
