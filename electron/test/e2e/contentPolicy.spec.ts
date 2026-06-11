// electron/test/e2e/contentPolicy.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-contentpolicy-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
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
});

test.afterAll(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

test('the content webPreferences set autoplayPolicy at the flag level (media policy)', () => {
  // Flag-level verification per the plan's "Accepted (no change)" note: autoplay is
  // asserted at the webPreferences-flag level (NO audio/video fixture is eyeballed).
  // Electron's runtime wc.getLastWebPreferences() does NOT surface autoplayPolicy/plugins,
  // and headless about:blank autoplay behavior is non-deterministic, so we assert the
  // flag in the BUILT main artifact (out/main/index.js — the bundle the e2e launches),
  // parallel to how the CSP spec reads the built renderer artifact.
  const mainBundle = readFileSync(join('out', 'main', 'index.js'), 'utf8');
  expect(mainBundle).toContain("autoplayPolicy: \"document-user-activation-required\"");
  // plugins:true is also pinned in the same content webPreferences literal.
  expect(/plugins:\s*true/.test(mainBundle)).toBe(true);
});

test('plugins:true is live in the content WC (navigator.pdfViewerEnabled → inline PDF policy)', async () => {
  // State-level verification of the inline-PDF policy: plugins:true enables Chromium's
  // PDF viewer, which surfaces as navigator.pdfViewerEnabled === true on the content WC.
  // (No fixture .pdf is rendered/eyeballed — per the plan's "Accepted" note.)
  const pdfViewerEnabled = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      'navigator.pdfViewerEnabled',
      true,
    ),
  );
  expect(pdfViewerEnabled).toBe(true);
});

test('HTML5 fullscreen enter/leave on the content WC drives win.setFullScreen (spy)', async () => {
  // C6: assert via a SPY that the boot listeners called win.setFullScreen(true/false),
  // NOT via win.isFullScreen() (headless WMs may not honor real fullscreen state).
  // Install the spy on the live BaseWindow (the same `win` the boot listeners close over —
  // there is exactly one window), capturing each boolean arg while still calling through.
  const calls = await app.evaluate(({ BaseWindow }) => {
    const win = BaseWindow.getAllWindows()[0] as any;
    const recorded: boolean[] = [];
    const original = win.setFullScreen.bind(win);
    win.setFullScreen = (flag: boolean) => {
      recorded.push(flag);
      return original(flag);
    };

    const wc = (globalThis as any).__aegisTest.primary.view.webContents;
    // The boot listeners are `wc.on('enter-html-full-screen', () => win.setFullScreen(true))`
    // and the leave counterpart → false. Emitting the events invokes them synchronously.
    wc.emit('enter-html-full-screen');
    wc.emit('leave-html-full-screen');

    // Restore the original so we don't leak the spy into later tests.
    win.setFullScreen = original;
    return recorded;
  });

  expect(calls).toEqual([true, false]);
});
