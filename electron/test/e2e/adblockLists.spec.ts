// electron/test/e2e/adblockLists.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount, ListUpdateResult } from '../../../shared/types';

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
        // The first-run snapshot path deserializes a ~7 MB engine synchronously in
        // boot(); that briefly blocks the main process while Playwright is still
        // wiring up its inspector execution context, so the very first evaluate can
        // throw "Execution context was destroyed". Treat that as not-ready and retry.
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

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function snapshotCount(app: ElectronApplication): Promise<BlockedCount> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount());
}

function updateNow(app: ElectronApplication): Promise<ListUpdateResult> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.updateNow());
}

function adLoaded(app: ElectronApplication, prop: string): Promise<boolean> {
  return app.evaluate(
    (_e, p) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `window.${p}`,
        true,
      ),
    prop,
  );
}

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

test('first run loads the bundled snapshot with blocking active (no cache, offline)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-seed-'));
  // No AEGIS_ADBLOCK_TEST_FILTER and no prior cache → boot MUST load the bundled
  // snapshot engine (not a built-empty one). OFFLINE skips the background refresh
  // kick so the snapshot stays the active engine — fully hermetic.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    // Deterministic — decoupled from uncertain EasyList localhost path matching:
    // (1) the engine came from the bundled snapshot (proves never-zero first-run,
    // §13.2); (2) blocking is enabled on the content session after the first nav
    // (proves engine-readiness gating, §13.4 / §13.6 — the preload path resolved).
    const engineSource = await app.evaluate(
      () => (globalThis as any).__aegisTest.adblock.engineSource,
    );
    expect(engineSource).toBe('snapshot');

    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    const active = await app.evaluate(
      () => (globalThis as any).__aegisTest.adblock.isBlockingActive(),
    );
    expect(active).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('offline updateNow falls back to cache and every source reports ok:false', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-offline-'));
  // Deterministic initial engine (so blocking is live independent of the seed), and
  // OFFLINE so refreshFetch rejects → fetchAll's per-source try fails → cache-fallback.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    // Blocking still works offline (initial engine is live).
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);

    // Manual update while offline: must resolve (never throw), every source ok:false.
    const result = await updateNow(app);
    expect(Array.isArray(result.perSource)).toBe(true);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === false)).toBe(true);
    expect(typeof result.lastUpdated).toBe('number');

    // App keeps blocking after the failed refresh (initial engine untouched).
    const before = (await snapshotCount(app)).session;
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect((await snapshotCount(app)).session).toBeGreaterThan(before);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('real engine swap: updateNow fetches the fixture list, swaps, and blocks the new ad B', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-swap-'));
  // Initial engine blocks ad A (/ads/banner.js) only; the fixture list (served at
  // AEGIS_ADBLOCK_LIST_BASE) blocks ad B (/ads/tracker.js). updateNow does a REAL fetch
  // from the fixture server, builds a REAL second ElectronBlocker, and stages it for swap.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // Pre-swap: ad B is NOT yet blocked by the initial (banner-only) engine.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(true);
    const sessionBeforeSwap = (await snapshotCount(app)).session;

    // Real refresh: fetch the fixture list over the network and stage the new engine.
    const result = await updateNow(app);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);
    expect(typeof result.lastUpdated).toBe('number');

    // The swap is applied at the next navigation boundary (§4/§8.12).
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // ad B now blocked
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(sessionBeforeSwap);

    // The swap re-enabled blocking + re-attached the counter against the REAL new engine;
    // a follow-up nav still works (no detached-listener / disable-throw regression).
    const afterSwap = (await snapshotCount(app)).session;
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect((await snapshotCount(app)).session).toBeGreaterThan(afterSwap);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
