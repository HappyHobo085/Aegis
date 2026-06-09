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

test('chrome renderer denies window.open and blocks external navigation', async () => {
  const result = await app.evaluate(async ({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0];
    const wc = (win.contentView.children[0] as any).webContents;
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => wc.once('did-stop-loading', () => resolve()));
    }
    const startUrl: string = wc.getURL();

    // 1) window.open must be denied (setWindowOpenHandler -> action:'deny'),
    //    so the call returns null and no child window is created.
    const openReturn = await wc.executeJavaScript(
      'String(window.open("https://example.com", "_blank"))',
    );

    // 2) An attempt to navigate the chrome to an external URL must be blocked
    //    by the will-navigate guard; the chrome URL must be unchanged.
    await wc.executeJavaScript(
      'try { window.location.href = "https://example.com"; } catch (e) {}',
    );
    await new Promise((r) => setTimeout(r, 500));
    const afterUrl: string = wc.getURL();
    const windowCount = BaseWindow.getAllWindows().length;

    return { openReturn, startUrl, afterUrl, windowCount };
  });

  expect(result.openReturn).toBe('null');
  expect(result.windowCount).toBe(1);
  expect(result.afterUrl).toBe(result.startUrl);
});
