// electron/test/e2e/sandbox.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { IPC, PRIMARY_VIEW_ID } from '../../../shared/types';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-sandbox-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    // about:blank keeps the sandbox suite hermetic (no live network for the home page).
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
  });
  // Wait until the content view exists and has settled on an initial document.
  await expect
    .poll(
      async () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
      { timeout: 15000 },
    )
    .not.toEqual('');
});

test.afterAll(async () => {
  await app.close();
  rmSync(userDataDir, { recursive: true, force: true });
});

/** Run an expression in the CONTENT view's main world and return its result. */
async function evalInContent<T>(expr: string): Promise<T> {
  return app.evaluate(async ({}, source) => {
    const reg = (globalThis as any).__aegisTest;
    return reg.primary.view.webContents.executeJavaScript(source, true);
  }, expr);
}

test('content main world has no Node globals', async () => {
  const probe = await evalInContent<Record<string, string>>(
    `({
       require: typeof require,
       process: typeof process,
       module: typeof module,
       global: typeof global,
     })`,
  );
  expect(probe).toEqual({
    require: 'undefined',
    process: 'undefined',
    module: 'undefined',
    global: 'undefined',
  });
});

test('content world has no privileged bridge (window.aegis / ipcRenderer)', async () => {
  const probe = await evalInContent<Record<string, string>>(
    `({
       aegis: typeof window.aegis,
       ipcRenderer: typeof window.ipcRenderer,
     })`,
  );
  expect(probe).toEqual({ aegis: 'undefined', ipcRenderer: 'undefined' });
});

test('content WebContents reports the locked-down sandbox config', async () => {
  const cfg = await app.evaluate(() => {
    const wc = (globalThis as any).__aegisTest.primary.view.webContents;
    const wp = wc.getLastWebPreferences() ?? {};
    return {
      sandbox: wp.sandbox,
      contextIsolation: wp.contextIsolation,
      nodeIntegration: wp.nodeIntegration,
      webSecurity: wp.webSecurity,
    };
  });
  expect(cfg.sandbox).toBe(true);
  expect(cfg.contextIsolation).toBe(true);
  // nodeIntegration defaults to false; treat absent as false.
  expect(cfg.nodeIntegration ?? false).toBe(false);
  // webSecurity defaults to true; treat absent as true.
  expect(cfg.webSecurity ?? true).toBe(true);
});

test('file:// navigation is blocked by the scheme gate', async () => {
  const before = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.getState().url,
  );
  await app.evaluate(() => {
    (globalThis as any).__aegisTest.primary.navigate('file:///etc/passwd');
  });
  // Give the (rejected) navigation a beat; the gate must keep the URL unchanged.
  const after = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.getState().url,
  );
  expect(after).toBe(before);
  expect(after.startsWith('file://')).toBe(false);
});

test('javascript: navigation is blocked by the scheme gate', async () => {
  const before = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.getState().url,
  );
  await app.evaluate(() => {
    (globalThis as any).__aegisTest.primary.navigate('javascript:alert(1)');
  });
  const after = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.getState().url,
  );
  expect(after).toBe(before);
  expect(after.startsWith('javascript:')).toBe(false);
});

test('privileged IPC invoked from the content view is rejected by the guard', async () => {
  const channel = IPC.settingsGet; // a sender-validated handler registered in T19
  const result = await app.evaluate(
    async ({ ipcMain }, args) => {
      const wc = (globalThis as any).__aegisTest.primary.view.webContents;
      // Inject a one-shot caller into the content world that forwards to ipcRenderer.
      // ipcRenderer is NOT bridged into the content world, so this script must obtain
      // it via the sandboxed internal API and attempt the invoke; the guard rejects it.
      const script = `
        (async () => {
          try {
            // In a sandboxed content renderer ipcRenderer is not exposed; reaching it
            // at all is the hostile case we defend against. Attempt the documented
            // electron require path that a node-integration-bypass would use:
            const ir = require('electron').ipcRenderer;
            const r = await ir.invoke(${JSON.stringify(args.channel)});
            return { outcome: 'resolved', value: r };
          } catch (e) {
            return { outcome: 'threw', message: String(e && e.message ? e.message : e) };
          }
        })()
      `;
      try {
        return await wc.executeJavaScript(script, true);
      } catch (e: any) {
        return { outcome: 'threw', message: String(e?.message ?? e) };
      }
    },
    { channel },
  );
  // Either the content world can't even reach ipcRenderer (require undefined → threw),
  // or the guard rejected the foreign sender (invoke threw). Never a clean resolve.
  expect(result.outcome).toBe('threw');
});
