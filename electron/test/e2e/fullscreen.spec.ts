// electron/test/e2e/fullscreen.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME_TOP_HEIGHT = 96; // TOOLBAR_H (56) + FAVBAR_H (40)
const FULLSCREEN_CORNER = 44; // must match FULLSCREEN_CORNER in window.ts

interface Bounds { x: number; y: number; width: number; height: number; }

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
          return ''; // transient startup race — let poll retry
        }
      },
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

/** Content WebContentsView bounds. */
function contentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.getBounds(),
  );
}

/** Chrome view bounds. */
function chromeBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.view.chromeBounds(),
  );
}

/** Whether the chrome view is the topmost child (z-order). */
function isChromeOnTop(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.view.isChromeOnTop(),
  );
}

/** Window content bounds (for winW/winH). */
function windowContentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(({ BaseWindow }) =>
    BaseWindow.getAllWindows()[0].getContentBounds(),
  );
}

/** Click an element inside the chrome WebContents (toolbar, exit button, etc.). */
function clickInChrome(app: ElectronApplication, selector: string): Promise<unknown> {
  return app.evaluate(({ webContents }, sel) => {
    const chromeId = (globalThis as any).__aegisTest.chromeWcId;
    const wc = webContents.fromId(chromeId)!;
    return wc.executeJavaScript(
      `document.querySelector(${JSON.stringify(sel)}).click()`,
      true,
    );
  }, selector);
}

test('boot: content has top inset of 96 and chrome covers the full window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fs-boot-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Content view should sit below the chrome (y === 96).
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(CHROME_TOP_HEIGHT);
    expect((await contentBounds(app)).x).toBe(0);

    // Chrome view fills the entire window.
    const win = await windowContentBounds(app);
    const cb = await chromeBounds(app);
    expect(cb.x).toBe(0);
    expect(cb.y).toBe(0);
    expect(cb.width).toBe(win.width);
    expect(cb.height).toBe(win.height);

    // Normal state: content view is on top (chrome is below), not overlay mode.
    expect(await isChromeOnTop(app)).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('enter fullscreen: content fills window, chrome shrinks to top-right corner', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fs-enter-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Wait for boot to settle.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(CHROME_TOP_HEIGHT);

    const win = await windowContentBounds(app);

    // Click the toolbar fullscreen button in the chrome WC.
    await clickInChrome(app, '.toolbar__fullscreen');

    // Content view must fill the whole window.
    await expect
      .poll(async () => {
        const b = await contentBounds(app);
        return b.x === 0 && b.y === 0 && b.width === win.width && b.height === win.height;
      }, { timeout: 15000 })
      .toBe(true);

    // Chrome view shrinks to the top-right corner.
    const cb = await chromeBounds(app);
    expect(cb.x).toBe(win.width - FULLSCREEN_CORNER);
    expect(cb.y).toBe(0);
    expect(cb.width).toBe(FULLSCREEN_CORNER);
    expect(cb.height).toBe(FULLSCREEN_CORNER);

    // Chrome (corner) is now on top so the exit button is clickable.
    expect(await isChromeOnTop(app)).toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('exit fullscreen via corner button: content inset restored, chrome fills window', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-fs-exit-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // Wait for boot.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(CHROME_TOP_HEIGHT);

    const win = await windowContentBounds(app);

    // Enter fullscreen.
    await clickInChrome(app, '.toolbar__fullscreen');
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(0);

    // Exit via the corner exit button (rendered by the chrome view in fullscreen).
    await clickInChrome(app, '.fullscreen-exit');

    // Content y must revert to the normal top inset.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(CHROME_TOP_HEIGHT);

    // Content x stays 0.
    expect((await contentBounds(app)).x).toBe(0);

    // Chrome view restores to full window.
    const cb = await chromeBounds(app);
    expect(cb.x).toBe(0);
    expect(cb.y).toBe(0);
    expect(cb.width).toBe(win.width);
    expect(cb.height).toBe(win.height);

    // Chrome is no longer forced to top (back to normal z-order).
    expect(await isChromeOnTop(app)).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
