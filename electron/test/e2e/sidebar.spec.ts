// electron/test/e2e/sidebar.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Mirror src/lib/layout.ts: the renderer reports a constant top inset (toolbar +
// always-on favbar). The sidebar is a RIGHT OVERLAY (z-order swap), so opening it
// never insets the content view — only the top inset applies (§6 / §8.5).
const TOOLBAR_H = 56;
const FAVBAR_H = 40;
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

/** Drive the overlay z-order swap directly (Task-3 seam: places.setChromeOverlay). */
function setSidebarOpen(app: ElectronApplication, open: boolean): Promise<void> {
  return app.evaluate(
    (_e, o) => (globalThis as any).__aegisTest.places.setChromeOverlay(o),
    open,
  );
}

/** Read whether the transparent chrome view is the top child (overlay active). */
function isChromeOnTop(app: ElectronApplication): Promise<boolean> {
  return app.evaluate(() => (globalThis as any).__aegisTest.view.isChromeOnTop());
}

test('content top inset is TOOLBAR_H+FAVBAR_H on boot (favorites bar always-on)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-top-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    // The renderer reports the favbar-inclusive top inset on mount; poll until applied.
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    // Sidebar is an overlay → content left bound stays at 0 regardless of state.
    expect((await contentBounds(app)).x).toBe(0);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('opening the sidebar overlays content (z-swap) and does NOT inset it', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-overlay-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);
    const closed = await contentBounds(app);
    expect(closed.x).toBe(0);
    // Closed: content view is the top child (normal browsing), chrome is below.
    expect(await isChromeOnTop(app)).toBe(false);

    // Open the sidebar → chrome (transparent, painting scrim + right panel) swaps to top.
    await setSidebarOpen(app, true);
    await expect.poll(() => isChromeOnTop(app), { timeout: 15000 }).toBe(true);
    // The overlay must NOT move/resize the content view: bounds unchanged.
    const open = await contentBounds(app);
    expect(open.x).toBe(0);
    expect(open.width).toBe(closed.width);
    expect(open.y).toBe(TOP_INSET);

    // Close the sidebar → content view swaps back to top; bounds still unchanged.
    await setSidebarOpen(app, false);
    await expect.poll(() => isChromeOnTop(app), { timeout: 15000 }).toBe(false);
    const reclosed = await contentBounds(app);
    expect(reclosed.x).toBe(0);
    expect(reclosed.width).toBe(closed.width);
    expect(reclosed.y).toBe(TOP_INSET);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a window resize preserves the top inset with no content inset on open', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sidebar-resize-'));
  const app = await launchApp(dir, { AEGIS_HOME_URL: 'about:blank' });
  try {
    await expect
      .poll(async () => (await contentBounds(app)).y, { timeout: 15000 })
      .toBe(TOP_INSET);

    // Open the sidebar (overlay), then resize the window: the content view must
    // re-apply the top inset and remain full width (the overlay never insets it).
    await setSidebarOpen(app, true);
    await expect.poll(() => isChromeOnTop(app), { timeout: 15000 }).toBe(true);

    await app.evaluate(({ BaseWindow }) => {
      const win = BaseWindow.getAllWindows()[0];
      const [w, h] = win.getSize();
      win.setSize(w - 120, h - 80);
    });

    // After resize: y still TOP_INSET, x still 0, width tracks the FULL window
    // (content is NOT inset by the overlay).
    const winW = await app.evaluate(({ BaseWindow }) =>
      BaseWindow.getAllWindows()[0].getContentBounds().width,
    );
    await expect
      .poll(async () => (await contentBounds(app)).width, { timeout: 15000 })
      .toBe(winW);
    const after = await contentBounds(app);
    expect(after.y).toBe(TOP_INSET);
    expect(after.x).toBe(0);
    expect(after.width).toBe(winW);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
