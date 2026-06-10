// electron/test/e2e/filterlists.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, Subscription, ListUpdateResult } from '../../../shared/types';

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

function adLoaded(app: ElectronApplication, prop: string): Promise<boolean> {
  return app.evaluate(
    (_e, p) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        `window.${p}`,
        true,
      ),
    prop,
  );
}

function updateNow(app: ElectronApplication): Promise<ListUpdateResult> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.updateNow());
}

function subsAll(app: ElectronApplication): Promise<Subscription[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase4.subsRepo.all());
}

function subsSetEnabled(
  app: ElectronApplication,
  listId: string,
  enabled: boolean,
): Promise<Subscription[]> {
  return app.evaluate(
    (_e, a) => {
      (globalThis as any).__aegisTest.phase4.subsRepo.setEnabled(a.listId, a.enabled);
      return (globalThis as any).__aegisTest.phase4.subsRepo.all();
    },
    { listId, enabled },
  );
}

function subsAdd(app: ElectronApplication, url: string): Promise<Subscription[]> {
  return app.evaluate((_e, u) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.add(u);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, url);
}

function subsRemove(app: ElectronApplication, listId: string): Promise<Subscription[]> {
  return app.evaluate((_e, id) => {
    (globalThis as any).__aegisTest.phase4.subsRepo.remove(id);
    return (globalThis as any).__aegisTest.phase4.subsRepo.all();
  }, listId);
}

function rebuildFromCache(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    (globalThis as any).__aegisTest.phase4.rebuildFromCache();
  });
}

test('disabling a list rebuilds-from-cache WITHOUT its rules (the enabled column is now read)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-filterlists-toggle-'));
  // LIST_BASE serves the fixture easylist (blocks /ads/tracker.js^). No TEST_FILTER, so
  // the initial engine is the bundled snapshot; updateNow fetches the fixture list and
  // populates the per-listId caches that rebuildEngineFromCache reads.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // 1) Real fetch: every default source resolves ok (fixtureServer aliases <id>.txt).
    const result = await updateNow(app);
    expect(result.perSource.length).toBeGreaterThan(0);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // After the swap (applied on next nav) ad B is blocked by the fetched fixture list.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // blocked

    // 2) Disable EVERY subscription, then cache-rebuild. With no enabled rows the
    //    rebuilt engine has only custom filters (empty) → ad B is no longer blocked.
    const rows = await subsAll(app);
    for (const r of rows) {
      await subsSetEnabled(app, r.listId, false);
    }
    expect((await subsAll(app)).every((s) => s.enabled === false)).toBe(true);
    await rebuildFromCache(app);

    // The cache-rebuilt engine swaps in on the next navigation (deferred swap, §1.2).
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(true); // NOT blocked anymore

    // 3) Re-enable, cache-rebuild, navigate → blocking returns from cache (no re-fetch).
    for (const r of rows) {
      await subsSetEnabled(app, r.listId, true);
    }
    await rebuildFromCache(app);
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page-b.html`);
    expect(await adLoaded(app, '__trackerLoaded')).toBe(false); // blocked again
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('adding then removing a custom list URL reflects in subsRepo.all()', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-filterlists-addremove-'));
  const customUrl = `${fixtures.baseUrl}/lists/my-custom-list.txt`;
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1', // no auto-refresh needed; we only mutate the repo
  });
  try {
    const before = await subsAll(app);
    expect(before.some((s) => s.url === customUrl)).toBe(false);

    // add → present in all(), enabled by default.
    const afterAdd = await subsAdd(app, customUrl);
    const added = afterAdd.find((s) => s.url === customUrl);
    expect(added).toBeDefined();
    expect(added!.enabled).toBe(true);

    // remove (by the derived listId) → gone from all().
    const afterRemove = await subsRemove(app, added!.listId);
    expect(afterRemove.some((s) => s.url === customUrl)).toBe(false);
    // The original defaults are untouched.
    expect(afterRemove.length).toBe(before.length);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
