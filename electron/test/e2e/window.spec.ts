import { test, expect } from '@playwright/test';
import { _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeEach(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    // about:blank keeps e2e hermetic once T19 boot wiring honors AEGIS_HOME_URL.
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
  });
});

test.afterEach(async () => {
  await app.close();
});

test('app launches and the chrome renderer loads', async () => {
  // The first window is the BaseWindow; its first WebContents is the chromeView.
  const loaded = await app.evaluate(async ({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0];
    if (!win) return { hasWindow: false, hasRoot: false };
    const wc = win.contentView.children[0] && (win.contentView.children[0] as any).webContents;
    if (!wc) return { hasWindow: true, hasRoot: false };
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()));
    }
    const hasRoot = await wc.executeJavaScript('!!document.getElementById("root")');
    return { hasWindow: true, hasRoot };
  });
  expect(loaded.hasWindow).toBe(true);
  expect(loaded.hasRoot).toBe(true);
});
