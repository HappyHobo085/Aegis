// electron/test/e2e/popup.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState } from '../../../shared/types';

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

test('an allowed-scheme window.open opens no real popup window (gate always denies the popup)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-allowed-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const landing = `${fixtures.baseUrl}/popup/landing.html`;
    // Trigger-based fixture (NOT auto-firing): settle on it FIRST, then fire the open.
    // An auto-firing fixture that routes in-place would navigate off the fixture during
    // load and navigateAndSettle could never settle (§0).
    const fixtureUrl = `${fixtures.baseUrl}/popup/popunder-blank.html`;
    await navigateAndSettle(app, fixtureUrl);

    // Capture a window-count BASELINE after the fixture has settled. The BaseWindow
    // hosts chrome + content (= 2 page targets); a spawned popup would INCREASE this.
    const baseline = app.windows().length;

    // Trigger window.open(<allowed https url>, '_blank') in the content main world.
    await app.evaluate(
      (_e, u) =>
        (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
          `window.__aegisOpenPopunder(${JSON.stringify(u)})`,
          true,
        ),
      landing,
    );

    // Deterministic, disposition-INDEPENDENT guarantee: the setWindowOpenHandler always
    // returns {action:'deny'}, so NO real popup window is ever created — windows().length
    // is unchanged regardless of the disposition Electron assigned. (Whether the view also
    // routes the URL in-place is a foreground-disposition behavior: the pure decision is
    // unit-tested in windowOpen.test.ts and the wc.loadURL wiring in viewController.test.ts;
    // not asserted here to keep this hermetic.) Poll briefly
    // to let the async open attempt be processed, then assert the count is still the baseline.
    await expect.poll(async () => app.windows().length, { timeout: 5000 }).toBe(baseline);
    expect(app.windows().length).toBe(baseline);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('popunder window.open to a disallowed scheme is denied without routing (no new window)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-disallowed-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const fixtureUrl = `${fixtures.baseUrl}/popup/popunder-disallowed.html`;
    await navigateAndSettle(app, fixtureUrl);

    const baseline = app.windows().length;

    // The window.open('aegis-bad://...', '_blank') is denied and NOT routed in-place
    // (disallowed scheme), so the content view stays on the fixture. Give the async
    // open attempt time to be processed, then assert the URL is UNCHANGED.
    await expect
      .poll(async () => app.windows().length, { timeout: 5000 })
      .toBe(baseline);
    expect((await state(app)).url).toBe(fixtureUrl);
    expect(app.windows().length).toBe(baseline);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('top-frame redirect to a disallowed scheme is blocked by will-redirect (content unchanged)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-popup-redirect-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const fixtureUrl = `${fixtures.baseUrl}/popup/redirect-hostile.html`;
    await navigateAndSettle(app, fixtureUrl);

    const baseline = app.windows().length;

    // location.href='aegis-bad://...' is a disallowed scheme -> will-navigate/will-redirect
    // preventDefault. The content view never leaves the fixture, and no window opens.
    await expect
      .poll(async () => app.windows().length, { timeout: 5000 })
      .toBe(baseline);
    expect((await state(app)).url).toBe(fixtureUrl);
    // The fixture's own content marker is still present (page did not navigate away).
    const marker = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'document.getElementById("content") ? document.getElementById("content").textContent : ""',
        true,
      ),
    );
    expect(marker).toContain('redirect-hostile');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
