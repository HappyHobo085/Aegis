// electron/test/e2e/downloads.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startFixtureServer, type FixtureServer } from './fixtureServer';
import type { NavState, DownloadEntry } from '../../../shared/types';

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

/** Click the fixture's download anchor from the content main world. */
function clickDownload(app: ElectronApplication): Promise<void> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      'window.__aegisClickDownload()',
      true,
    ),
  );
}

function downloadsList(app: ElectronApplication): Promise<DownloadEntry[]> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.downloadsRepo.list());
}

function downloadsClear(app: ElectronApplication): Promise<void> {
  return app.evaluate(() => (globalThis as any).__aegisTest.phase5.downloadsRepo.clear());
}

test('a real fixture download saves to downloadDir, records a completed DownloadsRepo row, and lands on disk', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-downloads-'));
  // A dedicated download target dir so the assertion is hermetic (not the OS Downloads).
  const dlDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-dldir-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Point the downloadDir setting at our temp dir so the will-download handler
    // resolves the save path there (resolveDownloadDir(settingDir, osDir)).
    await app.evaluate(
      (_e, d) => (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: d }),
      dlDir,
    );

    await navigateAndSettle(app, `${fixtures.baseUrl}/downloads/page.html`);
    await clickDownload(app);

    // The will-download handler records a row immediately (state 'progressing'),
    // then item.on('done') flips it to 'completed'. Poll for the terminal state.
    await expect
      .poll(
        async () => {
          const rows = await downloadsList(app);
          const row = rows.find((r) => r.filename === 'big.bin');
          return row?.state ?? null;
        },
        { timeout: 15000 },
      )
      .toBe('completed');

    const rows = await downloadsList(app);
    const row = rows.find((r) => r.filename === 'big.bin')!;
    expect(row.url).toBe(`${fixtures.baseUrl}/downloads/big.bin`);
    expect(row.savePath).toBe(join(dlDir, 'big.bin'));
    expect(row.totalBytes).toBeGreaterThan(0);
    expect(row.receivedBytes).toBe(row.totalBytes);
    expect(typeof row.id).toBe('number');
    expect(row.startedAt).toBeGreaterThan(0);

    // The file physically exists at the resolved save path with the fixture body.
    expect(existsSync(row.savePath)).toBe(true);
    expect(readFileSync(row.savePath, 'utf8')).toContain('AEGIS-DOWNLOAD-FIXTURE-BODY');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});

test('downloads.changed fires on a real download (renderer-visible push) and clear() empties the repo', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-downloads-changed-'));
  const dlDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-dldir2-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await app.evaluate(
      (_e, d) => (globalThis as any).__aegisTest.phase4.settingsRepo.set({ downloadDir: d }),
      dlDir,
    );

    // Subscribe to downloads.changed via the BRIDGED API in the chrome renderer. Only
    // window.aegis is exposed (ipcRenderer is intentionally NOT bridged — see sandbox.spec),
    // so we use aegis.downloads.onChanged (the real preload subscribe path).
    await app.evaluate(({ webContents }) => {
      const chromeId = (globalThis as any).__aegisTest.chromeWcId;
      const wc = webContents.fromId(chromeId)!;
      return wc.executeJavaScript(`
        (() => {
          window.__aegisDownloadsChanged = 0;
          window.aegis.downloads.onChanged(() => {
            window.__aegisDownloadsChanged += 1;
          });
          return true;
        })()
      `);
    });

    await navigateAndSettle(app, `${fixtures.baseUrl}/downloads/page.html`);
    await clickDownload(app);

    // 'updated' + 'done' both call onChanged → at least one push reaches chrome.
    await expect
      .poll(
        async () =>
          app.evaluate(({ webContents }) => {
            const chromeId = (globalThis as any).__aegisTest.chromeWcId;
            return webContents
              .fromId(chromeId)!
              .executeJavaScript('window.__aegisDownloadsChanged');
          }),
        { timeout: 15000 },
      )
      .toBeGreaterThan(0);

    // Wait for the row to settle so clear() has something to remove.
    await expect
      .poll(async () => (await downloadsList(app)).length, { timeout: 15000 })
      .toBeGreaterThan(0);

    await downloadsClear(app);
    expect(await downloadsList(app)).toEqual([]);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(dlDir, { recursive: true, force: true });
  }
});
