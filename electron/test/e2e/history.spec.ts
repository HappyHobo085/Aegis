// electron/test/e2e/history.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, HistoryEntry } from '../../../shared/types';

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

/** Reads through the constructed HistoryRepo inside the booted app (§9.1). */
function historyList(app: ElectronApplication): Promise<HistoryEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.list());
}

function historySearch(app: ElectronApplication, q: string): Promise<HistoryEntry[]> {
  return app.evaluate(
    (_e, query) => (globalThis as any).__aegisTest.places.historyRepo.search(query),
    q,
  );
}

function historyMostRecent(
  app: ElectronApplication,
): Promise<HistoryEntry | undefined> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.places.historyRepo.mostRecent(),
  );
}

function historyRemove(app: ElectronApplication, id: number): Promise<void> {
  return app.evaluate(
    (_e, rowId) => (globalThis as any).__aegisTest.places.historyRepo.remove(rowId),
    id,
  );
}

function historyClear(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.historyRepo.clear());
}

/** Poll until a history row for `url` exists, return it. */
async function waitForEntry(
  app: ElectronApplication,
  url: string,
): Promise<HistoryEntry> {
  await expect
    .poll(async () => (await historyList(app)).some((e) => e.url === url), {
      timeout: 15000,
    })
    .toBe(true);
  return (await historyList(app)).find((e) => e.url === url)!;
}

test('a real top-frame navigation auto-records a history entry with url + title', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-record-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const url = `${fixtures.baseUrl}/spa.html`;
    await navigateAndSettle(app, url);

    const entry = await waitForEntry(app, url);
    expect(entry.url).toBe(url);
    // page-title-updated → setMostRecentTitle fills in the document title.
    await expect
      .poll(async () => (await waitForEntry(app, url)).title, { timeout: 15000 })
      .toBe('SPA Fixture');

    // about:blank (non-http) is NOT recorded.
    expect((await historyList(app)).some((e) => e.url === 'about:blank')).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('history search filters by url/title; remove drops a row; clear empties the list', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-ops-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;
    await navigateAndSettle(app, aUrl);
    await waitForEntry(app, aUrl);
    await navigateAndSettle(app, bUrl);
    await waitForEntry(app, bUrl);

    // search: 'late-title' matches only the B url.
    const hits = await historySearch(app, 'late-title');
    expect(hits.map((e) => e.url)).toEqual([bUrl]);

    // list newest-first: B before A.
    const list = await historyList(app);
    expect(list.map((e) => e.url)).toEqual([bUrl, aUrl]);

    // remove the A row → only B remains.
    const aRow = list.find((e) => e.url === aUrl)!;
    await historyRemove(app, aRow.id);
    await expect
      .poll(async () => (await historyList(app)).map((e) => e.url), { timeout: 15000 })
      .toEqual([bUrl]);

    // clear → empty.
    await historyClear(app);
    await expect
      .poll(async () => (await historyList(app)).length, { timeout: 15000 })
      .toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('revisiting the most-recent URL dedups (updates visitedAt) instead of inserting', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-history-dedup-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    // Visit A then B → two rows, B most-recent.
    await navigateAndSettle(app, aUrl);
    await waitForEntry(app, aUrl);
    await navigateAndSettle(app, bUrl);
    await waitForEntry(app, bUrl);
    expect((await historyList(app)).length).toBe(2);

    // Re-navigate to A (the view is NOT currently on A → this is a genuine nav,
    // recorded as a NEW most-recent A row distinct from the older A).
    await navigateAndSettle(app, aUrl);
    await expect
      .poll(async () => (await historyMostRecent(app))?.url, { timeout: 15000 })
      .toBe(aUrl);
    expect((await historyList(app)).length).toBe(3);

    // §9.2: same-URL reload of A. navigateAndSettle is racy here (already on A),
    // so capture the current most-recent visitedAt, force a reload, then gate on
    // the dedup signal: row count UNCHANGED + most-recent visitedAt ADVANCED.
    const beforeRow = await historyMostRecent(app);
    const beforeAt = beforeRow!.visitedAt;
    const beforeCount = (await historyList(app)).length;

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.reloadOrStop());

    // Dedup vs most-recent: no new row inserted; the A row's visitedAt advances.
    await expect
      .poll(async () => (await historyMostRecent(app))?.visitedAt ?? 0, {
        timeout: 15000,
      })
      .toBeGreaterThan(beforeAt);
    expect((await historyMostRecent(app))?.url).toBe(aUrl);
    expect((await historyList(app)).length).toBe(beforeCount);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
