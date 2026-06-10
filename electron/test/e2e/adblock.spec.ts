// electron/test/e2e/adblock.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount } from '../../../shared/types';

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

function snapshotCount(app: ElectronApplication): Promise<BlockedCount> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount());
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

test('blocks a sub-resource matching the seeded test filter and reports blockedCount > 0', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-block-'));
  // Deterministic engine: block the ad sub-resource only (a network filter on a path).
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);

    // The blocked sub-resource never executed → the page's __adLoaded stays false.
    const adLoaded = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__adLoaded',
        true,
      ),
    );
    expect(adLoaded).toBe(false);

    // The controller pushes the count on did-stop-loading; the snapshot must show a block.
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);

    const snap = await snapshotCount(app);
    expect(snap.viewId).toBe(1);
    expect(snap.page).toBeGreaterThan(0);
    expect(snap.session).toBeGreaterThanOrEqual(snap.page);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('per-page count resets on a new top-frame navigation; session stays monotonic', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-reset-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    const first = await snapshotCount(app);

    // Navigate to a clean page (no ad sub-resource): page resets to 0, session preserved.
    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBe(0);
    expect((await snapshotCount(app)).session).toBe(first.session);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
