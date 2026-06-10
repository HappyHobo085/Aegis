// electron/test/e2e/saved.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { SavedItem } from '../../../shared/types';

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

/** Drive the constructed SavedRepo inside the booted app (§9.1). */
function savedAdd(
  app: ElectronApplication,
  input: { url: string; title: string },
): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, i) => (globalThis as any).__aegisTest.places.savedRepo.add(i),
    input,
  );
}

function savedList(app: ElectronApplication): Promise<SavedItem[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.places.savedRepo.list());
}

function savedHas(app: ElectronApplication, url: string): Promise<boolean> {
  return app.evaluate(
    (_e, u) => (globalThis as any).__aegisTest.places.savedRepo.has(u),
    url,
  );
}

function savedRemove(app: ElectronApplication, id: number): Promise<SavedItem[]> {
  return app.evaluate(
    (_e, rowId) => (globalThis as any).__aegisTest.places.savedRepo.remove(rowId),
    id,
  );
}

test('saved-list add → has(url) true; remove → has(url) false (the bookmark toggle path)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-saved-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    const aUrl = `${fixtures.baseUrl}/spa.html`;
    const bUrl = `${fixtures.baseUrl}/late-title.html`;

    // Before save: not present.
    expect(await savedHas(app, aUrl)).toBe(false);

    // Add A and B (BookmarkButton onSave path → saved.addCurrent → savedRepo.add).
    let list = await savedAdd(app, { url: aUrl, title: 'Alpha' });
    expect(list.map((s) => s.url)).toEqual([aUrl]);
    list = await savedAdd(app, { url: bUrl, title: 'Beta' });
    // ORDER BY savedAt DESC → most-recently-saved first.
    expect(list.map((s) => s.url)).toEqual([bUrl, aUrl]);

    // has() fills-in the bookmark button for a saved page.
    expect(await savedHas(app, aUrl)).toBe(true);
    expect(await savedHas(app, bUrl)).toBe(true);
    expect(await savedHas(app, `${fixtures.baseUrl}/never-saved.html`)).toBe(false);

    // Remove A (onUnsave path → saved.removeCurrent → savedRepo.remove) → only B remains.
    const aRow = (await savedList(app)).find((s) => s.url === aUrl)!;
    const afterRemove = await savedRemove(app, aRow.id);
    expect(afterRemove.map((s) => s.url)).toEqual([bUrl]);
    expect(await savedHas(app, aUrl)).toBe(false);
    expect(await savedHas(app, bUrl)).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
