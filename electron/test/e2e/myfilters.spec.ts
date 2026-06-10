// electron/test/e2e/myfilters.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, AdblockState, ListUpdateResult } from '../../../shared/types';

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

/** Read a JS expression in the content view's MAIN world. */
function readContent<T>(app: ElectronApplication, expr: string): Promise<T> {
  return app.evaluate(
    (_e, e) =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(e, true),
    expr,
  );
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

function setCustomFilters(app: ElectronApplication, text: string): Promise<string> {
  return app.evaluate((_e, t) => {
    (globalThis as any).__aegisTest.phase4.customFiltersRepo.set(t);
    return (globalThis as any).__aegisTest.phase4.customFiltersRepo.get();
  }, text);
}

function rebuildFromCache(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => {
    (globalThis as any).__aegisTest.phase4.rebuildFromCache();
  });
}

test('a custom COSMETIC my-filter hides a fixture element after rebuild (merge path proven)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-cosmetic-'));
  // LIST_BASE so updateNow populates caches; the fixture list has NO cosmetic rules,
  // so any hiding must come from the merged custom-filters text.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    // Populate the per-listId caches (rebuildEngineFromCache reads them).
    const result = await updateNow(app);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // Baseline: with no custom filters the sentinel is visible (300x250 red block).
    await navigateAndSettle(app, `${fixtures.baseUrl}/cosmetic/sentinel.html`);
    const baselineDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('.aegis-ad-sentinel')).display",
    );
    expect(baselineDisplay).not.toBe('none');

    // Save a domain-scoped cosmetic my-filter (domain-scoped, NOT generic — contract §1.3
    // caveat: generic bare ##.x depends on loadGenericCosmeticsFilters; 127.0.0.1##.x is
    // unaffected). Then cache-rebuild → engine = [cached list texts, customFilters].
    await setCustomFilters(app, '127.0.0.1##.aegis-ad-sentinel');
    await rebuildFromCache(app);

    // The rebuilt engine swaps on the next nav; cosmetic CSS injects asynchronously.
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

    // The non-ad content marker stays visible (rule is scoped, not a blanket hide).
    const markerDisplay = await readContent<string>(
      app,
      "getComputedStyle(document.querySelector('#content-marker')).display",
    );
    expect(markerDisplay).not.toBe('none');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a custom NETWORK my-filter blocks a request the fixture list allows', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-network-'));
  // The fixture easylist blocks /ads/tracker.js^ only — it does NOT block /ads/banner.js.
  // So blocking banner.js after a my-filters save proves the custom rule was merged in.
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_LIST_BASE: `${fixtures.baseUrl}/lists`,
  });
  try {
    const result = await updateNow(app);
    expect(result.perSource.every((s) => s.ok === true)).toBe(true);

    // Baseline: ad-page.html sets window.__adLoaded=false then loads /ads/banner.js, which
    // sets window.__adLoaded=true when it runs. The fixture easylist blocks /ads/tracker.js
    // only — NOT banner.js — so banner.js loads and the marker becomes true.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect(await adLoaded(app, '__adLoaded')).toBe(true); // NOT blocked by the fixture list

    // Save a custom network my-filter that blocks banner.js, then cache-rebuild.
    await setCustomFilters(app, '/ads/banner.js^');
    await rebuildFromCache(app);

    // The merged engine swaps on the next nav → banner.js is blocked → marker stays false.
    await navigateAndSettle(app, `${fixtures.baseUrl}/ad-page.html`);
    expect(await adLoaded(app, '__adLoaded')).toBe(false); // blocked by the custom rule
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allowlist removeAllowlist/clearAllowlist are reflected in AdblockState', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-myfilters-allowlist-'));
  const app = await launchApp(dir, {
    AEGIS_HOME_URL: 'about:blank',
    AEGIS_ADBLOCK_OFFLINE: '1',
  });
  try {
    // Seed three allowlisted hosts via the existing toggle (add half).
    const hosts = ['a.example', 'b.example', 'c.example'];
    for (const h of hosts) {
      await app.evaluate(
        (_e, host) => (globalThis as any).__aegisTest.adblock.controller.toggleAllowlist(host),
        h,
      );
    }
    let st: AdblockState = await app.evaluate(() =>
      (globalThis as any).__aegisTest.adblock.controller.getState(),
    );
    for (const h of hosts) expect(st.allowlistedHosts).toContain(h);

    // removeAllowlist(one host) → returns AdblockState without that host; others remain.
    st = await app.evaluate(
      (_e, host) => (globalThis as any).__aegisTest.adblock.controller.removeAllowlist(host),
      'b.example',
    );
    expect(st.allowlistedHosts).not.toContain('b.example');
    expect(st.allowlistedHosts).toContain('a.example');
    expect(st.allowlistedHosts).toContain('c.example');

    // clearAllowlist() → returns AdblockState with an empty allowlist.
    st = await app.evaluate(() =>
      (globalThis as any).__aegisTest.adblock.controller.clearAllowlist(),
    );
    expect(st.allowlistedHosts).toEqual([]);
    expect(st.enabled).toBe(true); // global enabled state untouched by allowlist ops
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
