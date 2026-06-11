// electron/test/e2e/permissions.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, SitePermission } from '../../../shared/types';

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

function permsList(app: ElectronApplication): Promise<SitePermission[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.permissionsRepo.list());
}

function permsSet(
  app: ElectronApplication,
  origin: string,
  permission: string,
  decision: 'allow' | 'deny',
): Promise<void> {
  return app.evaluate(
    (_e, a) =>
      (globalThis as any).__aegisTest.phase5.permissionsRepo.set(a.origin, a.permission, a.decision),
    { origin, permission, decision },
  );
}

test('a remembered geolocation ALLOW is auto-answered for the content WC (request handler honors PermissionsRepo)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-allow-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const origin = fixtures.baseUrl; // http://127.0.0.1:<port>
    // Pre-seed the remembered decision; wirePermissions' request handler reads it and
    // resolves the callback without raising a prompt.
    await permsSet(app, origin, 'geolocation', 'allow');
    expect(
      (await permsList(app)).some(
        (p) => p.origin === origin && p.permission === 'geolocation' && p.decision === 'allow',
      ),
    ).toBe(true);

    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);

    // Real getCurrentPosition: with the remembered ALLOW, the request handler resolves
    // callback(true); geolocation then either succeeds OR fails with a NON-permission
    // error (POSITION_UNAVAILABLE / TIMEOUT in a headless env). It must NOT be
    // PERMISSION_DENIED (code 1), which is what a deny would produce.
    const outcome = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `new Promise((resolve) => {
           navigator.geolocation.getCurrentPosition(
             () => resolve({ ok: true, code: null }),
             (err) => resolve({ ok: false, code: err.code }),
             { timeout: 4000 },
           );
         })`,
        true,
      ),
    );
    expect((outcome as { ok: boolean; code: number | null }).code).not.toBe(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a remembered geolocation DENY is auto-answered as PERMISSION_DENIED (code 1)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-deny-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const origin = fixtures.baseUrl;
    await permsSet(app, origin, 'geolocation', 'deny');

    await navigateAndSettle(app, `${fixtures.baseUrl}/spa.html`);

    const outcome = await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `new Promise((resolve) => {
           navigator.geolocation.getCurrentPosition(
             () => resolve({ ok: true, code: null }),
             (err) => resolve({ ok: false, code: err.code }),
             { timeout: 4000 },
           );
         })`,
        true,
      ),
    );
    // A remembered deny → callback(false) → the renderer sees PERMISSION_DENIED.
    expect((outcome as { ok: boolean; code: number | null }).code).toBe(1);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a remembered decision survives an app restart (persisted in site_permissions)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-perms-persist-'));
  const origin = fixtures.baseUrl;
  const app1 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await permsSet(app1, origin, 'notifications', 'allow');
    expect(
      (await permsList(app1)).some(
        (p) => p.origin === origin && p.permission === 'notifications' && p.decision === 'allow',
      ),
    ).toBe(true);
  } finally {
    await app1.close();
  }
  const app2 = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(
        async () =>
          (await permsList(app2)).some(
            (p) =>
              p.origin === origin && p.permission === 'notifications' && p.decision === 'allow',
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
