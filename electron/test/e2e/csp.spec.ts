// electron/test/e2e/csp.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-e2e-csp-'));
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

// The strict (prod/build) directives the transformIndexHtml plugin injects (§2.4).
const STRICT_DIRECTIVES = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "font-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "form-action 'none'",
];

test('the BUILT out/renderer/index.html carries the strict prod CSP meta', () => {
  // electron-vite renderer build root is src/; the prod transform emits the strict meta.
  const html = readFileSync(join('out', 'renderer', 'index.html'), 'utf8');
  const meta = /<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/i.exec(html);
  expect(meta).not.toBeNull();
  // The content attribute is delimited by " but the CSP value itself contains
  // single quotes ('self', 'none', …), so match by the actual attribute delimiter
  // and capture everything up to its closing quote.
  const contentMatch =
    /content="([^"]+)"/i.exec(meta![0]) ?? /content='([^']+)'/i.exec(meta![0]);
  expect(contentMatch).not.toBeNull();
  const content = contentMatch![1];
  for (const directive of STRICT_DIRECTIVES) {
    expect(content).toContain(directive);
  }
  // 'unsafe-eval' / ws: are dev-only relaxations and MUST NOT leak into the prod artifact.
  expect(content).not.toContain("'unsafe-eval'");
  expect(content).not.toContain('ws:');
});

test('the live chrome renderer document enforces the strict CSP meta', async () => {
  // C6: the chrome DOM may not be committed at beforeAll — poll the executeJavaScript
  // query until the <meta> content is non-null before asserting the directives.
  let content: string | null = null;
  await expect
    .poll(
      async () => {
        content = await app.evaluate(({ webContents }) => {
          const chromeId = (globalThis as any).__aegisTest.chromeWcId;
          return webContents.fromId(chromeId)!.executeJavaScript(
            `(() => {
               const m = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
               return m ? m.getAttribute('content') : null;
             })()`,
          );
        });
        return content;
      },
      { timeout: 15000 },
    )
    .not.toBeNull();
  expect(content).not.toBeNull();
  for (const directive of STRICT_DIRECTIVES) {
    expect(content as unknown as string).toContain(directive);
  }
});

test('the visited CONTENT view document has NO app CSP meta (sites unaffected — correct browser behavior)', async () => {
  // The content view loads about:blank here; the app must NOT impose its chrome CSP on it.
  const hasAppCsp = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
      `!!document.querySelector('meta[http-equiv="Content-Security-Policy"]')`,
      true,
    ),
  );
  expect(hasAppCsp).toBe(false);
});
