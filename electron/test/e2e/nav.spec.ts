// electron/test/e2e/nav.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startFixtureServer,
  startCertServer,
  type FixtureServer,
} from './fixtureServer';
import type { NavState } from '../../../shared/types';

let fixtures: FixtureServer;
let certs: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  certs = await startCertServer();
});

test.afterAll(async () => {
  await fixtures.close();
  await certs.close();
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

function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(
    (_e, u) => {
      (globalThis as any).__aegisTest.primary.navigate(u);
    },
    url,
  );
}

async function navigateAndSettle(
  app: ElectronApplication,
  url: string,
): Promise<void> {
  await navigate(app, url);
  await expect
    .poll(async () => (await state(app)).url, { timeout: 15000 })
    .toBe(url);
  await expect
    .poll(async () => (await state(app)).isLoading, { timeout: 15000 })
    .toBe(false);
}

test('SPA pushState/replaceState/hashchange update the URL without a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-spa-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const spaUrl = `${fixtures.baseUrl}/spa.html`;
    await navigateAndSettle(app, spaUrl);

    // pushState
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaPush("/spa.html?p=1")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=1`);
    // In-page nav must NOT trigger a reload.
    expect((await state(app)).isLoading).toBe(false);

    // replaceState
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaReplace("/spa.html?p=2")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=2`);

    // hashchange
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaHash("section")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=2#section`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('back/forward enablement flips across a back/forward sequence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-bf-'));
  const a = `${fixtures.baseUrl}/spa.html`;
  const b = `${fixtures.baseUrl}/late-title.html`;
  // Boot directly to `a` so it is the very first (and only) loadURL — no prior
  // history entry, so canGoBack must be false after the initial boot load.
  const app = await launchApp(dir, { AEGIS_HOME_URL: a });
  try {
    // The app has already navigated to `a` on boot; wait for it to settle.
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(a);
    await expect
      .poll(async () => (await state(app)).isLoading, { timeout: 10000 })
      .toBe(false);
    expect((await state(app)).canGoBack).toBe(false);

    await navigateAndSettle(app, b);
    expect((await state(app)).canGoBack).toBe(true);
    expect((await state(app)).canGoForward).toBe(false);

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.back());
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(a);
    expect((await state(app)).canGoForward).toBe(true);

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.forward());
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(b);
    expect((await state(app)).canGoForward).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-URL title burst coalesces to one trailing title after the debounce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-title-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/late-title.html`);
    // The burst (5 changes @20ms) finishes well within the 400ms debounce window;
    // only the final trailing title should land in nav state.
    await expect
      .poll(async () => (await state(app)).title, { timeout: 10000 })
      .toBe('final-title');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-process crash shows overlay state and hides the content view; Retry restores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-crash-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const crashUrl = `${fixtures.baseUrl}/crash.html`;
    await navigateAndSettle(app, crashUrl);
    expect(
      await app.evaluate(() =>
        (globalThis as any).__aegisTest.primary.isContentVisible(),
      ),
    ).toBe(true);

    // Force render-process-gone via OS SIGKILL on the renderer PID.
    // NOTE: forcefullyCrashRenderer() does not fire render-process-gone in
    // Electron 42 (the IPC-based crash mechanism no longer emits the event);
    // killing the process directly with SIGKILL causes Electron to detect the
    // OS-level death and correctly emit render-process-gone (reason: 'killed').
    const rendererPid = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.getOSProcessId(),
    );
    execSync(`kill -9 ${rendererPid}`);

    await expect
      .poll(async () => (await state(app)).crashed, { timeout: 10000 })
      .toBe(true);
    expect(
      await app.evaluate(() =>
        (globalThis as any).__aegisTest.primary.isContentVisible(),
      ),
    ).toBe(false);

    // Retry path == reloadOrStop (recovery re-show): clears crashed, re-shows content.
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.reloadOrStop(),
    );
    await expect
      .poll(async () => (await state(app)).crashed, { timeout: 15000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          app.evaluate(() =>
            (globalThis as any).__aegisTest.primary.isContentVisible(),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TLS certificate error hard-fails to a cert overlay (nav.failed kind=cert)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-cert-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Capture nav.failed forwarded to the chrome renderer's ipc.
    await navigate(app, `${certs.baseUrl}/spa.html`);
    // Self-signed → ERR_CERT_AUTHORITY_INVALID (-202), cert range → onFailed(kind:'cert')
    // → content hidden. We observe the observable consequences: content hidden and the
    // state URL did NOT become the https cert URL (hard fail, no click-through).
    await expect
      .poll(
        async () =>
          app.evaluate(() =>
            (globalThis as any).__aegisTest.primary.isContentVisible(),
          ),
        { timeout: 15000 },
      )
      .toBe(false);
    expect((await state(app)).url.startsWith(certs.baseUrl)).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session restore reopens the last URL on relaunch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-restore-'));
  const lastUrl = `${fixtures.baseUrl}/late-title.html`;
  const app1 = await launchApp(dir);
  try {
    await navigateAndSettle(app1, lastUrl);
  } finally {
    await app1.close();
  }

  // Relaunch with the SAME userData dir → session.json must restore lastUrl.
  const app2 = await launchApp(dir);
  try {
    await expect
      .poll(async () => (await state(app2)).url, { timeout: 15000 })
      .toBe(lastUrl);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
