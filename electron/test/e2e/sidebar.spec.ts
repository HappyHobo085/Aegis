// electron/test/e2e/sidebar.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror src/lib/layout.ts (Task 14): the renderer computes the inset from these
// constants and the e2e asserts the resulting content WebContentsView bounds.
const TOOLBAR_H = 56;
const FAVBAR_H = 40;
const SIDEBAR_W = 280;
const TOP_INSET = TOOLBAR_H + FAVBAR_H; // 96, favbar always-on (§8.5)

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

interface Bounds { x: number; y: number; width: number; height: number; }

/** Content WebContentsView bounds (View.getBounds() exists on the base class — §9.1). */
function contentBounds(app: ElectronApplication): Promise<Bounds> {
  return app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.getBounds(),
  );
}

/** Drive the boot-side inset closure directly (§8.5 / §9.1). */
function setContentInset(
  app: ElectronApplication,
  top: number,
  left: number,
): Promise<void> {
  return app.evaluate(
    (_e, args) =>
      (globalThis as any).__aegisTest.places.setContentInset(args.top, args.left),
    { top, left },
  );
}

test('content top inset is TOOLBAR_H+FAVBAR_H on boot (favorites bar always-on)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-top-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // The renderer reports the favbar-inclusive top inset on mount; poll until applied.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    // Sidebar closed on boot → left bound at 0.
    expect((await contentBounds(app)).x).toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening the sidebar insets content left by SIDEBAR_W; closing restores it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-toggle-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    const closed = await contentBounds(app);
    expect(closed.x).toBe(0);

    // Open the sidebar (useContentInset reports left = SIDEBAR_W).
    await setContentInset(app, TOP_INSET, SIDEBAR_W);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);
    const open = await contentBounds(app);
    // Content shifts right by SIDEBAR_W and narrows by the same amount; top unchanged.
    expect(open.x).toBe(SIDEBAR_W);
    expect(open.width).toBe(closed.width - SIDEBAR_W);
    expect(open.y).toBe(TOP_INSET);

    // Close the sidebar → left inset restored to 0, full width back.
    await setContentInset(app, TOP_INSET, 0);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(0);
    const reclosed = await contentBounds(app);
    expect(reclosed.x).toBe(0);
    expect(reclosed.width).toBe(closed.width);
    expect(reclosed.y).toBe(TOP_INSET);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a window resize keeps the active inset (top/left preserved, width tracks the window)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-resize-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);

    // Open the sidebar, then resize the window: the stored inset must re-apply.
    await setContentInset(app, TOP_INSET, SIDEBAR_W);
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);

    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      const [w, h] = win.getSize();
      win.setSize(w - 120, h - 80);
    });

    // After resize the inset is preserved: x still SIDEBAR_W, y still TOP_INSET,
    // width = newWindowWidth - SIDEBAR_W (content tracks the narrower window).
    await expect
      .poll(async () => (await contentBounds(app)).x, { timeout: 15000 })
      .toBe(SIDEBAR_W);
    const after = await contentBounds(app);
    expect(after.y).toBe(TOP_INSET);
    const winW = await app.evaluate(({ BaseWindow }) => {
      return BaseWindow.getAllWindows()[0].getContentBounds().width;
    });
    expect(after.width).toBe(winW - SIDEBAR_W);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
