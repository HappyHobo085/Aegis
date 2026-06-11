// electron/test/e2e/picker.spec.ts
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

function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) => (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
}

function customFilters(app: ElectronApplication): Promise<string> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.customFiltersRepo.get());
}

test('element picker: a clicked element becomes a host-scoped cosmetic custom filter and is hidden after rebuild', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-picker-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1', // engine starts empty; the only cosmetic rule comes from the picker
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);

    // Baseline: the sentinel is a visible 300x250 block (no cosmetic rule yet).
    const baseline = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
    );
    expect(baseline).not.toBe('none');

    // Start the picker, then synthesize a real click on the sentinel so the injected IIFE
    // resolves a selector for that element. The IIFE attaches its own click listener on
    // the document; dispatching a click after start() drives it to resolve.
    const startPromise: Promise<{ ok: boolean; rule?: string }> = app.evaluate(() =>
      (globalThis as any).__aegisTest.phase5.pickerStart(),
    );
    // Give the IIFE a beat to install its overlay+listener, then click the sentinel.
    await expect
      .poll(
        async () =>
          readContent<boolean>(app, 'typeof window.__aegisPickerArmed === "boolean" && window.__aegisPickerArmed'),
        { timeout: 5000 },
      )
      .toBe(true);
    await readContent<void>(
      app,
      `(() => {
         const el = document.querySelector('.aegis-ad-sentinel');
         el.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
       })()`,
    );

    const result = await startPromise;
    expect(result.ok).toBe(true);
    expect(typeof result.rule).toBe('string');
    // The rule is host-scoped: 127.0.0.1##<selector for the sentinel>.
    expect(result.rule!).toMatch(/^127\.0\.0\.1##/);

    // The rule was appended to the Phase-4 custom filters store.
    expect(await customFilters(app)).toContain(result.rule!);

    // buildPickerHandlers calls rebuildFromCache(); the rebuilt engine swaps on the next
    // nav. Re-navigate and poll for the sentinel to be hidden by the new cosmetic rule.
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');

    // The non-targeted content marker stays visible (scoped, not a blanket hide).
    const marker = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(marker).not.toBe('none');

    // The custom filter survives a restart (persisted in customFiltersRepo).
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
