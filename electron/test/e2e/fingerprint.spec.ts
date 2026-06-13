// electron/test/e2e/fingerprint.spec.ts
//
// Asserts that the content view's navigator.userAgent is a mainstream Chrome
// string with no Electron/Aegis token (Phase 4 UA-spoofing).
//
// Note: WebRTC IP-handling policy (default_public_interface_only) has no
// runtime getter and is verified by code review only — it is NOT asserted here.
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';

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

function state(app: ElectronApplication) {
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

/** Read a JS expression in the content view's MAIN world. */
function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
}

test('content navigator.userAgent is a Chrome string with no Electron/Aegis token', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fingerprint-ua-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);

    const ua = await readContent<string>(app, 'navigator.userAgent');

    // Must look like a real Chrome UA.
    expect(ua).toContain('Chrome/');
    expect(ua).toContain('Safari/537.36');

    // Must NOT leak the Electron or Aegis identity.
    expect(ua).not.toMatch(/electron/i);
    expect(ua).not.toMatch(/aegis/i);

    // Should use Chrome's reduced-version format: <major>.0.0.0
    expect(ua).toMatch(/Chrome\/\d+\.0\.0\.0/);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
