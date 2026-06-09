// electron/test/e2e/boot.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-boot-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    // about:blank is an allowed scheme and needs no network, keeping this spec hermetic.
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
  });
});

test.afterAll(async () => {
  await app.close();
});

test('boots with a content view that loads the home URL and reports state', async () => {
  // Wait for the primary ViewController to exist and finish its first load.
  await expect
    .poll(
      async () =>
        app.evaluate(() => {
          const t = (globalThis as any).__aegisTest;
          if (!t || !t.primary) return null;
          const s = t.primary.getState();
          return s.url;
        }),
      { timeout: 30_000 },
    )
    .toBe('about:blank'); // AEGIS_HOME_URL override; hermetic (no live network)

  const state = await app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
  expect(state.viewId).toBe(1);
  expect(typeof state.url).toBe('string');
  expect(state.crashed).toBe(false);
});

test('the content view is sandboxed (no Node `require` in its main world)', async () => {
  const typeofRequire = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript('typeof require'),
  );
  expect(typeofRequire).toBe('undefined');
});

test('the content view is visible after a successful boot load', async () => {
  const visible = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.isContentVisible(),
  );
  expect(visible).toBe(true);
});
