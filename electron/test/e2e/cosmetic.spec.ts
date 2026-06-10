// electron/test/e2e/cosmetic.spec.ts
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

/** Read a JS expression in the content view's MAIN world. */
function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
}

test('cosmetic: generic + per-host sentinels end hidden; content marker stays visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-cosmetic-'));
  // Two cosmetic rules: a generic class hide + a 127.0.0.1-scoped class hide.
  // Multi-line filter (Block A Task 2 hook splits on \n).
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: '##.aegis-ad-sentinel\n127.0.0.1##.aegis-ad-sentinel-host',
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);

    // Engine cosmetic CSS injects via preload->main insertCSS asynchronously; poll the
    // computed display of each sentinel until the hide lands.
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

    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.aegis-ad-sentinel-host')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');

    // Rendered height collapses to zero for both (belt-and-braces on the visual gate).
    const genericHeight = await readContent<number>(
      app,
      "document.querySelector('.aegis-ad-sentinel').getBoundingClientRect().height",
    );
    expect(genericHeight).toBe(0);
    const hostHeight = await readContent<number>(
      app,
      "document.querySelector('.aegis-ad-sentinel-host').getBoundingClientRect().height",
    );
    expect(hostHeight).toBe(0);

    // The non-ad content marker is untouched and visibly rendered.
    const markerDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(markerDisplay).not.toBe('none');
    const markerHeight = await readContent<number>(
      app,
      "document.querySelector('#content-marker').getBoundingClientRect().height",
    );
    expect(markerHeight).toBeGreaterThan(0);

    // ---- Report-only no-flash probe (NEVER asserts pass/fail) ----
    // The fixture records the timestamp of its first paint entry; we read it alongside
    // the moment the sentinel's computed display first became 'none' (captured by the
    // fixture's own observer). Log the delta for visibility; do not gate on it.
    const probe = await readContent<{ firstPaint: number | null; hiddenAt: number | null }>(
      app,
      'JSON.stringify({ firstPaint: window.__aegisFirstPaint ?? null, hiddenAt: window.__aegisSentinelHiddenAt ?? null })',
    ).then((s) => JSON.parse(s as unknown as string));
    const delta =
      probe.firstPaint !== null && probe.hiddenAt !== null
        ? probe.hiddenAt - probe.firstPaint
        : null;
    // eslint-disable-next-line no-console
    console.log(
      `[no-flash report-only] firstPaint=${probe.firstPaint} hiddenAt=${probe.hiddenAt} ` +
        `applyMinusPaintMs=${delta} (report-only; not asserted)`,
    );
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
