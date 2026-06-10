// electron/test/e2e/adblockToggle.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, BlockedCount, AdblockState } from '../../../shared/types';

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
      () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
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

function setEnabled(app: ElectronApplication, enabled: boolean): Promise<AdblockState> {
  return app.evaluate(
    (_e, b) => (globalThis as any).__aegisTest.adblock.setEnabled(b),
    enabled,
  );
}

function toggleAllowlist(app: ElectronApplication, host: string): Promise<AdblockState> {
  return app.evaluate(
    (_e, h) => (globalThis as any).__aegisTest.adblock.toggleAllowlist(h),
    host,
  );
}

function adState(app: ElectronApplication): Promise<AdblockState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.adblock.getState());
}

function adLoaded(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      'window.__adLoaded',
      true,
    ),
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

test('global toggle off suppresses blocking on the next nav; re-enable restores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-toggle-'));
  const adUrl = `${fixtures.baseUrl}/ad-page.html`;
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    // Baseline: blocking is on → the ad is blocked.
    await navigateAndSettle(app, adUrl);
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(await adLoaded(app)).toBe(false);
    const sessionAfterBlocked = (await snapshotCount(app)).session;

    // Turn blocking OFF — must NOT take effect mid-load; the current page is unchanged.
    const offState = await setEnabled(app, false);
    expect(offState.enabled).toBe(false);

    // Next navigation runs with blocking suppressed → the ad now loads, no NEW blocks.
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(true);
    expect((await snapshotCount(app)).page).toBe(0);
    expect((await snapshotCount(app)).session).toBe(sessionAfterBlocked);

    // Re-enable → blocking returns on the NEXT navigation.
    const onState = await setEnabled(app, true);
    expect(onState.enabled).toBe(true);
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(false);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect((await snapshotCount(app)).session).toBeGreaterThan(sessionAfterBlocked);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlisting the host restores its ads on next load; un-allowlisting restores blocking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-adblock-allowlist-'));
  const adUrl = `${fixtures.baseUrl}/ad-page.html`;
  const host = new URL(adUrl).hostname; // 127.0.0.1
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '/ads/banner.js^',
  });
  try {
    // Baseline: blocking on, host not allowlisted → ad blocked.
    await navigateAndSettle(app, adUrl);
    await expect
      .poll(async () => (await snapshotCount(app)).session, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect(await adLoaded(app)).toBe(false);
    const sessionBefore = (await snapshotCount(app)).session;

    // Allowlist the host. Global enable stays on; only this host is exempted.
    const allowed = await toggleAllowlist(app, host);
    expect(allowed.enabled).toBe(true);
    expect(allowed.allowlistedHosts).toContain(host);
    expect(await adState(app)).toMatchObject({ allowlistedHosts: [host] });

    // Next nav to the allowlisted host → ads restored, no new blocks.
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(true);
    expect((await snapshotCount(app)).page).toBe(0);
    expect((await snapshotCount(app)).session).toBe(sessionBefore);

    // Un-allowlist (toggle again) → blocking restored on next load.
    const removed = await toggleAllowlist(app, host);
    expect(removed.allowlistedHosts).not.toContain(host);
    await navigateAndSettle(app, adUrl);
    expect(await adLoaded(app)).toBe(false);
    await expect
      .poll(async () => (await snapshotCount(app)).page, { timeout: 15000 })
      .toBeGreaterThan(0);
    expect((await snapshotCount(app)).session).toBeGreaterThan(sessionBefore);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
