// electron/test/e2e/antiadblock.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState } from '../../../shared/types';

let fixtures: FixtureServer;

// The committed fixture scriptlet resources (SEPARATE from electron/test/fixtures/lists/resources.json).
// Read here and passed inline through AEGIS_ADBLOCK_TEST_RESOURCES (content, not a path).
const RESOURCES_JSON = readFileSync(
  join(__dirname, '..', 'fixtures', 'antiadblock', 'resources.json'),
  'utf8',
);

// The detector-defusing filter set (multi-line; Block A Task 2 hook splits on \n):
//  - scriptlet rule forcing adblockDetected=false,
//  - scriptlet rule making the bait global read undefined,
//  - a cosmetic rule removing the "disable your ad blocker" wall element.
const TEST_FILTER = [
  '127.0.0.1##+js(aegis-set-false)',
  '127.0.0.1##+js(aegis-no-bait)',
  '127.0.0.1##.adblock-wall',
].join('\n');

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

// One app per detector fixture so each scriptlet/cosmetic set is exercised in isolation.

test('antiadblock: set-constant defuser keeps content visible (adblockDetected forced false)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-setfalse-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/set-false-detector.html`);
    // Re-checkable end-state: the detector re-evaluates adblockDetected on a rAF loop and
    // sets #content display:block (visible) when it stays false. Poll until visible.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('#content')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('block');
    // And the wall the detector would have shown stays hidden.
    const wallDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#wall')).display",
    );
    expect(wallDisplay).toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antiadblock: property-read-returns-undefined defuser keeps content visible (bait reads undefined)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-bait-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/bait-undefined-detector.html`);
    // Re-checkable end-state: detector reads window.aegisBait on a rAF loop; while it is
    // undefined it keeps #content visible and #wall hidden. Poll the visible end-state.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('#content')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('block');
    const wallDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#wall')).display",
    );
    expect(wallDisplay).toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('antiadblock: cosmetic rule removes the "disable your ad blocker" wall; content visible', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-aab-wall-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_TEST_FILTER: TEST_FILTER,
    AEGIS_ADBLOCK_TEST_RESOURCES: RESOURCES_JSON,
  });
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/antiadblock/cosmetic-wall.html`);
    // Re-checkable end-state: the cosmetic rule 127.0.0.1##.adblock-wall hides the wall
    // via injected user-CSS (async). Poll the wall's computed display to 'none'.
    await expect
      .poll(
        async () =>
          readContent<string>(
            app,
            "getComputedStyle(document.querySelector('.adblock-wall')).display",
          ),
        { timeout: 15000 },
      )
      .toBe('none');
    // Primary content underneath is rendered.
    const contentHeight = await readContent<number>(
      app,
      "document.querySelector('#content').getBoundingClientRect().height",
    );
    expect(contentHeight).toBeGreaterThan(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
