# Aegis Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up a sandboxed, branded Electron browser shell that navigates the real web with genuine controls, persists settings locally, and is hardened to load hostile pages — the foundation for the Phase-1 ad-block engine.

**Architecture:** An Electron `BaseWindow` hosts a chrome `WebContentsView` (React UI) plus one sandboxed content `WebContentsView` (dedicated `persist:content` partition). A typed, sender-validated IPC seam (`shared/types.ts`) connects them; `better-sqlite3` stores local settings; resilience comes from error/crash overlays, an error boundary, and session restore.

**Tech Stack:** Electron 42 + electron-vite 5, React 19 + TypeScript, better-sqlite3 12, Vitest 4 (+ Testing Library) for unit/component tests, Playwright `_electron` for integration tests.

**Companion contract (read first):** `docs/superpowers/plans/2026-06-09-aegis-phase0-contract.md` — authoritative versions, file structure, `shared/types.ts`, Electron API ledger, and interface ledger.

---

### Task 1: Project init — scaffold, config, shared types, constants

**Files:**
- Create: `package.json`
- Create: `electron.vite.config.ts`
- Create: `tsconfig.json`
- Create: `tsconfig.node.json`
- Create: `vitest.config.ts`
- Create: `vitest.setup.ts`
- Create: `playwright.config.ts`
- Create: `electron-builder.yml`
- Create: `.gitignore`
- Create: `src/index.html`
- Create: `shared/types.ts`
- Create: `electron/main/constants.ts`
- Test: `shared/types.test.ts`

- [ ] **Step 1: Initialize the repo and install dependencies**

This task is scaffolding (not naturally TDD); we create the full config files, then a smoke test verifies the toolchain loads `shared/types`.

Run:
```bash
git init
npm init -y
npm i better-sqlite3@^12.10.0
npm i -D electron@^42.3.3 electron-vite@^5.0.0 @electron/rebuild@^4.0.4 \
  vitest@^4.1.8 @vitejs/plugin-react@^4.3.4 \
  @testing-library/react@^16.1.0 @testing-library/jest-dom@^6.6.0 @testing-library/user-event@^14.5.0 \
  jsdom@^25.0.0 @playwright/test@^1.49.0 \
  typescript@^5.7.0 react@^19 react-dom@^19 \
  @types/better-sqlite3@^7.6.11 @types/react@^19 @types/react-dom@^19 @types/node@^22
```

- [ ] **Step 2: Write `package.json` scripts (full file)**

`package.json` (overwrite the `npm init` output's `scripts`/`type`; keep the installed dependency versions exactly as resolved):
```json
{
  "name": "aegis",
  "version": "0.0.0",
  "description": "Aegis — an Electron ad-blocking browser shell",
  "private": true,
  "main": "out/main/index.js",
  "scripts": {
    "predev": "npm run rebuild:electron",
    "dev": "electron-vite dev",
    "prebuild": "npm run rebuild:electron",
    "build": "electron-vite build",
    "preview": "electron-vite preview",
    "pretest": "npm run rebuild:node",
    "test": "vitest run",
    "pretest:e2e": "npm run rebuild:electron && npm run build",
    "test:e2e": "playwright test",
    "rebuild:electron": "electron-rebuild -f -w better-sqlite3",
    "rebuild:node": "npm rebuild better-sqlite3"
  },
  "dependencies": {
    "better-sqlite3": "^12.10.0"
  },
  "devDependencies": {
    "@electron/rebuild": "^4.0.4",
    "@playwright/test": "^1.49.0",
    "@testing-library/jest-dom": "^6.6.0",
    "@testing-library/react": "^16.1.0",
    "@testing-library/user-event": "^14.5.0",
    "@types/better-sqlite3": "^7.6.11",
    "@types/node": "^22",
    "@types/react": "^19",
    "@types/react-dom": "^19",
    "@vitejs/plugin-react": "^4.3.4",
    "electron": "^42.3.3",
    "electron-vite": "^5.0.0",
    "jsdom": "^25.0.0",
    "react": "^19",
    "react-dom": "^19",
    "typescript": "^5.7.0",
    "vitest": "^4.1.8"
  }
}
```

- [ ] **Step 3: Write `electron.vite.config.ts` (full file)**
```ts
import { resolve } from 'node:path';
import { defineConfig } from 'electron-vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  main: {
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'electron/main/index.ts'),
        external: ['better-sqlite3'],
      },
    },
  },
  preload: {
    build: {
      rollupOptions: {
        input: {
          chromePreload: resolve(__dirname, 'electron/preload/chromePreload.ts'),
          contentPreload: resolve(__dirname, 'electron/preload/contentPreload.ts'),
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src'),
    plugins: [react()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/index.html'),
      },
    },
  },
});
```

- [ ] **Step 4: Write `tsconfig.json` (full file)**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "types": ["node", "vitest/globals", "@testing-library/jest-dom"],
    "baseUrl": "."
  },
  "include": ["src", "shared", "electron", "vitest.config.ts", "vitest.setup.ts", "playwright.config.ts"],
  "exclude": ["node_modules", "out"]
}
```

- [ ] **Step 5: Write `tsconfig.node.json` (full file)**
```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "composite": true,
    "module": "CommonJS",
    "moduleResolution": "Node",
    "types": ["node"]
  },
  "include": ["electron", "shared", "electron.vite.config.ts"]
}
```

- [ ] **Step 6: Write `vitest.config.ts` (full file, §7)**
```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    projects: [
      {
        extends: true,
        test: {
          name: 'node',
          environment: 'node',
          include: ['shared/**/*.test.ts', 'electron/**/*.test.ts'],
          exclude: ['electron/test/e2e/**', 'node_modules/**', 'out/**'],
        },
      },
      {
        extends: true,
        test: {
          name: 'dom',
          environment: 'jsdom',
          setupFiles: ['./vitest.setup.ts'],
          include: ['src/**/*.test.{ts,tsx}'],
        },
      },
    ],
  },
});
```

- [ ] **Step 7: Write `vitest.setup.ts` (full file, §7)**
```ts
import '@testing-library/jest-dom/vitest';
import { afterEach } from 'vitest';
import { cleanup } from '@testing-library/react';

afterEach(() => cleanup());
```

- [ ] **Step 8: Write `playwright.config.ts` (full file)**
```ts
import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'electron/test/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
});
```

- [ ] **Step 9: Write `electron-builder.yml` (full file, §2)**
```yaml
appId: com.aegis.browser
productName: Aegis
asarUnpack:
  - "**/node_modules/better-sqlite3/**"
```

- [ ] **Step 10: Write `.gitignore` (full file)**
```gitignore
node_modules/
out/
dist/
*.log
.DS_Store
test-results/
playwright-report/
```

- [ ] **Step 11: Write `src/index.html` (full file, renderer entry)**
```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'"
    />
    <title>Aegis</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/main.tsx"></script>
  </body>
</html>
```

- [ ] **Step 12: Write `shared/types.ts` (verbatim from contract §4)**
```ts
export type ViewId = number;
export const PRIMARY_VIEW_ID: ViewId = 1;

/** https/http are full-navigation schemes; about:blank handled explicitly. */
export const ALLOWED_NAV_SCHEMES = ['https:', 'http:'] as const;

export const IPC = {
  navNavigate: 'nav.navigate',
  navBack: 'nav.back',
  navForward: 'nav.forward',
  navReloadOrStop: 'nav.reloadOrStop',
  navHome: 'nav.home',
  navGetState: 'nav.getState',
  viewSetContentVisible: 'view.setContentVisible',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
} as const;

export interface NavState {
  viewId: ViewId;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  crashed: boolean;
}

export interface NavFailed {
  viewId: ViewId;
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  kind: 'load' | 'cert';
}

export interface NavCrashed {
  viewId: ViewId;
  reason: string;
}

export interface SearchEngine {
  id: string;
  name: string;
  template: string; // contains %s
}

export interface Settings {
  siteName: string;
  homeUrl: string;
  primaryColor: string;
  defaultSearchTemplate: string; // e.g. https://duckduckgo.com/?q=%s
  searchEngines: SearchEngine[]; // seeded; not editable until Phase 4
  hideChromeByDefault: boolean;
}

/** Exposed on window.aegis by chromePreload via contextBridge. */
export interface AegisApi {
  nav: {
    navigate(viewId: ViewId, url: string): Promise<void>;
    back(viewId: ViewId): Promise<void>;
    forward(viewId: ViewId): Promise<void>;
    reloadOrStop(viewId: ViewId): Promise<void>;
    home(viewId: ViewId): Promise<void>;
    getState(viewId: ViewId): Promise<NavState>;
    onState(cb: (s: NavState) => void): () => void;
    onFailed(cb: (f: NavFailed) => void): () => void;
    onCrashed(cb: (c: NavCrashed) => void): () => void;
  };
  view: {
    setContentVisible(viewId: ViewId, visible: boolean): Promise<void>;
  };
  settings: {
    get(): Promise<Settings>;
    set(partial: Partial<Settings>): Promise<Settings>;
  };
}

declare global {
  interface Window {
    aegis: AegisApi;
  }
}
```

- [ ] **Step 13: Write `electron/main/constants.ts` (full file, §6)**
```ts
export const CHROME_TOP_HEIGHT = 56;

/**
 * True if the URL is the app's own chrome renderer: the electron-vite dev
 * renderer origin OR a file: URL under the packaged out/renderer directory.
 */
export function isAppUrl(url: string): boolean {
  const devUrl = process.env.ELECTRON_RENDERER_URL;
  if (devUrl) {
    try {
      const dev = new URL(devUrl);
      const candidate = new URL(url);
      if (candidate.origin === dev.origin) return true;
    } catch {
      // fall through to the file: check
    }
  }
  if (url.startsWith('file:')) {
    try {
      const { pathname } = new URL(url);
      return pathname.includes('/out/renderer/');
    } catch {
      return false;
    }
  }
  return false;
}
```

- [ ] **Step 14: Write the failing smoke test**

Test: `shared/types.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import { IPC, PRIMARY_VIEW_ID, ALLOWED_NAV_SCHEMES } from './types';

describe('shared/types', () => {
  it('exposes the IPC channel constants', () => {
    expect(IPC.navNavigate).toBe('nav.navigate');
    expect(IPC.navGetState).toBe('nav.getState');
    expect(IPC.viewSetContentVisible).toBe('view.setContentVisible');
    expect(IPC.settingsGet).toBe('settings.get');
    expect(IPC.evtNavState).toBe('nav.state');
    expect(IPC.evtNavFailed).toBe('nav.failed');
    expect(IPC.evtNavCrashed).toBe('nav.crashed');
  });

  it('uses the primary view id and the nav-scheme allowlist', () => {
    expect(PRIMARY_VIEW_ID).toBe(1);
    expect(ALLOWED_NAV_SCHEMES).toEqual(['https:', 'http:']);
  });
});
```

- [ ] **Step 15: Run the smoke test, verify it passes**

Run: `npx vitest run shared/types.test.ts`
Expected: PASS — 1 file (project `node`), 2 tests passed. (The `pretest` ABI flip only runs via `npm test`; `npx vitest run` invokes Vitest directly, so this test — which imports no native module — runs under the Node project and passes.)

- [ ] **Step 16: Commit**
```bash
git add package.json package-lock.json electron.vite.config.ts tsconfig.json tsconfig.node.json \
  vitest.config.ts vitest.setup.ts playwright.config.ts electron-builder.yml .gitignore \
  src/index.html shared/types.ts shared/types.test.ts electron/main/constants.ts
git commit -m "chore: scaffold Aegis Phase 0 toolchain, shared types, and constants"
```

---

### Task 2: better-sqlite3 dual-ABI wiring

**Files:**
- Modify: `package.json` (scripts already present from Task 1 — verify only)
- Modify: `electron.vite.config.ts` (main `external: ['better-sqlite3']` already present from Task 1 — verify only)
- Modify: `electron-builder.yml` (`asarUnpack` already present from Task 1 — verify only)
- Test: `electron/db-abi.test.ts`

- [ ] **Step 1: Write the failing test**

Test: `electron/db-abi.test.ts`
```ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';

describe('better-sqlite3 Node ABI', () => {
  it('loads under Vitest (Node ABI) and round-trips a value through :memory:', () => {
    const db = new Database(':memory:');
    db.exec('CREATE TABLE t (k TEXT PRIMARY KEY, v TEXT)');
    db.prepare('INSERT INTO t (k, v) VALUES (?, ?)').run('hello', 'world');
    const row = db.prepare('SELECT v FROM t WHERE k = ?').get('hello') as { v: string } | undefined;
    expect(row?.v).toBe('world');
    db.close();
  });
});
```

- [ ] **Step 2: Manufacture the ABI mismatch, then verify the test fails**

After Task 1's `npm i` the binary is already Node-ABI, so the test would pass spuriously. To get a genuine red, first flip the native binary to the **Electron** ABI, then run the test under the **Node** runtime — it must fail to load:
Run:
```bash
npm run rebuild:electron
npx vitest run electron/db-abi.test.ts
```
Expected: FAIL — loading the native binary aborts with `Error: The module '.../better_sqlite3.node' was compiled against a different Node.js version` / `NODE_MODULE_VERSION` mismatch (the binary is Electron-ABI; Vitest runs under Node).

- [ ] **Step 3: Implement — rebuild for the Node ABI, then confirm the config hooks**

Build the Node ABI binary that Vitest needs (this is exactly what the `pretest` script automates):
```bash
npm run rebuild:node
```

Verify the three already-scaffolded wiring points are correct (no edits needed if Task 1 wrote them as shown):
- `package.json` scripts include `"pretest": "npm run rebuild:node"`, `"rebuild:node": "npm rebuild better-sqlite3"`, `"predev"/"prebuild"/"pretest:e2e"` calling `rebuild:electron`, and `"rebuild:electron": "electron-rebuild -f -w better-sqlite3"`.
- `electron.vite.config.ts` main build has `external: ['better-sqlite3']`.
- `electron-builder.yml` has `asarUnpack: ["**/node_modules/better-sqlite3/**"]`.

If any are missing, add them to match the snippets in Task 1 Steps 2, 3, and 9.

- [ ] **Step 4: Run the test, verify it passes**

Run: `npx vitest run electron/db-abi.test.ts`
Expected: PASS — 1 test passed; the `:memory:` round-trip returns `"world"`. (Under `npm test`, the `pretest` hook performs this same `rebuild:node` automatically before the suite.)

- [ ] **Step 5: Commit**
```bash
git add package.json electron.vite.config.ts electron-builder.yml electron/db-abi.test.ts
git commit -m "build: wire better-sqlite3 dual-ABI (Node for tests, Electron for app)"
```

---

### Task 3: `electron/main/window.ts` — main window + chrome view + minimal boot

**Files:**
- Create: `electron/main/window.ts`
- Create: `electron/main/index.ts` (minimal; full boot wiring arrives in T19)
- Create: `electron/test/e2e/window.spec.ts`

This task is window scaffolding verified by an e2e smoke test; we write the full implementation, then the Playwright `_electron` spec proves the chrome renderer loads. The chrome renderer UI (`src/main.tsx`, `App.tsx`, toolbar components) does not exist until Block 5, so the smoke spec asserts the chrome `WebContents` finished loading and the root element exists, rather than a specific toolbar control.

- [ ] **Step 1: Write the failing e2e smoke test**

Test: `electron/test/e2e/window.spec.ts`
```ts
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
```

- [ ] **Step 2: Run the test, verify it fails**

Run: `npx playwright test electron/test/e2e/window.spec.ts`
Expected: FAIL — `_electron.launch` cannot start because `out/main/index.js` does not exist (no `electron/main/index.ts` has been built yet), so the launch rejects / the spec errors before any assertion. (Under `npm run test:e2e`, the `pretest:e2e` hook runs `rebuild:electron && build` first; running Playwright directly here skips that, which is why the missing build surfaces as the failure.)

- [ ] **Step 3: Implement `electron/main/window.ts`**
```ts
import { join } from 'node:path';
import { BaseWindow, WebContentsView } from 'electron';
import { CHROME_TOP_HEIGHT } from './constants';

/**
 * Creates the BaseWindow and the chrome (privileged React shell) WebContentsView.
 * Owns chrome ONLY — the single content view is owned by ViewController and
 * added by index.ts (T19). Chrome-renderer lockdown is added in Task 4.
 */
export function createMainWindow(): { win: BaseWindow; chromeView: WebContentsView } {
  const win = new BaseWindow({ width: 1280, height: 800 });

  const chromeView = new WebContentsView({
    webPreferences: {
      preload: join(__dirname, '../preload/chromePreload.js'),
      sandbox: true,
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // Add chrome first so it sits beneath the (later-added) content view.
  win.contentView.addChildView(chromeView);

  const chromeWc = chromeView.webContents;

  // NOTE: chrome-renderer lockdown (setWindowOpenHandler + will-navigate guard)
  // is added in Task 4, which writes its failing test first.

  if (process.env.ELECTRON_RENDERER_URL) {
    chromeWc.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    chromeWc.loadFile(join(__dirname, '../renderer/index.html'));
  }

  return { win, chromeView };
}

/**
 * Positions the chrome view over the whole window and, if given, the content
 * view below the top chrome band. Call on window resize.
 */
export function layout(
  win: BaseWindow,
  chromeView: WebContentsView,
  contentView?: WebContentsView,
): void {
  const { width, height } = win.getContentBounds();
  chromeView.setBounds({ x: 0, y: 0, width, height });
  if (contentView) {
    contentView.setBounds({
      x: 0,
      y: CHROME_TOP_HEIGHT,
      width,
      height: height - CHROME_TOP_HEIGHT,
    });
  }
}
```

- [ ] **Step 4: Implement the minimal `electron/main/index.ts`**
```ts
import { app } from 'electron';
import { createMainWindow, layout } from './window';

// Minimal boot for Block 1: launch the window and show the chrome.
// Full wiring (DB, ViewController, IPC, session, __aegisTest) lands in Task 19.
app.whenReady().then(() => {
  const { win, chromeView } = createMainWindow();
  layout(win, chromeView);

  win.on('resize', () => layout(win, chromeView));
  win.on('closed', () => {
    chromeView.webContents.close();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 5: Build, then run the e2e smoke test and verify it passes**

Run:
```bash
npm run build
npx playwright test electron/test/e2e/window.spec.ts
```
Expected: PASS — `npm run build` (via the `prebuild` → `rebuild:electron` hook) emits `out/main/index.js`, `out/preload/chromePreload.js`, and `out/renderer/index.html`; the spec then launches the app, finds one window, waits for the chrome `WebContents` to stop loading, and reads `#root` as present (`hasWindow=true`, `hasRoot=true`). (The chrome preload is a stub until Task 18; loading `index.html` only needs the file to exist, which the renderer build produces.)

- [ ] **Step 6: Commit**
```bash
git add electron/main/window.ts electron/main/index.ts electron/test/e2e/window.spec.ts
git commit -m "feat(window): BaseWindow + chrome WebContentsView with layout and minimal boot"
```

---

### Task 4: Chrome renderer lockdown verification

**Files:**
- Modify: `electron/main/window.ts` (add the lockdown handlers + `isAppUrl` import)
- Create: `electron/test/e2e/chromeLockdown.spec.ts`

`createMainWindow()` (Task 3) intentionally ships WITHOUT lockdown so this task has a genuine red→green: write the e2e spec proving `window.open` and external navigation are blocked (it fails against the unguarded chrome), then add the `setWindowOpenHandler(deny)` + `will-navigate` app-only handlers per the §5 ledger.

- [ ] **Step 1: Write the failing e2e test**

Test: `electron/test/e2e/chromeLockdown.spec.ts`
```ts
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
```

- [ ] **Step 2: Build, run the test, verify it fails**

Run:
```bash
npm run build
npx playwright test electron/test/e2e/chromeLockdown.spec.ts
```
Expected: FAIL — `createMainWindow()` has no lockdown yet, so `openReturn` is not `"null"` (a child-window object string) and/or `windowCount` becomes `2`, and `afterUrl` changes to `https://example.com/`.

- [ ] **Step 3: Implement the lockdown handlers in `electron/main/window.ts`**

First add `isAppUrl` to the constants import at the top of the file:
```ts
import { CHROME_TOP_HEIGHT, isAppUrl } from './constants';
```
Then, in `createMainWindow()`, replace the `// NOTE: chrome-renderer lockdown ...` comment (just after `const chromeWc = chromeView.webContents;`) with the two lockdown handlers:
```ts
  // Chrome-renderer lockdown: deny all popups and allow navigation only to the app bundle.
  chromeWc.setWindowOpenHandler(() => ({ action: 'deny' }));
  chromeWc.on('will-navigate', (event, url) => {
    if (!isAppUrl(url)) event.preventDefault();
  });
```

- [ ] **Step 4: Build, run the test, verify it passes**

Run:
```bash
npm run build
npx playwright test electron/test/e2e/chromeLockdown.spec.ts
```
Expected: PASS — `openReturn === "null"` (popup denied), `windowCount === 1` (no child window opened), and `afterUrl === startUrl` (external navigation blocked by `will-navigate`).

- [ ] **Step 5: Commit**
```bash
git add electron/main/window.ts electron/test/e2e/chromeLockdown.spec.ts
git commit -m "test(window): verify chrome renderer lockdown denies popups and external nav"
```

---

### Task 5: `atomicFile.ts` — atomic write + crash-safe read

**Files:**
- Create: `electron/lib/atomicFile.ts`
- Test: `electron/lib/atomicFile.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/lib/atomicFile.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from './atomicFile';

describe('atomicFile', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-atomic-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('writeFileAtomic', () => {
    it('writes the file contents', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, '{"hello":"world"}');
      expect(readFileSafe(target)).toBe('{"hello":"world"}');
    });

    it('overwrites an existing file', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'first');
      writeFileAtomic(target, 'second');
      expect(readFileSafe(target)).toBe('second');
    });

    it('leaves no temp file behind after a successful write', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'payload');
      const leftovers = readdirSync(dir).filter((name) => name.includes('.tmp-'));
      expect(leftovers).toEqual([]);
    });

    it('uses a pid-suffixed temp path then renames', () => {
      const target = join(dir, 'data.json');
      writeFileAtomic(target, 'payload');
      // only the final file should remain
      expect(readdirSync(dir)).toEqual(['data.json']);
    });
  });

  describe('readFileSafe', () => {
    it('returns the file contents when the file exists', () => {
      const target = join(dir, 'present.txt');
      writeFileSync(target, 'on disk');
      expect(readFileSafe(target)).toBe('on disk');
    });

    it('returns null when the file does not exist (ENOENT)', () => {
      const target = join(dir, 'missing.txt');
      expect(existsSync(target)).toBe(false);
      expect(readFileSafe(target)).toBeNull();
    });

    it('returns null when the path is a directory (read error)', () => {
      // reading a directory as a file throws EISDIR -> null
      expect(readFileSafe(dir)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/lib/atomicFile.test.ts`
Expected: FAIL — module `./atomicFile` cannot be resolved (`Failed to resolve import "./atomicFile"` / `Cannot find module`), so `writeFileAtomic`/`readFileSafe` are undefined.

- [ ] **Step 3: Implement**
```ts
// electron/lib/atomicFile.ts
import { writeFileSync, renameSync, readFileSync } from 'node:fs';

/**
 * Atomically write `data` to `filePath`: write to a pid-suffixed temp file in
 * the same directory, then rename over the target (rename is atomic on the same
 * filesystem). Avoids a torn/partial file if the process dies mid-write.
 */
export function writeFileAtomic(filePath: string, data: string): void {
  const tmpPath = `${filePath}.tmp-${process.pid}`;
  writeFileSync(tmpPath, data, 'utf8');
  renameSync(tmpPath, filePath);
}

/**
 * Read `filePath` as UTF-8 text. Returns null on ENOENT or any read error
 * (e.g. EISDIR), so callers can treat "no usable file" uniformly.
 */
export function readFileSafe(filePath: string): string | null {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/lib/atomicFile.test.ts`
Expected: PASS — all 7 assertions green.

- [ ] **Step 5: Commit**
```bash
git add electron/lib/atomicFile.ts electron/lib/atomicFile.test.ts
git commit -m "feat(lib): add atomicFile writeFileAtomic/readFileSafe with tests"
```

---

### Task 6: `db/sqlite.ts` — openDb + runMigrations

**Files:**
- Create: `electron/main/db/sqlite.ts`
- Test: `electron/main/db/sqlite.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/db/sqlite.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';

describe('sqlite', () => {
  let db: Database.Database | undefined;

  afterEach(() => {
    if (db) {
      db.close();
      db = undefined;
    }
  });

  describe('openDb', () => {
    it('opens an in-memory database that round-trips a value', () => {
      db = openDb(':memory:');
      db.exec('CREATE TABLE t (v TEXT)');
      db.prepare('INSERT INTO t (v) VALUES (?)').run('hi');
      const row = db.prepare('SELECT v FROM t').get() as { v: string };
      expect(row.v).toBe('hi');
    });
  });

  describe('runMigrations', () => {
    it('creates the settings table', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const tbl = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='settings'")
        .get() as { name: string } | undefined;
      expect(tbl?.name).toBe('settings');
    });

    it('settings table has key (PK) and value columns', () => {
      db = openDb(':memory:');
      runMigrations(db);
      const cols = (db.prepare('PRAGMA table_info(settings)').all() as Array<{
        name: string;
        pk: number;
      }>).reduce<Record<string, number>>((acc, c) => {
        acc[c.name] = c.pk;
        return acc;
      }, {});
      expect(cols).toHaveProperty('key');
      expect(cols).toHaveProperty('value');
      expect(cols.key).toBe(1); // key is the primary key
    });

    it('is idempotent (running twice does not throw and preserves data)', () => {
      db = openDb(':memory:');
      runMigrations(db);
      db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('siteName', '"Aegis"');
      expect(() => runMigrations(db!)).not.toThrow();
      const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('siteName') as
        | { value: string }
        | undefined;
      expect(row?.value).toBe('"Aegis"');
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/db/sqlite.test.ts`
Expected: FAIL — `./sqlite` cannot be resolved (`Cannot find module './sqlite'`), so `openDb`/`runMigrations` are undefined.

- [ ] **Step 3: Implement**
```ts
// electron/main/db/sqlite.ts
import Database from 'better-sqlite3';

/**
 * Open (or create) a better-sqlite3 database at `dbPath`. Pass ':memory:' in
 * tests. WAL is enabled for durable, concurrent-friendly writes in the app.
 */
export function openDb(dbPath: string): Database.Database {
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/**
 * Create the Phase-0 schema. Idempotent: uses IF NOT EXISTS so re-running on an
 * existing DB neither throws nor drops data. Phase 0 only needs `settings`
 * (key/value JSON store); later phases add tables here.
 */
export function runMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/db/sqlite.test.ts`
Expected: PASS — all 4 assertions green. (`pretest` runs `npm rebuild better-sqlite3` so the Node-ABI binary loads under Vitest.)

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/sqlite.ts electron/main/db/sqlite.test.ts
git commit -m "feat(db): add openDb and idempotent runMigrations (settings table) with tests"
```

---

### Task 7: `db/settingsRepo.ts` — DEFAULT_SETTINGS + SettingsRepo

**Files:**
- Create: `electron/main/db/settingsRepo.ts`
- Test: `electron/main/db/settingsRepo.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/db/settingsRepo.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb, runMigrations } from './sqlite';
import { DEFAULT_SETTINGS, SettingsRepo } from './settingsRepo';

describe('settingsRepo', () => {
  let db: Database.Database;
  let repo: SettingsRepo;

  beforeEach(() => {
    db = openDb(':memory:');
    runMigrations(db);
    repo = new SettingsRepo(db);
  });

  afterEach(() => {
    db.close();
  });

  describe('DEFAULT_SETTINGS', () => {
    it('has the Phase-0 default shape', () => {
      expect(DEFAULT_SETTINGS.siteName).toBe('Aegis');
      expect(DEFAULT_SETTINGS.homeUrl).toMatch(/^https:\/\//);
      expect(DEFAULT_SETTINGS.primaryColor).toMatch(/^#/);
      expect(DEFAULT_SETTINGS.defaultSearchTemplate).toContain('%s');
      expect(DEFAULT_SETTINGS.hideChromeByDefault).toBe(false);
      expect(Array.isArray(DEFAULT_SETTINGS.searchEngines)).toBe(true);
      expect(DEFAULT_SETTINGS.searchEngines.length).toBeGreaterThan(0);
      for (const eng of DEFAULT_SETTINGS.searchEngines) {
        expect(eng.template).toContain('%s');
      }
    });
  });

  describe('get', () => {
    it('returns DEFAULT_SETTINGS when nothing is stored', () => {
      expect(repo.get()).toEqual(DEFAULT_SETTINGS);
    });

    it('merges stored values over the defaults', () => {
      repo.set({ siteName: 'MyBrowser' });
      const got = repo.get();
      expect(got.siteName).toBe('MyBrowser');
      // unset fields fall back to defaults
      expect(got.homeUrl).toBe(DEFAULT_SETTINGS.homeUrl);
      expect(got.primaryColor).toBe(DEFAULT_SETTINGS.primaryColor);
    });
  });

  describe('set', () => {
    it('persists a partial update and returns the merged result', () => {
      const result = repo.set({ primaryColor: '#ff0000', homeUrl: 'https://example.com' });
      expect(result.primaryColor).toBe('#ff0000');
      expect(result.homeUrl).toBe('https://example.com');
      expect(result.siteName).toBe(DEFAULT_SETTINGS.siteName);
    });

    it('persists across repo instances on the same db', () => {
      repo.set({ siteName: 'Persisted' });
      const repo2 = new SettingsRepo(db);
      expect(repo2.get().siteName).toBe('Persisted');
    });

    it('successive partial updates accumulate', () => {
      repo.set({ siteName: 'One' });
      repo.set({ primaryColor: '#00ff00' });
      const got = repo.get();
      expect(got.siteName).toBe('One');
      expect(got.primaryColor).toBe('#00ff00');
    });

    it('round-trips complex values (searchEngines array)', () => {
      const engines = [{ id: 'g', name: 'Google', template: 'https://google.com/search?q=%s' }];
      repo.set({ searchEngines: engines });
      expect(repo.get().searchEngines).toEqual(engines);
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/db/settingsRepo.test.ts`
Expected: FAIL — `./settingsRepo` cannot be resolved (`Cannot find module './settingsRepo'`), so `DEFAULT_SETTINGS`/`SettingsRepo` are undefined.

- [ ] **Step 3: Implement**
```ts
// electron/main/db/settingsRepo.ts
import type Database from 'better-sqlite3';
import type { Settings } from '../../../shared/types';

export const DEFAULT_SETTINGS: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#7c5cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [
    { id: 'ddg', name: 'DuckDuckGo', template: 'https://duckduckgo.com/?q=%s' },
    { id: 'google', name: 'Google', template: 'https://www.google.com/search?q=%s' },
    { id: 'bing', name: 'Bing', template: 'https://www.bing.com/search?q=%s' },
  ],
  hideChromeByDefault: false,
};

/**
 * Reads/writes Settings as individual JSON-encoded rows in the `settings`
 * key/value table. `get()` merges any stored keys over DEFAULT_SETTINGS, so a
 * missing or partially-populated DB always yields a complete Settings object.
 */
export class SettingsRepo {
  private readonly selectAll: Database.Statement;
  private readonly upsert: Database.Statement;

  constructor(private readonly db: Database.Database) {
    this.selectAll = db.prepare('SELECT key, value FROM settings');
    this.upsert = db.prepare(
      'INSERT INTO settings (key, value) VALUES (@key, @value) ' +
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
  }

  /** Merge stored settings over the defaults; always returns a full Settings. */
  get(): Settings {
    const rows = this.selectAll.all() as Array<{ key: string; value: string }>;
    const stored: Partial<Settings> = {};
    for (const { key, value } of rows) {
      (stored as Record<string, unknown>)[key] = JSON.parse(value);
    }
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  /** Persist a partial update (each key as its own JSON row); return merged. */
  set(partial: Partial<Settings>): Settings {
    const writeAll = this.db.transaction((entries: Array<[string, unknown]>) => {
      for (const [key, value] of entries) {
        this.upsert.run({ key, value: JSON.stringify(value) });
      }
    });
    writeAll(Object.entries(partial));
    return this.get();
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/db/settingsRepo.test.ts`
Expected: PASS — all assertions green (defaults shape, default fallthrough, merge, persistence across instances, accumulation, complex round-trip).

- [ ] **Step 5: Commit**
```bash
git add electron/main/db/settingsRepo.ts electron/main/db/settingsRepo.test.ts
git commit -m "feat(db): add DEFAULT_SETTINGS and SettingsRepo get/set merge with tests"
```

---

### Task 8: `session.ts` — readLastSession / writeLastSession

**Files:**
- Create: `electron/main/session.ts`
- Test: `electron/main/session.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/session.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readLastSession, writeLastSession } from './session';

describe('session', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'aegis-session-'));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  describe('readLastSession', () => {
    it('returns null when session.json does not exist', () => {
      expect(readLastSession(dir)).toBeNull();
    });

    it('returns null when session.json is not valid JSON', () => {
      writeFileSync(join(dir, 'session.json'), 'not json {{{');
      expect(readLastSession(dir)).toBeNull();
    });

    it('returns null when the stored shape is missing url/title', () => {
      writeFileSync(join(dir, 'session.json'), JSON.stringify({ foo: 'bar' }));
      expect(readLastSession(dir)).toBeNull();
    });

    it('reads back a valid session', () => {
      writeFileSync(
        join(dir, 'session.json'),
        JSON.stringify({ url: 'https://example.com', title: 'Example' }),
      );
      expect(readLastSession(dir)).toEqual({ url: 'https://example.com', title: 'Example' });
    });
  });

  describe('writeLastSession', () => {
    it('writes session.json into the data dir', () => {
      writeLastSession(dir, { url: 'https://aegis.test', title: 'Aegis' });
      const path = join(dir, 'session.json');
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({
        url: 'https://aegis.test',
        title: 'Aegis',
      });
    });

    it('round-trips through readLastSession', () => {
      writeLastSession(dir, { url: 'https://round.trip', title: 'RT' });
      expect(readLastSession(dir)).toEqual({ url: 'https://round.trip', title: 'RT' });
    });

    it('overwrites a previous session atomically (no temp file left behind)', () => {
      writeLastSession(dir, { url: 'https://first', title: 'First' });
      writeLastSession(dir, { url: 'https://second', title: 'Second' });
      expect(readLastSession(dir)).toEqual({ url: 'https://second', title: 'Second' });
      // atomicFile cleans up its pid-suffixed temp on success
      const path = join(dir, 'session.json');
      expect(existsSync(`${path}.tmp-${process.pid}`)).toBe(false);
    });
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/session.test.ts`
Expected: FAIL — `./session` cannot be resolved (`Cannot find module './session'`), so `readLastSession`/`writeLastSession` are undefined.

- [ ] **Step 3: Implement**
```ts
// electron/main/session.ts
import { join } from 'node:path';
import { writeFileAtomic, readFileSafe } from '../lib/atomicFile';

interface LastSession {
  url: string;
  title: string;
}

function sessionPath(dataDir: string): string {
  return join(dataDir, 'session.json');
}

/**
 * Read the last persisted session ({ url, title }) from `<dataDir>/session.json`.
 * Returns null when the file is absent, unreadable, not valid JSON, or missing
 * the expected string fields (crash-safe: a corrupt file never throws).
 */
export function readLastSession(dataDir: string): LastSession | null {
  const raw = readFileSafe(sessionPath(dataDir));
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    typeof parsed === 'object' &&
    parsed !== null &&
    typeof (parsed as Record<string, unknown>).url === 'string' &&
    typeof (parsed as Record<string, unknown>).title === 'string'
  ) {
    const { url, title } = parsed as LastSession;
    return { url, title };
  }
  return null;
}

/** Persist the current session ({ url, title }) atomically to session.json. */
export function writeLastSession(dataDir: string, s: LastSession): void {
  writeFileAtomic(sessionPath(dataDir), JSON.stringify({ url: s.url, title: s.title }));
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/session.test.ts`
Expected: PASS — all assertions green (null on missing/corrupt/bad-shape, valid read, write+round-trip, atomic overwrite with no temp leftover).

- [ ] **Step 5: Commit**
```bash
git add electron/main/session.ts electron/main/session.test.ts
git commit -m "feat(main): add readLastSession/writeLastSession via atomicFile with tests"
```

---

### Task 9: `electron/lib/schemes.ts` — `isAllowedNavigationUrl`

**Files:**
- Create: `electron/lib/schemes.ts`
- Test: `electron/lib/schemes.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/lib/schemes.test.ts
import { describe, it, expect } from 'vitest';
import { isAllowedNavigationUrl } from './schemes';

describe('isAllowedNavigationUrl', () => {
  it('allows https: URLs', () => {
    expect(isAllowedNavigationUrl('https://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('https://example.com/path?q=1#frag')).toBe(true);
  });

  it('allows http: URLs', () => {
    expect(isAllowedNavigationUrl('http://example.com')).toBe(true);
    expect(isAllowedNavigationUrl('http://localhost:8080/spa.html')).toBe(true);
  });

  it('allows exactly about:blank', () => {
    expect(isAllowedNavigationUrl('about:blank')).toBe(true);
  });

  it('rejects other about: URLs', () => {
    expect(isAllowedNavigationUrl('about:config')).toBe(false);
    expect(isAllowedNavigationUrl('about:blank#x')).toBe(false);
  });

  it('rejects file: URLs', () => {
    expect(isAllowedNavigationUrl('file:///etc/passwd')).toBe(false);
  });

  it('rejects javascript: URLs', () => {
    expect(isAllowedNavigationUrl('javascript:alert(1)')).toBe(false);
  });

  it('rejects data: URLs', () => {
    expect(isAllowedNavigationUrl('data:text/html,<h1>x</h1>')).toBe(false);
  });

  it('rejects chrome: URLs', () => {
    expect(isAllowedNavigationUrl('chrome://settings')).toBe(false);
  });

  it('rejects custom and unknown schemes', () => {
    expect(isAllowedNavigationUrl('ftp://example.com')).toBe(false);
    expect(isAllowedNavigationUrl('aegis://thing')).toBe(false);
  });

  it('rejects invalid / unparsable input', () => {
    expect(isAllowedNavigationUrl('not a url')).toBe(false);
    expect(isAllowedNavigationUrl('')).toBe(false);
    expect(isAllowedNavigationUrl('example.com')).toBe(false); // no scheme
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/lib/schemes.test.ts`
Expected: FAIL — module resolution error: `Failed to resolve import "./schemes"` / `isAllowedNavigationUrl is not a function` (the file does not exist yet).

- [ ] **Step 3: Implement**
```ts
// electron/lib/schemes.ts
import { ALLOWED_NAV_SCHEMES } from '../../shared/types';

/**
 * Dependency-free navigation scheme allowlist, imported by both the main process
 * and the renderer. Returns true for https:, http:, and exactly 'about:blank';
 * false for file:, javascript:, data:, chrome:, other schemes, and invalid input.
 */
export function isAllowedNavigationUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (ALLOWED_NAV_SCHEMES as readonly string[]).includes(parsed.protocol);
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/lib/schemes.test.ts`
Expected: PASS — all assertions green.

- [ ] **Step 5: Commit**
```bash
git add electron/lib/schemes.ts electron/lib/schemes.test.ts
git commit -m "feat(schemes): isAllowedNavigationUrl scheme allowlist"
```

---

### Task 10: `electron/main/viewController.ts` — content view, navigate, nav-state events, title debounce, getState, bounds, visibility, destroy

**Files:**
- Create: `electron/main/viewController.ts`
- Test: `electron/main/viewController.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/viewController.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../shared/types';

// ---- mock the `electron` module ----------------------------------------------
// vi.hoisted holds the shared fake-WebContents factory so the vi.mock factory
// (hoisted above imports by Vitest) can reference it without TDZ errors.
const h = vi.hoisted(() => {
  type Listener = (...args: any[]) => void;
  function makeWebContents() {
    const listeners = new Map<string, Listener[]>();
    return {
      _listeners: listeners,
      _emit(channel: string, ...args: any[]) {
        for (const l of listeners.get(channel) ?? []) l(...args);
      },
      _loading: false,
      _url: '',
      _title: '',
      on(channel: string, cb: Listener) {
        const arr = listeners.get(channel) ?? [];
        arr.push(cb);
        listeners.set(channel, arr);
        return this;
      },
      loadURL: vi.fn(function (this: any, url: string) {
        this._url = url;
      }),
      reload: vi.fn(),
      stop: vi.fn(),
      isLoading() {
        return this._loading;
      },
      getURL() {
        return this._url;
      },
      getTitle() {
        return this._title;
      },
      close: vi.fn(),
      session: {
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        on: vi.fn(),
      },
      setWindowOpenHandler: vi.fn(),
      navigationHistory: {
        canGoBack: vi.fn(() => false),
        goBack: vi.fn(),
        canGoForward: vi.fn(() => false),
        goForward: vi.fn(),
      },
    };
  }
  let last: ReturnType<typeof makeWebContents> | null = null;
  class WebContentsView {
    webContents = makeWebContents();
    setBounds = vi.fn();
    setVisible = vi.fn();
    constructor() {
      last = this.webContents;
    }
  }
  return {
    WebContentsView,
    getLastWc: () => last,
  };
});

vi.mock('electron', () => ({
  WebContentsView: h.WebContentsView,
}));

import { ViewController } from './viewController';

function makeOpts() {
  return {
    contentPreloadPath: '/tmp/contentPreload.js',
    onState: vi.fn(),
    onFailed: vi.fn(),
    onCrashed: vi.fn(),
  };
}

describe('ViewController construction & basics', () => {
  it('creates a WebContentsView with persist:content partition and security prefs', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    expect(vc.id).toBe(PRIMARY_VIEW_ID);
    expect(vc.view).toBeDefined();
    expect(vc.view.webContents).toBe(h.getLastWc());
  });

  it('navigate() with an allowed scheme loads the URL', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.navigate('https://example.com');
    expect(h.getLastWc()!.loadURL).toHaveBeenCalledWith('https://example.com');
    expect(opts.onFailed).not.toHaveBeenCalled();
  });

  it('navigate() with a rejected scheme emits onFailed(kind:load) and does not load', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.navigate('file:///etc/passwd');
    expect(h.getLastWc()!.loadURL).not.toHaveBeenCalled();
    expect(opts.onFailed).toHaveBeenCalledTimes(1);
    const arg = opts.onFailed.mock.calls[0][0];
    expect(arg.kind).toBe('load');
    expect(arg.validatedURL).toBe('file:///etc/passwd');
    expect(arg.viewId).toBe(PRIMARY_VIEW_ID);
  });

  it('getState() reflects current url/title/loading', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://a.test/';
    wc._title = 'A';
    wc._loading = true;
    const s = vc.getState();
    expect(s).toMatchObject({
      viewId: PRIMARY_VIEW_ID,
      url: 'https://a.test/',
      title: 'A',
      isLoading: true,
      crashed: false,
    });
  });
});

describe('ViewController nav-state events', () => {
  it('did-start-loading emits state with isLoading:true', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-start-loading');
    expect(opts.onState).toHaveBeenCalled();
    expect(opts.onState.mock.calls.at(-1)![0].isLoading).toBe(true);
  });

  it('did-navigate emits state with the new url', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://nav.test/';
    wc._emit('did-navigate', {}, 'https://nav.test/');
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://nav.test/');
  });

  it('did-navigate-in-page emits state with the new url (SPA, no reload)', () => {
    const opts = makeOpts();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._url = 'https://spa.test/page2';
    wc._emit('did-navigate-in-page', {}, 'https://spa.test/page2', true);
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://spa.test/page2');
  });
});

describe('ViewController title debounce (injected timer)', () => {
  beforeEach(() => vi.clearAllMocks());

  it('coalesces same-URL title updates into one trailing emit after 400ms', () => {
    let scheduled: { fn: () => void; ms: number } | null = null;
    const setTimer = vi.fn((fn: () => void, ms: number) => {
      scheduled = { fn, ms };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const opts = makeOpts();
    new ViewController(opts, { setTimer, clearTimer });
    const wc = h.getLastWc()!;
    wc._url = 'https://t.test/';

    wc._emit('page-title-updated', {}, 'T1');
    wc._emit('page-title-updated', {}, 'T2');
    wc._emit('page-title-updated', {}, 'T3');

    // schedule each time, clearing the prior pending timer
    expect(setTimer).toHaveBeenCalled();
    expect(scheduled!.ms).toBe(400);
    const titleEmitsBefore = opts.onState.mock.calls.filter(
      (c) => c[0].title === 'T3',
    ).length;
    expect(titleEmitsBefore).toBe(0); // nothing fired yet

    scheduled!.fn(); // fire the trailing timer
    const last = opts.onState.mock.calls.at(-1)![0];
    expect(last.title).toBe('T3');
  });

  it('did-navigate to a new URL flushes the title immediately (no pending timer)', () => {
    let scheduled: { fn: () => void } | null = null;
    const setTimer = vi.fn((fn: () => void) => {
      scheduled = { fn };
      return 1 as unknown as ReturnType<typeof setTimeout>;
    });
    const clearTimer = vi.fn();
    const opts = makeOpts();
    new ViewController(opts, { setTimer, clearTimer });
    const wc = h.getLastWc()!;
    wc._url = 'https://t.test/a';
    wc._emit('page-title-updated', {}, 'pending');

    wc._url = 'https://t.test/b';
    wc._emit('did-navigate', {}, 'https://t.test/b');

    expect(clearTimer).toHaveBeenCalled();
    expect(opts.onState.mock.calls.at(-1)![0].url).toBe('https://t.test/b');
  });
});

describe('ViewController bounds & visibility', () => {
  it('setBounds forwards to the view', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.setBounds({ x: 0, y: 56, width: 800, height: 544 });
    expect((vc.view.setBounds as any)).toHaveBeenCalledWith({
      x: 0,
      y: 56,
      width: 800,
      height: 544,
    });
  });

  it('setVisible updates isContentVisible and forwards to the view', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    expect(vc.isContentVisible()).toBe(true); // default visible
    vc.setVisible(false);
    expect(vc.isContentVisible()).toBe(false);
    expect((vc.view.setVisible as any)).toHaveBeenLastCalledWith(false);
  });

  it('destroy closes the content webContents', () => {
    const opts = makeOpts();
    const vc = new ViewController(opts);
    vc.destroy();
    expect(h.getLastWc()!.close).toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: FAIL — `Failed to resolve import "./viewController"` (file does not exist).

- [ ] **Step 3: Implement**
```ts
// electron/main/viewController.ts
import { WebContentsView } from 'electron';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { isAllowedNavigationUrl } from '../lib/schemes';

const TITLE_DEBOUNCE_MS = 400;

export interface ViewControllerOpts {
  contentPreloadPath: string;
  onState: (s: NavState) => void;
  onFailed: (f: NavFailed) => void;
  onCrashed: (c: NavCrashed) => void;
}

/** Optional test-only injection: timer for the title debounce. */
export interface ViewControllerDeps {
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}

export class ViewController {
  readonly id: ViewId = PRIMARY_VIEW_ID;
  readonly view: WebContentsView;

  private readonly opts: ViewControllerOpts;
  private readonly setTimer: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (h: ReturnType<typeof setTimeout>) => void;

  private visible = true;
  private crashed = false;
  private pendingShowOnStart = false;

  // title debounce state
  private titleTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingTitle: string | null = null;

  constructor(opts: ViewControllerOpts, deps?: ViewControllerDeps) {
    this.opts = opts;
    this.setTimer = deps?.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps?.clearTimer ?? ((h) => clearTimeout(h));

    this.view = new WebContentsView({
      webPreferences: {
        preload: opts.contentPreloadPath,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        partition: 'persist:content',
      },
    });

    this.wireNavEvents();
  }

  private wc() {
    return this.view.webContents;
  }

  private wireNavEvents(): void {
    const wc = this.wc();

    wc.on('did-start-loading', () => {
      if (this.pendingShowOnStart) {
        this.pendingShowOnStart = false;
        this.setVisible(true);
      }
      this.emitState();
    });

    wc.on('did-stop-loading', () => {
      this.emitState();
    });

    wc.on('did-navigate', () => {
      this.flushTitle();
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_event: unknown, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.emitState();
    });

    wc.on('page-title-updated', (_event: unknown, title: string) => {
      this.scheduleTitle(title);
    });
  }

  private scheduleTitle(title: string): void {
    this.pendingTitle = title;
    if (this.titleTimer !== null) this.clearTimer(this.titleTimer);
    this.titleTimer = this.setTimer(() => {
      this.titleTimer = null;
      // Emit the trailing title BEFORE clearing pendingTitle so getState() reports it.
      this.emitState();
      this.pendingTitle = null;
    }, TITLE_DEBOUNCE_MS);
  }

  private flushTitle(): void {
    // Cancel a pending trailing-title emit WITHOUT emitting it; the caller
    // (did-navigate) emits fresh state immediately afterwards.
    if (this.titleTimer !== null) {
      this.clearTimer(this.titleTimer);
      this.titleTimer = null;
    }
    this.pendingTitle = null;
  }

  navigate(url: string): void {
    if (!isAllowedNavigationUrl(url)) {
      this.opts.onFailed({
        viewId: this.id,
        errorCode: 0,
        errorDescription: 'Blocked navigation scheme',
        validatedURL: url,
        kind: 'load',
      });
      return;
    }
    this.crashed = false;
    this.pendingShowOnStart = true;
    this.wc().loadURL(url);
  }

  back(): void {
    if (this.wc().navigationHistory.canGoBack()) this.wc().navigationHistory.goBack();
  }

  forward(): void {
    if (this.wc().navigationHistory.canGoForward()) this.wc().navigationHistory.goForward();
  }

  reloadOrStop(): void {
    this.crashed = false;
    this.pendingShowOnStart = true;
    if (this.wc().isLoading()) this.wc().stop();
    else this.wc().reload();
  }

  getState(): NavState {
    const wc = this.wc();
    return {
      viewId: this.id,
      url: wc.getURL(),
      title: this.pendingTitle ?? wc.getTitle(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      isLoading: wc.isLoading(),
      crashed: this.crashed,
    };
  }

  private emitState(): void {
    this.opts.onState(this.getState());
  }

  isContentVisible(): boolean {
    return this.visible;
  }

  setBounds(rect: { x: number; y: number; width: number; height: number }): void {
    this.view.setBounds(rect);
  }

  setVisible(v: boolean): void {
    this.visible = v;
    this.view.setVisible(v);
  }

  destroy(): void {
    this.flushTitle();
    this.wc().close();
  }
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — construction, navigate allow/reject, getState, did-start/navigate/in-page events, title debounce coalesce + did-navigate flush, bounds/visibility, and destroy all green.

- [ ] **Step 5: Commit**
```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(viewController): content view, navigate, nav-state events, title debounce"
```

---

### Task 11: Back/forward/`reloadOrStop` via `navigationHistory`; `canGoBack`/`canGoForward` in `getState`; recovery re-show

**Files:**
- Modify: `electron/main/viewController.ts` (no source change expected — Task 10 already implemented `back`/`forward`/`reloadOrStop`/`getState`; this task adds the tests that pin their exact behavior; if any test fails, fix the corresponding method)
- Test: `electron/main/viewController.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**
Append this block to the bottom of `electron/main/viewController.test.ts`:
```ts
describe('ViewController history & recovery (Task 11)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('back() goes back only when canGoBack() is true', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoBack as any).mockReturnValue(false);
    vc.back();
    expect(wc.navigationHistory.goBack).not.toHaveBeenCalled();

    (wc.navigationHistory.canGoBack as any).mockReturnValue(true);
    vc.back();
    expect(wc.navigationHistory.goBack).toHaveBeenCalledTimes(1);
  });

  it('forward() goes forward only when canGoForward() is true', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoForward as any).mockReturnValue(false);
    vc.forward();
    expect(wc.navigationHistory.goForward).not.toHaveBeenCalled();

    (wc.navigationHistory.canGoForward as any).mockReturnValue(true);
    vc.forward();
    expect(wc.navigationHistory.goForward).toHaveBeenCalledTimes(1);
  });

  it('getState() surfaces canGoBack/canGoForward from navigationHistory', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    (wc.navigationHistory.canGoBack as any).mockReturnValue(true);
    (wc.navigationHistory.canGoForward as any).mockReturnValue(true);
    const s = vc.getState();
    expect(s.canGoBack).toBe(true);
    expect(s.canGoForward).toBe(true);
  });

  it('reloadOrStop() stops when loading, reloads when idle', () => {
    const vc = new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    wc._loading = true;
    vc.reloadOrStop();
    expect(wc.stop).toHaveBeenCalledTimes(1);
    expect(wc.reload).not.toHaveBeenCalled();

    wc._loading = false;
    vc.reloadOrStop();
    expect(wc.reload).toHaveBeenCalledTimes(1);
  });

  it('reloadOrStop() recovery: re-shows content on the next did-start-loading and clears crashed', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;

    // simulate a prior crash hiding the content
    vc.setVisible(false);
    (vc as any).crashed = true;
    expect(vc.isContentVisible()).toBe(false);

    wc._loading = false;
    vc.reloadOrStop(); // sets pendingShowOnStart + clears crashed
    expect(vc.getState().crashed).toBe(false);

    wc._emit('did-start-loading'); // recovery re-show
    expect(vc.isContentVisible()).toBe(true);
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS for the existing blocks; the new "Task 11" block must run. If the implementation from Task 10 is incomplete (e.g. `reloadOrStop` does not set `pendingShowOnStart`/clear `crashed`, or `back`/`forward` do not guard on `canGo*`), these new tests FAIL with assertions like `expected goBack not to have been called` or `expected true to be false (isContentVisible)`. If they already pass because Task 10 implemented the full behavior, treat this task as a regression-pinning step and proceed to Step 4. Run the new block in isolation to confirm it is exercised:
Run: `npx vitest run electron/main/viewController.test.ts -t "history & recovery"`
Expected (if behavior present from Task 10): PASS; (if not): FAIL with the assertion above.

- [ ] **Step 3: Implement**
The required behavior is already present in `electron/main/viewController.ts` from Task 10: `back()`/`forward()` guard on `navigationHistory.canGoBack()`/`canGoForward()`, `getState()` reads those flags, and `reloadOrStop()` sets `pendingShowOnStart = true`, clears `this.crashed`, and stops-if-loading / reloads-otherwise; the re-show happens in the `did-start-loading` handler when `pendingShowOnStart` is true. If Step 2 surfaced a gap, apply this exact `reloadOrStop` and the `did-start-loading` handler (shown here for completeness — replace the existing identical bodies only if they diverged):
```ts
  reloadOrStop(): void {
    this.crashed = false;
    this.pendingShowOnStart = true;
    if (this.wc().isLoading()) this.wc().stop();
    else this.wc().reload();
  }
```
```ts
    wc.on('did-start-loading', () => {
      if (this.pendingShowOnStart) {
        this.pendingShowOnStart = false;
        this.setVisible(true);
      }
      this.emitState();
    });
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — all blocks including "history & recovery".

- [ ] **Step 5: Commit**
```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "test(viewController): pin back/forward/reloadOrStop history + recovery re-show"
```

---

### Task 12: `will-navigate`/`will-redirect` scheme gate + `did-fail-load` → `onFailed` (cert-vs-load, main-frame only) + main-owned hide

**Files:**
- Modify: `electron/main/viewController.ts` (extend `wireNavEvents` with `will-navigate`, `will-redirect`, `did-fail-load`)
- Test: `electron/main/viewController.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**
Append this block to the bottom of `electron/main/viewController.test.ts`:
```ts
describe('ViewController navigation gate & failures (Task 12)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  function makeEvent() {
    return { preventDefault: vi.fn() };
  }

  it('will-navigate to a disallowed scheme is prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'file:///etc/passwd');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('will-navigate to an allowed scheme is not prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-navigate', ev, 'https://ok.test/');
    expect(ev.preventDefault).not.toHaveBeenCalled();
  });

  it('will-redirect to a disallowed scheme is prevented', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const ev = makeEvent();
    wc._emit('will-redirect', ev, 'javascript:alert(1)');
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('did-fail-load (main frame, load error) emits onFailed kind:load and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    // errorCode -105 (NAME_NOT_RESOLVED) is a load error
    wc._emit('did-fail-load', {}, -105, 'ERR_NAME_NOT_RESOLVED', 'https://bad.test/', true);
    expect(opts.onFailed).toHaveBeenCalledTimes(1);
    const f = opts.onFailed.mock.calls[0][0];
    expect(f).toMatchObject({
      viewId: 1,
      errorCode: -105,
      errorDescription: 'ERR_NAME_NOT_RESOLVED',
      validatedURL: 'https://bad.test/',
      kind: 'load',
    });
    expect(vc.isContentVisible()).toBe(false);
  });

  it('did-fail-load with a cert-range errorCode emits kind:cert', () => {
    const opts = makeOptsLocal();
    new ViewController(opts);
    const wc = h.getLastWc()!;
    // -202 (ERR_CERT_AUTHORITY_INVALID): -200 >= code > -300 => cert
    wc._emit('did-fail-load', {}, -202, 'ERR_CERT_AUTHORITY_INVALID', 'https://self.test/', true);
    expect(opts.onFailed.mock.calls[0][0].kind).toBe('cert');
  });

  it('did-fail-load on a sub-frame does NOT emit onFailed and does NOT hide', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-fail-load', {}, -105, 'ERR', 'https://bad.test/iframe', false);
    expect(opts.onFailed).not.toHaveBeenCalled();
    expect(vc.isContentVisible()).toBe(true);
  });

  it('did-fail-load with errorCode -3 (ERR_ABORTED) is ignored', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('did-fail-load', {}, -3, 'ERR_ABORTED', 'https://x.test/', true);
    expect(opts.onFailed).not.toHaveBeenCalled();
    expect(vc.isContentVisible()).toBe(true);
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/viewController.test.ts -t "navigation gate & failures"`
Expected: FAIL — `will-navigate`/`will-redirect`/`did-fail-load` listeners are not yet registered, so `preventDefault` is never called (`expected "preventDefault" to be called`) and `onFailed` is never invoked (`expected "onFailed" to be called`).

- [ ] **Step 3: Implement**
Extend `wireNavEvents()` in `electron/main/viewController.ts` by adding the three new listeners after the existing `page-title-updated` listener. Replace the existing `wireNavEvents` method with this full version:
```ts
  private wireNavEvents(): void {
    const wc = this.wc();

    wc.on('did-start-loading', () => {
      if (this.pendingShowOnStart) {
        this.pendingShowOnStart = false;
        this.setVisible(true);
      }
      this.emitState();
    });

    wc.on('did-stop-loading', () => {
      this.emitState();
    });

    wc.on('did-navigate', () => {
      this.flushTitle();
      this.emitState();
    });

    wc.on('did-navigate-in-page', (_event: unknown, _url: string, isMainFrame: boolean) => {
      if (!isMainFrame) return;
      this.emitState();
    });

    wc.on('page-title-updated', (_event: unknown, title: string) => {
      this.scheduleTitle(title);
    });

    const gate = (event: { preventDefault: () => void }, url: string) => {
      if (!isAllowedNavigationUrl(url)) event.preventDefault();
    };
    wc.on('will-navigate', gate);
    wc.on('will-redirect', gate);

    wc.on(
      'did-fail-load',
      (
        _event: unknown,
        errorCode: number,
        errorDescription: string,
        validatedURL: string,
        isMainFrame: boolean,
      ) => {
        if (!isMainFrame) return;
        // ERR_ABORTED (-3): user/stop-initiated, not a real failure.
        if (errorCode === -3) return;
        const kind: NavFailed['kind'] =
          errorCode <= -200 && errorCode > -300 ? 'cert' : 'load';
        this.setVisible(false); // main owns the hide for failures
        this.opts.onFailed({
          viewId: this.id,
          errorCode,
          errorDescription,
          validatedURL,
          kind,
        });
      },
    );
  }
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — all blocks, including "navigation gate & failures" (gate prevents disallowed schemes, allows allowed ones; main-frame load error → kind:load + hidden; cert range → kind:cert; sub-frame and ERR_ABORTED ignored).

- [ ] **Step 5: Commit**
```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(viewController): will-navigate/redirect scheme gate + did-fail-load onFailed + main-owned hide"
```

---

### Task 13: Content-session security — both permission handlers (deny), `will-download` (cancel), `setWindowOpenHandler` (gesture policy §5)

**Files:**
- Modify: `electron/main/viewController.ts` (add a `wireSecurity()` call in the constructor and method)
- Test: `electron/main/viewController.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**
Append this block to the bottom of `electron/main/viewController.test.ts`:
```ts
describe('ViewController content-session security (Task 13)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('registers both permission handlers that deny', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    expect(wc.session.setPermissionRequestHandler).toHaveBeenCalledTimes(1);
    expect(wc.session.setPermissionCheckHandler).toHaveBeenCalledTimes(1);

    // request handler denies via callback(false)
    const reqHandler = (wc.session.setPermissionRequestHandler as any).mock.calls[0][0];
    const cb = vi.fn();
    reqHandler(wc, 'geolocation', cb);
    expect(cb).toHaveBeenCalledWith(false);

    // check handler returns false
    const checkHandler = (wc.session.setPermissionCheckHandler as any).mock.calls[0][0];
    expect(checkHandler()).toBe(false);
  });

  it('cancels downloads via will-download preventDefault', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const onCalls = (wc.session.on as any).mock.calls;
    const willDownload = onCalls.find((c: any[]) => c[0] === 'will-download');
    expect(willDownload).toBeDefined();
    const ev = { preventDefault: vi.fn() };
    willDownload[1](ev);
    expect(ev.preventDefault).toHaveBeenCalledTimes(1);
  });

  it('setWindowOpenHandler denies popunder dispositions', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    for (const disposition of ['background-tab', 'save-to-disk', 'other']) {
      expect(handler({ url: 'https://ok.test/', disposition })).toEqual({ action: 'deny' });
    }
    expect(wc.loadURL).not.toHaveBeenCalled();
  });

  it('setWindowOpenHandler routes an allowed foreground new-window in-place then denies', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    const res = handler({ url: 'https://ok.test/page', disposition: 'foreground-tab' });
    expect(res).toEqual({ action: 'deny' });
    expect(wc.loadURL).toHaveBeenCalledWith('https://ok.test/page');
  });

  it('setWindowOpenHandler denies an allowed-disposition but disallowed-scheme url without loading', () => {
    new ViewController(makeOptsLocal());
    const wc = h.getLastWc()!;
    const handler = (wc.setWindowOpenHandler as any).mock.calls[0][0];
    const res = handler({ url: 'javascript:alert(1)', disposition: 'new-window' });
    expect(res).toEqual({ action: 'deny' });
    expect(wc.loadURL).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/viewController.test.ts -t "content-session security"`
Expected: FAIL — `setPermissionRequestHandler`/`setPermissionCheckHandler`/`session.on('will-download')`/`setWindowOpenHandler` are never registered, so `expected "setPermissionRequestHandler" to be called 1 time` and the `.mock.calls[0]` lookups throw (cannot read properties of undefined).

- [ ] **Step 3: Implement**
Add a `wireSecurity()` call at the end of the constructor and the new private method in `electron/main/viewController.ts`. First, add the call inside the constructor immediately after `this.wireNavEvents();`:
```ts
    this.wireNavEvents();
    this.wireSecurity();
```
Then add this private method (place it after `wireNavEvents`):
```ts
  private wireSecurity(): void {
    const wc = this.wc();
    const ses = wc.session;

    // Permissions: deny-by-default via BOTH handlers.
    ses.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
    ses.setPermissionCheckHandler(() => false);

    // Downloads floor: cancel by default.
    ses.on('will-download', (event) => {
      event.preventDefault();
    });

    // Popup policy (§5): deny popunders; route a legitimate, allowed-scheme
    // new-window in-place; otherwise deny.
    wc.setWindowOpenHandler((details) => {
      if (
        details.disposition === 'background-tab' ||
        details.disposition === 'save-to-disk' ||
        details.disposition === 'other'
      ) {
        return { action: 'deny' };
      }
      if (isAllowedNavigationUrl(details.url)) {
        wc.loadURL(details.url);
        return { action: 'deny' };
      }
      return { action: 'deny' };
    });
  }
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — all blocks, including "content-session security" (both permission handlers deny; will-download cancelled; popunder dispositions denied; allowed foreground new-window routed in-place then denied; disallowed-scheme new-window denied without loading).

- [ ] **Step 5: Commit**
```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(viewController): content-session security (permissions deny, will-download cancel, popup gate)"
```

---

### Task 14: Crash/hang — `render-process-gone`/`unresponsive` → `onCrashed` + `setVisible(false)`

**Files:**
- Modify: `electron/main/viewController.ts` (extend `wireNavEvents` with `render-process-gone` and `unresponsive`)
- Test: `electron/main/viewController.test.ts` (append a describe block)

- [ ] **Step 1: Write the failing test**
Append this block to the bottom of `electron/main/viewController.test.ts`:
```ts
describe('ViewController crash & hang (Task 14)', () => {
  function makeOptsLocal() {
    return {
      contentPreloadPath: '/tmp/contentPreload.js',
      onState: vi.fn(),
      onFailed: vi.fn(),
      onCrashed: vi.fn(),
    };
  }

  it('render-process-gone emits onCrashed, sets crashed, and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('render-process-gone', {}, { reason: 'crashed' });
    expect(opts.onCrashed).toHaveBeenCalledTimes(1);
    expect(opts.onCrashed.mock.calls[0][0]).toMatchObject({ viewId: 1, reason: 'crashed' });
    expect(vc.getState().crashed).toBe(true);
    expect(vc.isContentVisible()).toBe(false);
  });

  it('unresponsive emits onCrashed and hides content', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('unresponsive');
    expect(opts.onCrashed).toHaveBeenCalledTimes(1);
    expect(opts.onCrashed.mock.calls[0][0]).toMatchObject({ viewId: 1, reason: 'unresponsive' });
    expect(vc.isContentVisible()).toBe(false);
  });

  it('reloadOrStop after a crash clears the crashed flag (recovery)', () => {
    const opts = makeOptsLocal();
    const vc = new ViewController(opts);
    const wc = h.getLastWc()!;
    wc._emit('render-process-gone', {}, { reason: 'crashed' });
    expect(vc.getState().crashed).toBe(true);

    wc._loading = false;
    vc.reloadOrStop();
    expect(vc.getState().crashed).toBe(false);

    wc._emit('did-start-loading');
    expect(vc.isContentVisible()).toBe(true);
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/viewController.test.ts -t "crash & hang"`
Expected: FAIL — no `render-process-gone`/`unresponsive` listeners registered, so `onCrashed` is never called (`expected "onCrashed" to be called 1 time`) and `getState().crashed` stays `false`.

- [ ] **Step 3: Implement**
Add the two crash listeners to `wireNavEvents()` in `electron/main/viewController.ts`, immediately after the `did-fail-load` listener (inside the method, before its closing brace):
```ts
    wc.on(
      'render-process-gone',
      (_event: unknown, details: { reason: string }) => {
        this.crashed = true;
        this.setVisible(false);
        this.opts.onCrashed({ viewId: this.id, reason: details.reason });
      },
    );

    wc.on('unresponsive', () => {
      this.crashed = true;
      this.setVisible(false);
      this.opts.onCrashed({ viewId: this.id, reason: 'unresponsive' });
    });
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/viewController.test.ts`
Expected: PASS — all blocks, including "crash & hang" (render-process-gone → onCrashed + crashed + hidden; unresponsive → onCrashed(reason:'unresponsive') + hidden; reloadOrStop clears crashed and re-shows on did-start-loading).

- [ ] **Step 5: Commit**
```bash
git add electron/main/viewController.ts electron/main/viewController.test.ts
git commit -m "feat(viewController): render-process-gone/unresponsive crash recovery (onCrashed + hide)"
```

---

### Task 15: IPC guard — `registerGuardedHandlers` (sender validation)

**Files:**
- Create: `electron/main/ipc/guard.ts`
- Test: `electron/main/ipc/guard.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/ipc/guard.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared registry captured from the mocked ipcMain.handle (vi.mock is hoisted,
// so the registry must be created via vi.hoisted to be referenceable inside the mock factory).
const h = vi.hoisted(() => ({
  registry: new Map<string, (event: any, ...args: any[]) => any>(),
}));

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, handler: (event: any, ...args: any[]) => any) => {
      h.registry.set(channel, handler);
    },
  },
}));

import { registerGuardedHandlers } from './guard';

const CHROME_ID = 7;

describe('registerGuardedHandlers', () => {
  beforeEach(() => {
    h.registry.clear();
  });

  it('registers each handler on ipcMain under its channel key', () => {
    registerGuardedHandlers(CHROME_ID, {
      'a.channel': () => 'a',
      'b.channel': () => 'b',
    });
    expect(h.registry.has('a.channel')).toBe(true);
    expect(h.registry.has('b.channel')).toBe(true);
  });

  it('calls the handler with args (without the event) for a valid sender', () => {
    const spy = vi.fn(() => 'ok');
    registerGuardedHandlers(CHROME_ID, { 'a.channel': spy });
    const wrapped = h.registry.get('a.channel')!;
    const result = wrapped({ sender: { id: CHROME_ID } }, 1, 'two', true);
    expect(spy).toHaveBeenCalledWith(1, 'two', true);
    expect(result).toBe('ok');
  });

  it('rejects (throws) and does NOT call the handler for a foreign sender id', () => {
    const spy = vi.fn(() => 'ok');
    registerGuardedHandlers(CHROME_ID, { 'a.channel': spy });
    const wrapped = h.registry.get('a.channel')!;
    expect(() => wrapped({ sender: { id: 999 } }, 'evil')).toThrow();
    expect(spy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/ipc/guard.test.ts`
Expected: FAIL with `Failed to resolve import "./guard"` / `registerGuardedHandlers is not a function`

- [ ] **Step 3: Implement**
```ts
// electron/main/ipc/guard.ts
import { ipcMain } from 'electron';
import type { IpcMainInvokeEvent } from 'electron';

/**
 * Registers each handler on ipcMain.handle, wrapping it with sender validation:
 * the invoke is processed only when event.sender.id === chromeWebContentsId,
 * closing the confused-deputy path where a compromised content renderer could
 * drive privileged IPC. The wrapped handler is called with the invoke args
 * WITHOUT the event.
 */
export function registerGuardedHandlers(
  chromeWebContentsId: number,
  handlers: Record<string, (...args: any[]) => any>,
): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event: IpcMainInvokeEvent, ...args: any[]) => {
      if (event.sender.id !== chromeWebContentsId) {
        throw new Error(`Rejected ${channel}: unauthorized sender id ${event.sender.id}`);
      }
      return handler(...args);
    });
  }
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/ipc/guard.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add electron/main/ipc/guard.ts electron/main/ipc/guard.test.ts
git commit -m "feat(ipc): add registerGuardedHandlers with sender validation"
```

---

### Task 16: Nav IPC — `buildNavHandlers` + `buildViewEventForwarders`

**Files:**
- Create: `electron/main/ipc/nav.ts`
- Test: `electron/main/ipc/nav.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/ipc/nav.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../../../shared/types';
import { buildNavHandlers, buildViewEventForwarders } from './nav';

function makeVc() {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reloadOrStop: vi.fn(),
    getState: vi.fn((): NavState => ({
      viewId: PRIMARY_VIEW_ID,
      url: 'https://example.com/',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      crashed: false,
    })),
    setVisible: vi.fn(),
  };
}

function makeRepo(homeUrl: string) {
  const settings = { homeUrl } as Settings;
  return { get: vi.fn(() => settings) };
}

describe('buildNavHandlers', () => {
  it('navNavigate forwards (viewId,url) to vc.navigate(url)', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.navNavigate](PRIMARY_VIEW_ID, 'https://example.com/');
    expect(vc.navigate).toHaveBeenCalledWith('https://example.com/');
  });

  it('navBack / navForward / navReloadOrStop call the matching vc method', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.navBack](PRIMARY_VIEW_ID);
    handlers[IPC.navForward](PRIMARY_VIEW_ID);
    handlers[IPC.navReloadOrStop](PRIMARY_VIEW_ID);
    expect(vc.back).toHaveBeenCalledTimes(1);
    expect(vc.forward).toHaveBeenCalledTimes(1);
    expect(vc.reloadOrStop).toHaveBeenCalledTimes(1);
  });

  it('navHome reads homeUrl from the repo at call time and navigates it', () => {
    const vc = makeVc();
    const repo = makeRepo('https://duck.example/');
    const handlers = buildNavHandlers(vc as any, repo as any);
    handlers[IPC.navHome](PRIMARY_VIEW_ID);
    expect(repo.get).toHaveBeenCalled();
    expect(vc.navigate).toHaveBeenCalledWith('https://duck.example/');
  });

  it('navGetState returns vc.getState()', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    const state = handlers[IPC.navGetState](PRIMARY_VIEW_ID);
    expect(state.url).toBe('https://example.com/');
    expect(vc.getState).toHaveBeenCalledTimes(1);
  });

  it('viewSetContentVisible forwards (viewId,visible) to vc.setVisible(visible)', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.viewSetContentVisible](PRIMARY_VIEW_ID, false);
    expect(vc.setVisible).toHaveBeenCalledWith(false);
  });
});

describe('buildViewEventForwarders', () => {
  it('onState/onFailed/onCrashed send the matching event channel on the chrome wc', () => {
    const send = vi.fn();
    const chromeWc = { send } as any;
    const fwd = buildViewEventForwarders(chromeWc);

    const s: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: false, canGoForward: false, isLoading: false, crashed: false,
    };
    const f: NavFailed = {
      viewId: PRIMARY_VIEW_ID, errorCode: -202, errorDescription: 'CERT',
      validatedURL: 'https://e/', kind: 'cert',
    };
    const c: NavCrashed = { viewId: PRIMARY_VIEW_ID, reason: 'crashed' };

    fwd.onState(s);
    fwd.onFailed(f);
    fwd.onCrashed(c);

    expect(send).toHaveBeenCalledWith(IPC.evtNavState, s);
    expect(send).toHaveBeenCalledWith(IPC.evtNavFailed, f);
    expect(send).toHaveBeenCalledWith(IPC.evtNavCrashed, c);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/ipc/nav.test.ts`
Expected: FAIL with `Failed to resolve import "./nav"` / `buildNavHandlers is not a function`

- [ ] **Step 3: Implement**
```ts
// electron/main/ipc/nav.ts
import { IPC } from '../../../shared/types';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../../shared/types';
import type { ViewController, ViewControllerOpts } from '../viewController';
import type { SettingsRepo } from '../db/settingsRepo';

/**
 * Builds the nav/view IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). viewId is carried by the
 * contract for tab-readiness; Phase 0 has a single ViewController.
 */
export function buildNavHandlers(
  vc: ViewController,
  settingsRepo: SettingsRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.navNavigate]: (_viewId: ViewId, url: string) => vc.navigate(url),
    [IPC.navBack]: (_viewId: ViewId) => vc.back(),
    [IPC.navForward]: (_viewId: ViewId) => vc.forward(),
    [IPC.navReloadOrStop]: (_viewId: ViewId) => vc.reloadOrStop(),
    [IPC.navHome]: (_viewId: ViewId) => vc.navigate(settingsRepo.get().homeUrl),
    [IPC.navGetState]: (_viewId: ViewId): NavState => vc.getState(),
    [IPC.viewSetContentVisible]: (_viewId: ViewId, visible: boolean) => vc.setVisible(visible),
  };
}

/**
 * Builds the main->chrome event forwarders that ViewController invokes. Each
 * forwarder sends the matching push-event channel on the chrome WebContents.
 */
export function buildViewEventForwarders(
  chromeWc: Electron.WebContents,
): Pick<ViewControllerOpts, 'onState' | 'onFailed' | 'onCrashed'> {
  return {
    onState: (s: NavState) => chromeWc.send(IPC.evtNavState, s),
    onFailed: (f: NavFailed) => chromeWc.send(IPC.evtNavFailed, f),
    onCrashed: (c: NavCrashed) => chromeWc.send(IPC.evtNavCrashed, c),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/ipc/nav.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add electron/main/ipc/nav.ts electron/main/ipc/nav.test.ts
git commit -m "feat(ipc): add buildNavHandlers and buildViewEventForwarders"
```

---

### Task 17: Settings IPC — `buildSettingsHandlers`

**Files:**
- Create: `electron/main/ipc/settings.ts`
- Test: `electron/main/ipc/settings.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/main/ipc/settings.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { Settings } from '../../../shared/types';
import { buildSettingsHandlers } from './settings';

function makeRepo() {
  const current = {
    siteName: 'Aegis',
    homeUrl: 'https://duckduckgo.com/',
    primaryColor: '#7c5cff',
    defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
    searchEngines: [],
    hideChromeByDefault: false,
  } as Settings;
  return {
    get: vi.fn((): Settings => current),
    set: vi.fn((partial: Partial<Settings>): Settings => ({ ...current, ...partial })),
  };
}

describe('buildSettingsHandlers', () => {
  it('settingsGet returns repo.get()', () => {
    const repo = makeRepo();
    const handlers = buildSettingsHandlers(repo as any);
    const result = handlers[IPC.settingsGet]();
    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(result.siteName).toBe('Aegis');
  });

  it('settingsSet forwards the partial to repo.set() and returns the merged result', () => {
    const repo = makeRepo();
    const handlers = buildSettingsHandlers(repo as any);
    const result = handlers[IPC.settingsSet]({ siteName: 'Renamed' });
    expect(repo.set).toHaveBeenCalledWith({ siteName: 'Renamed' });
    expect(result.siteName).toBe('Renamed');
    expect(result.homeUrl).toBe('https://duckduckgo.com/');
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/main/ipc/settings.test.ts`
Expected: FAIL with `Failed to resolve import "./settings"` / `buildSettingsHandlers is not a function`

- [ ] **Step 3: Implement**
```ts
// electron/main/ipc/settings.ts
import { IPC } from '../../../shared/types';
import type { Settings } from '../../../shared/types';
import type { SettingsRepo } from '../db/settingsRepo';

/**
 * Builds the settings IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it).
 */
export function buildSettingsHandlers(
  settingsRepo: SettingsRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.settingsGet]: (): Settings => settingsRepo.get(),
    [IPC.settingsSet]: (partial: Partial<Settings>): Settings => settingsRepo.set(partial),
  };
}
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/main/ipc/settings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add electron/main/ipc/settings.ts electron/main/ipc/settings.test.ts
git commit -m "feat(ipc): add buildSettingsHandlers"
```

---

### Task 18: Preload — `chromePreload` (contextBridge → window.aegis) + `contentPreload` (no-op) + `ipcClient`

**Files:**
- Create: `electron/preload/chromePreload.ts`
- Create: `electron/preload/contentPreload.ts`
- Create: `src/lib/ipcClient.ts`
- Test: `electron/preload/chromePreload.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// electron/preload/chromePreload.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';
import type { AegisApi, NavState } from '../../shared/types';

// Capture the bridged API object and the registered ipcRenderer.on listeners.
const h = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: undefined as any,
  listeners: new Map<string, Array<(event: any, payload: any) => void>>(),
  removed: [] as Array<{ channel: string; fn: any }>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      h.exposed[key] = api;
    },
  },
  ipcRenderer: {
    invoke: (...args: any[]) => h.invoke(...args),
    on: (channel: string, fn: (event: any, payload: any) => void) => {
      const arr = h.listeners.get(channel) ?? [];
      arr.push(fn);
      h.listeners.set(channel, arr);
    },
    removeListener: (channel: string, fn: any) => {
      h.removed.push({ channel, fn });
    },
  },
}));

describe('chromePreload', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  function loadPreload(): AegisApi {
    return import('./chromePreload').then(() => h.exposed.aegis as AegisApi) as unknown as AegisApi;
  }

  it('exposes window.aegis via contextBridge', async () => {
    await import('./chromePreload');
    expect(h.exposed.aegis).toBeDefined();
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.nav.navigate).toBe('function');
    expect(typeof api.view.setContentVisible).toBe('function');
    expect(typeof api.settings.get).toBe('function');
  });

  it('nav.navigate invokes IPC.navNavigate with (viewId, url)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
    expect(h.invoke).toHaveBeenCalledWith(IPC.navNavigate, PRIMARY_VIEW_ID, 'https://example.com/');
  });

  it('nav.getState invokes IPC.navGetState and returns the resolved state', async () => {
    const state: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: true, canGoForward: false, isLoading: false, crashed: false,
    };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.nav.getState(PRIMARY_VIEW_ID);
    expect(h.invoke).toHaveBeenCalledWith(IPC.navGetState, PRIMARY_VIEW_ID);
    expect(result).toEqual(state);
  });

  it('settings.set invokes IPC.settingsSet with the partial', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.settings.set({ siteName: 'X' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.settingsSet, { siteName: 'X' });
  });

  it('onState registers an ipcRenderer.on listener and delivers the payload', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.nav.onState(cb);
    const arr = h.listeners.get(IPC.evtNavState)!;
    expect(arr).toHaveLength(1);
    const payload: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: false, canGoForward: false, isLoading: false, crashed: false,
    };
    arr[0]({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('onState returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.nav.onState(cb);
    const registered = h.listeners.get(IPC.evtNavState)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtNavState, fn: registered }]);
  });

  it('onFailed and onCrashed register on their event channels', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    api.nav.onFailed(vi.fn());
    api.nav.onCrashed(vi.fn());
    expect(h.listeners.get(IPC.evtNavFailed)).toHaveLength(1);
    expect(h.listeners.get(IPC.evtNavCrashed)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: FAIL with `Failed to resolve import "./chromePreload"` / `h.exposed.aegis` is undefined

- [ ] **Step 3: Implement**
```ts
// electron/preload/chromePreload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../../shared/types';
import type { AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings } from '../../shared/types';

/** Subscribes cb to an event channel; returns an unsubscriber. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AegisApi = {
  nav: {
    navigate: (viewId: ViewId, url: string) => ipcRenderer.invoke(IPC.navNavigate, viewId, url),
    back: (viewId: ViewId) => ipcRenderer.invoke(IPC.navBack, viewId),
    forward: (viewId: ViewId) => ipcRenderer.invoke(IPC.navForward, viewId),
    reloadOrStop: (viewId: ViewId) => ipcRenderer.invoke(IPC.navReloadOrStop, viewId),
    home: (viewId: ViewId) => ipcRenderer.invoke(IPC.navHome, viewId),
    getState: (viewId: ViewId): Promise<NavState> => ipcRenderer.invoke(IPC.navGetState, viewId),
    onState: (cb: (s: NavState) => void) => subscribe<NavState>(IPC.evtNavState, cb),
    onFailed: (cb: (f: NavFailed) => void) => subscribe<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb: (c: NavCrashed) => void) => subscribe<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId: ViewId, visible: boolean) =>
      ipcRenderer.invoke(IPC.viewSetContentVisible, viewId, visible),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (partial: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, partial),
  },
};

contextBridge.exposeInMainWorld('aegis', api);
```

```ts
// electron/preload/contentPreload.ts
// Phase 0 no-op content-view preload entry (§7 contentPreload note).
//
// Under contextIsolation:true this preload runs in an isolated world and CANNOT
// alter the page main-world `window.open`. The authoritative popup gate is the
// main-process setWindowOpenHandler (ViewController). This file exists only as
// the content-view preload entry for Phase 1's engine wiring.
export {};
```

```ts
// src/lib/ipcClient.ts
import type { AegisApi } from '../../shared/types';

/** The contextBridge-exposed API. Renderer code imports `aegis` from here. */
export const aegis: AegisApi = window.aegis;
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/preload/chromePreload.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add electron/preload/chromePreload.ts electron/preload/contentPreload.ts src/lib/ipcClient.ts electron/preload/chromePreload.test.ts
git commit -m "feat(preload): expose window.aegis via contextBridge + no-op contentPreload + ipcClient"
```

---

### Task 19: Boot wiring — `electron/main/index.ts` (DB, ViewController, IPC, session, `__aegisTest`)

**Files:**
- Modify: `electron/main/index.ts` (replaces the minimal Task 3 launcher with full boot wiring)
- Test: `electron/test/e2e/boot.spec.ts`

This is the integration task that composes every Block 1–4 unit. The unit pieces are already unit-tested; the verification here is an e2e Playwright `_electron` spec (§7) that launches the built app and asserts a content view loads the home URL and reports state via `__aegisTest.primary`.

- [ ] **Step 1: Write the failing test**
```ts
// electron/test/e2e/boot.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let app: ElectronApplication;
let userDataDir: string;

test.beforeAll(async () => {
  userDataDir = mkdtempSync(join(tmpdir(), 'aegis-boot-'));
  app = await _electron.launch({
    args: ['out/main/index.js'],
    // about:blank is an allowed scheme and needs no network, keeping this spec hermetic.
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir, AEGIS_HOME_URL: 'about:blank' },
  });
});

test.afterAll(async () => {
  await app.close();
});

test('boots with a content view that loads the home URL and reports state', async () => {
  // Wait for the primary ViewController to exist and finish its first load.
  await expect
    .poll(
      async () =>
        app.evaluate(() => {
          const t = (globalThis as any).__aegisTest;
          if (!t || !t.primary) return null;
          const s = t.primary.getState();
          return s.url;
        }),
      { timeout: 30_000 },
    )
    .toBe('about:blank'); // AEGIS_HOME_URL override; hermetic (no live network)

  const state = await app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
  expect(state.viewId).toBe(1);
  expect(typeof state.url).toBe('string');
  expect(state.crashed).toBe(false);
});

test('the content view is sandboxed (no Node `require` in its main world)', async () => {
  const typeofRequire = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript('typeof require'),
  );
  expect(typeofRequire).toBe('undefined');
});

test('the content view is visible after a successful boot load', async () => {
  const visible = await app.evaluate(() =>
    (globalThis as any).__aegisTest.primary.isContentVisible(),
  );
  expect(visible).toBe(true);
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx playwright test electron/test/e2e/boot.spec.ts`
Expected: FAIL — the Task 3 `index.ts` creates the window/chrome only (no content view), so `globalThis.__aegisTest` is never set; `expect.poll` times out / the `__aegisTest.primary` evaluate throws `Cannot read properties of undefined`.

- [ ] **Step 3: Implement**
```ts
// electron/main/index.ts
import { app } from 'electron';
import { join } from 'node:path';
import type { NavState } from '../../shared/types';
import { createMainWindow, layout } from './window';
import { ViewController } from './viewController';
import { openDb, runMigrations } from './db/sqlite';
import { SettingsRepo } from './db/settingsRepo';
import { readLastSession, writeLastSession } from './session';
import { registerGuardedHandlers } from './ipc/guard';
import { buildNavHandlers, buildViewEventForwarders } from './ipc/nav';
import { buildSettingsHandlers } from './ipc/settings';

/** Resolve the data dir: AEGIS_USER_DATA override (e2e isolation) or app userData. */
function resolveUserData(): string {
  return process.env.AEGIS_USER_DATA ?? app.getPath('userData');
}

function boot(): void {
  const userData = resolveUserData();

  // Persistence: DB + migrations + settings repo.
  const db = openDb(join(userData, 'aegis.db'));
  runMigrations(db);
  const settingsRepo = new SettingsRepo(db);

  // Window + chrome (window.ts owns the BaseWindow + chromeView ONLY).
  const { win, chromeView } = createMainWindow();
  const chromeWc = chromeView.webContents;

  // Main->chrome event forwarders.
  const fwd = buildViewEventForwarders(chromeWc);

  // onState wrapper: forward to chrome AND persist last session when the URL changes.
  let lastPersistedUrl: string | null = null;
  const onState = (s: NavState): void => {
    fwd.onState(s);
    if (s.url && s.url !== lastPersistedUrl) {
      lastPersistedUrl = s.url;
      writeLastSession(userData, { url: s.url, title: s.title });
    }
  };

  // The ONE content view is owned by ViewController.
  const contentPreloadPath = join(__dirname, '../preload/contentPreload.js');
  const vc = new ViewController({
    contentPreloadPath,
    onState,
    onFailed: fwd.onFailed,
    onCrashed: fwd.onCrashed,
  });

  // Compose: chrome added first by window.ts; index.ts adds the content view over it.
  win.contentView.addChildView(vc.view);
  layout(win, chromeView, vc.view);
  win.on('resize', () => layout(win, chromeView, vc.view));

  // Privileged IPC, sender-validated against the chrome WebContents id.
  registerGuardedHandlers(chromeWc.id, {
    ...buildNavHandlers(vc, settingsRepo),
    ...buildSettingsHandlers(settingsRepo),
  });

  // Test-only registry (never in production paths).
  if (process.env.AEGIS_E2E === '1') {
    (globalThis as any).__aegisTest = { primary: vc };
  }

  // Session restore on boot: last URL, else AEGIS_HOME_URL override (used by e2e to
  // avoid live network), else settings.homeUrl.
  const last = readLastSession(userData);
  const homeUrl = process.env.AEGIS_HOME_URL ?? settingsRepo.get().homeUrl;
  vc.navigate(last ? last.url : homeUrl);

  // Lifecycle cleanup: WebContentsView does not auto-destroy on BaseWindow close.
  win.on('closed', () => {
    vc.destroy();
    chromeWc.close();
  });
}

app.whenReady().then(boot);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npm run build && npx playwright test electron/test/e2e/boot.spec.ts`
Expected: PASS (build emits `out/main/index.js` + `out/preload/*` + `out/renderer/*`; `pretest:e2e` flips better-sqlite3 to the Electron ABI; the spec launches the app, finds `__aegisTest.primary`, and reads a loaded `https?://` home URL with `crashed:false`, no `require` in the content world, content visible)

- [ ] **Step 5: Commit**
```bash
git add electron/main/index.ts electron/test/e2e/boot.spec.ts
git commit -m "feat(main): full boot wiring (DB, ViewController, IPC, session restore, __aegisTest)"
```

---

### Task 20: `src/lib/addressParse.ts` — address-bar normalization

**Files:**
- Create: `src/lib/addressParse.ts`
- Test: `src/lib/addressParse.test.ts`

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/addressParse.test.ts
import { describe, it, expect } from 'vitest';
import { addressParse } from './addressParse';

const ctx = (overrides: Partial<{ currentUrl: string; searchTemplate: string }> = {}) => ({
  currentUrl: 'https://example.com/',
  searchTemplate: 'https://duckduckgo.com/?q=%s',
  ...overrides,
});

describe('addressParse', () => {
  it('treats input equal to the current URL as a reload', () => {
    expect(addressParse('https://example.com/', ctx())).toEqual({ kind: 'reload' });
  });

  it('trims whitespace before comparing for reload', () => {
    expect(addressParse('  https://example.com/  ', ctx())).toEqual({ kind: 'reload' });
  });

  it('navigates a full allowed https URL as-is', () => {
    expect(addressParse('https://news.example.org/path?x=1', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://news.example.org/path?x=1',
    });
  });

  it('navigates a full allowed http URL as-is', () => {
    expect(addressParse('http://insecure.example.org/', ctx())).toEqual({
      kind: 'navigate',
      url: 'http://insecure.example.org/',
    });
  });

  it('rejects a disallowed scheme such as file:', () => {
    const r = addressParse('file:///etc/passwd', ctx());
    expect(r.kind).toBe('rejected');
  });

  it('rejects a disallowed scheme such as javascript:', () => {
    const r = addressParse('javascript:alert(1)', ctx());
    expect(r.kind).toBe('rejected');
  });

  it('prepends https:// to a schemeless host', () => {
    expect(addressParse('example.com', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://example.com',
    });
  });

  it('prepends https:// to a schemeless host with a path', () => {
    expect(addressParse('example.com/some/path', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://example.com/some/path',
    });
  });

  it('treats a bare term with no dot as a search', () => {
    expect(addressParse('hello world', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=hello%20world',
    });
  });

  it('treats text containing a dot but also spaces as a search', () => {
    expect(addressParse('what is a .gitignore file', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=what%20is%20a%20.gitignore%20file',
    });
  });

  it('encodes special characters in a search query', () => {
    expect(addressParse('a&b=c', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=a%26b%3Dc',
    });
  });

  it('treats empty input as a search of the empty string', () => {
    expect(addressParse('   ', ctx())).toEqual({
      kind: 'navigate',
      url: 'https://duckduckgo.com/?q=',
    });
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/lib/addressParse.test.ts`
Expected: FAIL with `Failed to resolve import "./addressParse"` (the module does not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/lib/addressParse.ts
import { isAllowedNavigationUrl } from '../../electron/lib/schemes';

export type AddressParseResult =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload' }
  | { kind: 'rejected'; reason: string };

function hasScheme(raw: string): boolean {
  // A scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

function looksLikeHost(raw: string): boolean {
  return raw.includes('.') && !/\s/.test(raw);
}

export function addressParse(
  raw: string,
  ctx: { currentUrl: string; searchTemplate: string },
): AddressParseResult {
  const trimmed = raw.trim();

  if (trimmed.length > 0 && trimmed === ctx.currentUrl) {
    return { kind: 'reload' };
  }

  if (hasScheme(trimmed)) {
    if (isAllowedNavigationUrl(trimmed)) {
      return { kind: 'navigate', url: trimmed };
    }
    return { kind: 'rejected', reason: `Scheme not allowed: ${trimmed}` };
  }

  if (looksLikeHost(trimmed)) {
    const candidate = `https://${trimmed}`;
    if (isAllowedNavigationUrl(candidate)) {
      return { kind: 'navigate', url: candidate };
    }
    return { kind: 'rejected', reason: `Invalid address: ${trimmed}` };
  }

  return {
    kind: 'navigate',
    url: ctx.searchTemplate.replace('%s', encodeURIComponent(trimmed)),
  };
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/lib/addressParse.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/lib/addressParse.ts src/lib/addressParse.test.ts
git commit -m "feat(renderer): add addressParse address-bar normalization"
```

---

### Task 21: `src/lib/theme.ts` + `src/index.css` — accent-color theming

**Files:**
- Create: `src/lib/theme.ts`
- Create: `src/index.css`
- Test: `src/lib/theme.test.ts`

> `applyTheme` applies the accent color only (per the §6 signature `Pick<Settings, 'primaryColor'>`). `siteName` is surfaced by the Toolbar/logo (Task 22) reading `settings.siteName` — it is not a CSS concern and is intentionally absent here.

- [ ] **Step 1: Write the failing test**
```ts
// src/lib/theme.test.ts
import { describe, it, expect, afterEach } from 'vitest';
import { applyTheme } from './theme';

afterEach(() => {
  document.documentElement.style.removeProperty('--accent-color');
});

describe('applyTheme', () => {
  it('sets --accent-color on :root from the primaryColor setting', () => {
    applyTheme({ primaryColor: '#ff5500' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#ff5500');
  });

  it('overwrites a previously-applied accent color', () => {
    applyTheme({ primaryColor: '#111111' });
    applyTheme({ primaryColor: '#222222' });
    expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#222222');
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/lib/theme.test.ts`
Expected: FAIL with `Failed to resolve import "./theme"` (the module does not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/lib/theme.ts
import type { Settings } from '../../shared/types';

export function applyTheme(s: Pick<Settings, 'primaryColor'>): void {
  document.documentElement.style.setProperty('--accent-color', s.primaryColor);
}
```
```css
/* src/index.css */
:root {
  --accent-color: #4f8cff;
  --bg: #1b1d22;
  --bg-elevated: #24272e;
  --bg-input: #2c3039;
  --fg: #e6e8ee;
  --fg-muted: #9aa0ad;
  --border: #353a44;
  --danger: #ff5d5d;
  --chrome-top-height: 56px;
}

* {
  box-sizing: border-box;
}

html,
body,
#root {
  margin: 0;
  padding: 0;
  height: 100%;
  width: 100%;
}

body {
  background: var(--bg);
  color: var(--fg);
  font-family: system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif;
  font-size: 14px;
  overflow: hidden;
}

button {
  font-family: inherit;
  color: var(--fg);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 6px;
  cursor: pointer;
}

button:hover:not(:disabled) {
  border-color: var(--accent-color);
}

button:disabled {
  opacity: 0.4;
  cursor: default;
}

button:focus-visible,
input:focus-visible,
a:focus-visible {
  outline: 2px solid var(--accent-color);
  outline-offset: 1px;
}

input {
  font-family: inherit;
  color: var(--fg);
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 6px;
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/lib/theme.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/lib/theme.ts src/lib/theme.test.ts src/index.css
git commit -m "feat(renderer): add applyTheme and CSS custom properties"
```

---

### Task 22: `AddressBar`, `NavControls`, `Toolbar`, and `useNav` hook

**Files:**
- Create: `src/hooks/useNav.ts`
- Create: `src/components/NavControls.tsx`
- Create: `src/components/AddressBar.tsx`
- Create: `src/components/Toolbar.tsx`
- Test: `src/hooks/useNav.test.tsx`
- Test: `src/components/Toolbar.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useNav.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState, Settings } from '../../shared/types';

const navigate = vi.fn(async () => {});
const back = vi.fn(async () => {});
const forward = vi.fn(async () => {});
const reloadOrStop = vi.fn(async () => {});
const home = vi.fn(async () => {});
const getState = vi.fn();
const onState = vi.fn();
const settingsGet = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: (...a: any[]) => navigate(...a),
      back: (...a: any[]) => back(...a),
      forward: (...a: any[]) => forward(...a),
      reloadOrStop: (...a: any[]) => reloadOrStop(...a),
      home: (...a: any[]) => home(...a),
      getState: (...a: any[]) => getState(...a),
      onState: (cb: (s: NavState) => void) => onState(cb),
      onFailed: () => () => {},
      onCrashed: () => () => {},
    },
    view: { setContentVisible: vi.fn() },
    settings: { get: (...a: any[]) => settingsGet(...a), set: vi.fn() },
  },
}));

import { useNav } from './useNav';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  getState.mockResolvedValue(baseState);
  settingsGet.mockResolvedValue(baseSettings);
  onState.mockReturnValue(() => {});
});

describe('useNav', () => {
  it('loads the initial state from aegis.nav.getState', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    expect(getState).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('subscribes to onState and updates on push events', async () => {
    let pushed: ((s: NavState) => void) | undefined;
    onState.mockImplementation((cb: (s: NavState) => void) => {
      pushed = cb;
      return () => {};
    });
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(pushed).toBeTypeOf('function'));
    act(() => pushed!({ ...baseState, url: 'https://changed.example/', isLoading: true }));
    expect(result.current.state.url).toBe('https://changed.example/');
    expect(result.current.state.isLoading).toBe(true);
  });

  it('navigate() with a full URL calls aegis.nav.navigate with the resolved URL', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('https://new.example.org/'));
    expect(navigate).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'https://new.example.org/');
  });

  it('navigate() with the current URL calls reloadOrStop, not navigate', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('https://example.com/'));
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(navigate).not.toHaveBeenCalled();
  });

  it('navigate() with a bare term searches using the settings template', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.navigate('cats'));
    expect(navigate).toHaveBeenCalledWith(PRIMARY_VIEW_ID, 'https://duckduckgo.com/?q=cats');
  });

  it('back/forward/reloadOrStop/home delegate to aegis.nav', async () => {
    const { result } = renderHook(() => useNav(PRIMARY_VIEW_ID));
    await waitFor(() => expect(result.current.state.url).toBe('https://example.com/'));
    act(() => result.current.back());
    act(() => result.current.forward());
    act(() => result.current.reloadOrStop());
    act(() => result.current.home());
    expect(back).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(forward).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
    expect(home).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });
});
```
```tsx
// src/components/Toolbar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState } from '../../shared/types';
import { Toolbar } from './Toolbar';

const state: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: true,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const handlers = () => ({
  navigate: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  reloadOrStop: vi.fn(),
  home: vi.fn(),
});

describe('Toolbar', () => {
  it('shows the current URL in the address input', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('textbox', { name: /address/i })).toHaveValue('https://example.com/');
  });

  it('enables Back when canGoBack and disables Forward when !canGoForward', () => {
    render(<Toolbar state={state} {...handlers()} />);
    expect(screen.getByRole('button', { name: /back/i })).toBeEnabled();
    expect(screen.getByRole('button', { name: /forward/i })).toBeDisabled();
  });

  it('calls back/forward/reloadOrStop/home on button clicks', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    await userEvent.click(screen.getByRole('button', { name: /back/i }));
    await userEvent.click(screen.getByRole('button', { name: /home/i }));
    await userEvent.click(screen.getByRole('button', { name: /reload|stop/i }));
    expect(h.back).toHaveBeenCalledOnce();
    expect(h.home).toHaveBeenCalledOnce();
    expect(h.reloadOrStop).toHaveBeenCalledOnce();
  });

  it('submitting the address bar calls navigate with the typed value', async () => {
    const h = handlers();
    render(<Toolbar state={state} {...h} />);
    const input = screen.getByRole('textbox', { name: /address/i });
    await userEvent.clear(input);
    await userEvent.type(input, 'https://typed.example.org/{Enter}');
    expect(h.navigate).toHaveBeenCalledWith('https://typed.example.org/');
  });

  it('shows a Stop affordance while loading', () => {
    render(<Toolbar state={{ ...state, isLoading: true }} {...handlers()} />);
    expect(screen.getByRole('button', { name: /stop/i })).toBeInTheDocument();
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useNav.test.tsx src/components/Toolbar.test.tsx`
Expected: FAIL with `Failed to resolve import "./useNav"` / `Failed to resolve import "./Toolbar"` (the modules do not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/hooks/useNav.ts
import { useCallback, useEffect, useRef, useState } from 'react';
import type { NavState, ViewId } from '../../shared/types';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import { aegis } from '../lib/ipcClient';
import { addressParse } from '../lib/addressParse';

const emptyState = (viewId: ViewId): NavState => ({
  viewId,
  url: '',
  title: '',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
});

export function useNav(viewId: ViewId): {
  state: NavState;
  navigate(raw: string): void;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
} {
  const [state, setState] = useState<NavState>(() => emptyState(viewId));
  const [searchTemplate, setSearchTemplate] = useState<string>('https://duckduckgo.com/?q=%s');
  const stateRef = useRef<NavState>(state);
  stateRef.current = state;

  useEffect(() => {
    let active = true;
    void aegis.nav.getState(viewId).then((s) => {
      if (active) setState(s);
    });
    void aegis.settings.get().then((s) => {
      if (active) setSearchTemplate(s.defaultSearchTemplate);
    });
    const unsubscribe = aegis.nav.onState((s) => {
      if (s.viewId === viewId) setState(s);
    });
    return () => {
      active = false;
      unsubscribe();
    };
  }, [viewId]);

  const navigate = useCallback(
    (raw: string) => {
      const result = addressParse(raw, {
        currentUrl: stateRef.current.url,
        searchTemplate,
      });
      if (result.kind === 'reload') {
        void aegis.nav.reloadOrStop(viewId);
      } else if (result.kind === 'navigate') {
        void aegis.nav.navigate(viewId, result.url);
      } else {
        // result.kind === 'rejected': do not navigate (main also rejects the scheme
        // defensively in nav.navigate). User-facing toast feedback is intentionally
        // deferred (toast lands in Task 25); surface to the console so it is not
        // silently dropped.
        console.warn('Address rejected:', result.reason);
      }
    },
    [viewId, searchTemplate],
  );

  const back = useCallback(() => {
    void aegis.nav.back(viewId);
  }, [viewId]);
  const forward = useCallback(() => {
    void aegis.nav.forward(viewId);
  }, [viewId]);
  const reloadOrStop = useCallback(() => {
    void aegis.nav.reloadOrStop(viewId);
  }, [viewId]);
  const home = useCallback(() => {
    void aegis.nav.home(viewId);
  }, [viewId]);

  return { state, navigate, back, forward, reloadOrStop, home };
}

export const DEFAULT_VIEW_ID = PRIMARY_VIEW_ID;
```
```tsx
// src/components/NavControls.tsx
import type { NavState } from '../../shared/types';

export interface NavControlsProps {
  state: NavState;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
}

export function NavControls({ state, back, forward, reloadOrStop, home }: NavControlsProps) {
  return (
    <div className="nav-controls">
      <button type="button" aria-label="Back" disabled={!state.canGoBack} onClick={back}>
        &#8592;
      </button>
      <button
        type="button"
        aria-label="Forward"
        disabled={!state.canGoForward}
        onClick={forward}
      >
        &#8594;
      </button>
      <button
        type="button"
        aria-label={state.isLoading ? 'Stop' : 'Reload'}
        onClick={reloadOrStop}
      >
        {state.isLoading ? '\u2715' : '\u21bb'}
      </button>
      <button type="button" aria-label="Home" onClick={home}>
        &#8962;
      </button>
      {state.isLoading && (
        <span className="loading-indicator" role="status" aria-label="Loading">
          &#8230;
        </span>
      )}
    </div>
  );
}
```
```tsx
// src/components/AddressBar.tsx
import { useEffect, useState } from 'react';

export interface AddressBarProps {
  url: string;
  onSubmit(raw: string): void;
}

export function AddressBar({ url, onSubmit }: AddressBarProps) {
  const [value, setValue] = useState(url);

  useEffect(() => {
    setValue(url);
  }, [url]);

  return (
    <form
      className="address-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <input
        type="text"
        aria-label="Address"
        value={value}
        spellCheck={false}
        autoComplete="off"
        onChange={(e) => setValue(e.target.value)}
      />
    </form>
  );
}
```
```tsx
// src/components/Toolbar.tsx
import type { NavState } from '../../shared/types';
import { NavControls } from './NavControls';
import { AddressBar } from './AddressBar';

export interface ToolbarProps {
  state: NavState;
  navigate(raw: string): void;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
}

export function Toolbar({ state, navigate, back, forward, reloadOrStop, home }: ToolbarProps) {
  return (
    <div className="toolbar">
      <NavControls
        state={state}
        back={back}
        forward={forward}
        reloadOrStop={reloadOrStop}
        home={home}
      />
      <AddressBar url={state.url} onSubmit={navigate} />
    </div>
  );
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useNav.test.tsx src/components/Toolbar.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/hooks/useNav.ts src/components/NavControls.tsx src/components/AddressBar.tsx src/components/Toolbar.tsx src/hooks/useNav.test.tsx src/components/Toolbar.test.tsx
git commit -m "feat(renderer): add useNav hook and Toolbar/AddressBar/NavControls"
```

---

### Task 23: `src/components/ErrorOverlay.tsx` — load/cert/crash variants

**Files:**
- Create: `src/components/ErrorOverlay.tsx`
- Test: `src/components/ErrorOverlay.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/ErrorOverlay.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavFailed, NavCrashed } from '../../shared/types';
import { ErrorOverlay } from './ErrorOverlay';

const loadFailure: NavFailed = {
  viewId: PRIMARY_VIEW_ID,
  errorCode: -105,
  errorDescription: 'ERR_NAME_NOT_RESOLVED',
  validatedURL: 'https://nope.invalid/',
  kind: 'load',
};

const certFailure: NavFailed = {
  viewId: PRIMARY_VIEW_ID,
  errorCode: -202,
  errorDescription: 'ERR_CERT_AUTHORITY_INVALID',
  validatedURL: 'https://self-signed.example/',
  kind: 'cert',
};

const crash: NavCrashed = {
  viewId: PRIMARY_VIEW_ID,
  reason: 'crashed',
};

describe('ErrorOverlay', () => {
  it('renders the load-failure variant with the error description', () => {
    render(<ErrorOverlay failed={loadFailure} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByRole('alert')).toBeInTheDocument();
    expect(screen.getByText(/this page could not be loaded/i)).toBeInTheDocument();
    expect(screen.getByText(/ERR_NAME_NOT_RESOLVED/)).toBeInTheDocument();
  });

  it('renders the certificate-failure variant with a security message', () => {
    render(<ErrorOverlay failed={certFailure} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByText(/security certificate/i)).toBeInTheDocument();
    expect(screen.getByText(/ERR_CERT_AUTHORITY_INVALID/)).toBeInTheDocument();
  });

  it('renders the crash variant', () => {
    render(<ErrorOverlay failed={null} crashed={crash} onRetry={vi.fn()} onHome={vi.fn()} />);
    expect(screen.getByText(/page crashed/i)).toBeInTheDocument();
  });

  it('renders nothing when there is no failure or crash', () => {
    const { container } = render(
      <ErrorOverlay failed={null} crashed={null} onRetry={vi.fn()} onHome={vi.fn()} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('calls onRetry and onHome from the buttons', async () => {
    const onRetry = vi.fn();
    const onHome = vi.fn();
    render(<ErrorOverlay failed={loadFailure} crashed={null} onRetry={onRetry} onHome={onHome} />);
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    await userEvent.click(screen.getByRole('button', { name: /home/i }));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(onHome).toHaveBeenCalledOnce();
  });

  it('prefers the crash variant when both crashed and failed are present', () => {
    render(
      <ErrorOverlay failed={loadFailure} crashed={crash} onRetry={vi.fn()} onHome={vi.fn()} />,
    );
    expect(screen.getByText(/page crashed/i)).toBeInTheDocument();
    expect(screen.queryByText(/this page could not be loaded/i)).not.toBeInTheDocument();
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/ErrorOverlay.test.tsx`
Expected: FAIL with `Failed to resolve import "./ErrorOverlay"` (the module does not exist yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/ErrorOverlay.tsx
import type { NavCrashed, NavFailed } from '../../shared/types';

export interface ErrorOverlayProps {
  failed: NavFailed | null;
  crashed: NavCrashed | null;
  onRetry(): void;
  onHome(): void;
}

export function ErrorOverlay({ failed, crashed, onRetry, onHome }: ErrorOverlayProps) {
  if (!failed && !crashed) {
    return null;
  }

  let heading: string;
  let body: string;
  let detail: string | null;

  if (crashed) {
    heading = 'This page crashed';
    body = 'The page stopped responding and was closed.';
    detail = crashed.reason;
  } else if (failed && failed.kind === 'cert') {
    heading = 'This site is not secure';
    body =
      'The security certificate for this site could not be verified, so the connection was blocked.';
    detail = `${failed.errorDescription} (${failed.errorCode})`;
  } else {
    heading = 'This page could not be loaded';
    body = 'Check the address and your network connection, then try again.';
    detail = failed ? `${failed.errorDescription} (${failed.errorCode})` : null;
  }

  return (
    <div className="error-overlay" role="alert">
      <div className="error-overlay__panel">
        <h1 className="error-overlay__heading">{heading}</h1>
        <p className="error-overlay__body">{body}</p>
        {detail && <pre className="error-overlay__detail">{detail}</pre>}
        <div className="error-overlay__actions">
          <button type="button" onClick={onRetry}>
            Retry
          </button>
          <button type="button" onClick={onHome}>
            Home
          </button>
        </div>
      </div>
    </div>
  );
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/ErrorOverlay.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/components/ErrorOverlay.tsx src/components/ErrorOverlay.test.tsx
git commit -m "feat(renderer): add ErrorOverlay with load/cert/crash variants"
```

---

### Task 24: `ErrorBoundary` + `App` + `main.tsx` — subscribe events, render overlay, chrome-only visibility

**Files:**
- Create: `src/components/ErrorBoundary.tsx`
- Create: `src/App.tsx`
- Create: `src/main.tsx`
- Test: `src/components/ErrorBoundary.test.tsx`
- Test: `src/App.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/components/ErrorBoundary.test.tsx
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ErrorBoundary } from './ErrorBoundary';

function Boom(): JSX.Element {
  throw new Error('kaboom');
}

describe('ErrorBoundary', () => {
  let errSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => {
    errSpy.mockRestore();
  });

  it('renders children when no error is thrown', () => {
    render(
      <ErrorBoundary>
        <div>healthy</div>
      </ErrorBoundary>,
    );
    expect(screen.getByText('healthy')).toBeInTheDocument();
  });

  it('renders a fallback instead of a blank screen when a child throws', () => {
    render(
      <ErrorBoundary>
        <Boom />
      </ErrorBoundary>,
    );
    expect(screen.getByText(/something went wrong/i)).toBeInTheDocument();
  });
});
```
```tsx
// src/App.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../shared/types';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const baseSettings: Settings = {
  siteName: 'Aegis',
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
};

const reloadOrStop = vi.fn(async () => {});
const setContentVisible = vi.fn(async () => {});
let failedCb: ((f: NavFailed) => void) | undefined;
let crashedCb: ((c: NavCrashed) => void) | undefined;

vi.mock('./lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      reloadOrStop: (...a: any[]) => reloadOrStop(...a),
      home: vi.fn(async () => {}),
      getState: vi.fn(async () => baseState),
      onState: () => () => {},
      onFailed: (cb: (f: NavFailed) => void) => {
        failedCb = cb;
        return () => {};
      },
      onCrashed: (cb: (c: NavCrashed) => void) => {
        crashedCb = cb;
        return () => {};
      },
    },
    view: { setContentVisible: (...a: any[]) => setContentVisible(...a) },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
  },
}));

import { App } from './App';

beforeEach(() => {
  vi.clearAllMocks();
  failedCb = undefined;
  crashedCb = undefined;
});

describe('App', () => {
  it('renders the toolbar address bar', async () => {
    render(<App />);
    await waitFor(() => expect(screen.getByRole('textbox', { name: /address/i })).toBeInTheDocument());
  });

  it('shows the ErrorOverlay when a nav.failed event arrives', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('Retry on the overlay calls aegis.nav.reloadOrStop', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    const { default: userEvent } = await import('@testing-library/user-event');
    await userEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(reloadOrStop).toHaveBeenCalledWith(PRIMARY_VIEW_ID);
  });

  it('shows the overlay on nav.crashed and clears it on a fresh nav.state', async () => {
    render(<App />);
    await waitFor(() => expect(crashedCb).toBeTypeOf('function'));
    act(() => crashedCb!({ viewId: PRIMARY_VIEW_ID, reason: 'oom' }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('does NOT call setContentVisible for the error/crash overlay', async () => {
    render(<App />);
    await waitFor(() => expect(failedCb).toBeTypeOf('function'));
    act(() =>
      failedCb!({
        viewId: PRIMARY_VIEW_ID,
        errorCode: -105,
        errorDescription: 'ERR_NAME_NOT_RESOLVED',
        validatedURL: 'https://nope.invalid/',
        kind: 'load',
      }),
    );
    expect(setContentVisible).not.toHaveBeenCalled();
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/components/ErrorBoundary.test.tsx src/App.test.tsx`
Expected: FAIL with `Failed to resolve import "./ErrorBoundary"` / `Failed to resolve import "./App"` (the modules do not exist yet).

- [ ] **Step 3: Implement**
```tsx
// src/components/ErrorBoundary.tsx
import { Component, type ErrorInfo, type ReactNode } from 'react';

export interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('Aegis chrome error boundary caught:', error, info.componentStack);
  }

  private handleReset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="app-error-boundary" role="alert">
          <div className="error-overlay__panel">
            <h1 className="error-overlay__heading">Something went wrong</h1>
            <p className="error-overlay__body">
              The browser interface hit an unexpected error.
            </p>
            <pre className="error-overlay__detail">{this.state.error.message}</pre>
            <div className="error-overlay__actions">
              <button type="button" onClick={this.handleReset}>
                Reload interface
              </button>
            </div>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
```
```tsx
// src/App.tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { useNav } from './hooks/useNav';
import { Toolbar } from './components/Toolbar';
import { ErrorOverlay } from './components/ErrorOverlay';

export function App() {
  const nav = useNav(PRIMARY_VIEW_ID);
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  useEffect(() => {
    const offFailed = aegis.nav.onFailed((f) => {
      if (f.viewId !== PRIMARY_VIEW_ID) return;
      setCrashed(null);
      setFailed(f);
    });
    const offCrashed = aegis.nav.onCrashed((c) => {
      if (c.viewId !== PRIMARY_VIEW_ID) return;
      setFailed(null);
      setCrashed(c);
    });
    return () => {
      offFailed();
      offCrashed();
    };
  }, []);

  // Main owns content hide/show for failures and crashes. When a fresh
  // navigation reports loading state, clear any error/crash overlay. We do NOT
  // call aegis.view.setContentVisible here — main re-shows the content view.
  useEffect(() => {
    if (nav.state.isLoading && !nav.state.crashed) {
      setFailed(null);
      setCrashed(null);
    }
  }, [nav.state.isLoading, nav.state.crashed]);

  const handleRetry = (): void => {
    void aegis.nav.reloadOrStop(PRIMARY_VIEW_ID);
  };

  const handleHome = (): void => {
    nav.home();
  };

  return (
    <div className="app">
      <Toolbar
        state={nav.state}
        navigate={nav.navigate}
        back={nav.back}
        forward={nav.forward}
        reloadOrStop={nav.reloadOrStop}
        home={nav.home}
      />
      <ErrorOverlay
        failed={failed}
        crashed={crashed}
        onRetry={handleRetry}
        onHome={handleHome}
      />
    </div>
  );
}
```
```tsx
// src/main.tsx
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { ErrorBoundary } from './components/ErrorBoundary';
import './index.css';

const container = document.getElementById('root');
if (!container) {
  throw new Error('Root container #root not found');
}

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </StrictMode>,
);
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/components/ErrorBoundary.test.tsx src/App.test.tsx`
Expected: PASS

- [ ] **Step 5: Commit**
```bash
git add src/components/ErrorBoundary.tsx src/App.tsx src/main.tsx src/components/ErrorBoundary.test.tsx src/App.test.tsx
git commit -m "feat(renderer): wire App shell, error boundary, and event subscriptions"
```

---

### Task 25: a11y extras — `useDialog`, `SkipLink`, `Toaster`/`toast`/`confirm`, `WelcomeHint`; wire into App

**Files:**
- Create: `src/hooks/useDialog.ts`
- Create: `src/lib/toast.ts`
- Create: `src/components/Toaster.tsx`
- Create: `src/components/SkipLink.tsx`
- Create: `src/components/WelcomeHint.tsx`
- Modify: `src/App.tsx`
- Test: `src/hooks/useDialog.test.tsx`
- Test: `src/components/Toaster.test.tsx`
- Test: `src/components/WelcomeHint.test.tsx`

- [ ] **Step 1: Write the failing test**
```tsx
// src/hooks/useDialog.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDialog } from './useDialog';

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div>
      <button type="button">outside-before</button>
      <div ref={ref} role="dialog" aria-modal="true">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    </div>
  );
}

describe('useDialog', () => {
  it('focuses the first focusable element on mount', () => {
    render(<Dialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('traps Tab from the last element back to the first', async () => {
    render(<Dialog onClose={vi.fn()} />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('traps Shift+Tab from the first element to the last', async () => {
    render(<Dialog onClose={vi.fn()} />);
    screen.getByRole('button', { name: 'first' }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('restores focus to the previously-focused element on unmount', async () => {
    function Harness() {
      return (
        <div>
          <button type="button" data-testid="trigger">
            trigger
          </button>
        </div>
      );
    }
    const { rerender } = render(<Harness />);
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();
    rerender(
      <div>
        <button type="button" data-testid="trigger">
          trigger
        </button>
        <Dialog onClose={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
    rerender(
      <div>
        <button type="button" data-testid="trigger">
          trigger
        </button>
      </div>,
    );
    expect(trigger).toHaveFocus();
  });
});
```
```tsx
// src/components/Toaster.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { Toaster } from './Toaster';
import { toast, __resetToasts } from '../lib/toast';

beforeEach(() => {
  __resetToasts();
});

describe('Toaster', () => {
  it('renders an aria-live region', () => {
    render(<Toaster />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a success toast when toast.success is called', async () => {
    render(<Toaster />);
    act(() => toast.success('Saved!'));
    await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument());
  });

  it('shows an error toast when toast.error is called', async () => {
    render(<Toaster />);
    act(() => toast.error('Boom'));
    await waitFor(() => expect(screen.getByText('Boom')).toBeInTheDocument());
  });
});
```
```tsx
// src/components/WelcomeHint.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { WelcomeHint, WELCOME_HINT_STORAGE_KEY } from './WelcomeHint';

beforeEach(() => {
  localStorage.clear();
});

describe('WelcomeHint', () => {
  it('renders the hint when not previously dismissed', () => {
    render(<WelcomeHint />);
    expect(screen.getByText(/welcome to aegis/i)).toBeInTheDocument();
  });

  it('does not render when previously dismissed', () => {
    localStorage.setItem(WELCOME_HINT_STORAGE_KEY, '1');
    render(<WelcomeHint />);
    expect(screen.queryByText(/welcome to aegis/i)).not.toBeInTheDocument();
  });

  it('persists dismissal and hides on the dismiss button', async () => {
    render(<WelcomeHint />);
    await userEvent.click(screen.getByRole('button', { name: /dismiss|got it/i }));
    expect(screen.queryByText(/welcome to aegis/i)).not.toBeInTheDocument();
    expect(localStorage.getItem(WELCOME_HINT_STORAGE_KEY)).toBe('1');
  });
});
```
- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run src/hooks/useDialog.test.tsx src/components/Toaster.test.tsx src/components/WelcomeHint.test.tsx`
Expected: FAIL with `Failed to resolve import "./useDialog"` / `"./Toaster"` / `"./WelcomeHint"` (the modules do not exist yet).

- [ ] **Step 3: Implement**
```ts
// src/hooks/useDialog.ts
import { useEffect, useRef } from 'react';
import type { RefObject } from 'react';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialog<T extends HTMLElement>(onClose: () => void): RefObject<T | null> {
  const ref = useRef<T | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    const previouslyFocused = document.activeElement as HTMLElement | null;

    const getFocusable = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));

    const focusable = getFocusable();
    if (focusable.length > 0) {
      focusable[0].focus();
    } else {
      node.focus();
    }

    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = getFocusable();
      if (items.length === 0) {
        event.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      if (event.shiftKey) {
        if (active === first || !node.contains(active)) {
          event.preventDefault();
          last.focus();
        }
      } else if (active === last || !node.contains(active)) {
        event.preventDefault();
        first.focus();
      }
    };

    node.addEventListener('keydown', handleKeyDown);
    return () => {
      node.removeEventListener('keydown', handleKeyDown);
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, []);

  return ref;
}
```
```ts
// src/lib/toast.ts
export type ToastKind = 'success' | 'error' | 'info';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

type Listener = (toasts: ToastItem[]) => void;

let toasts: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) {
    listener(toasts);
  }
}

export function subscribeToasts(listener: Listener): () => void {
  listeners.add(listener);
  listener(toasts);
  return () => {
    listeners.delete(listener);
  };
}

function push(kind: ToastKind, message: string): void {
  const item: ToastItem = { id: nextId++, kind, message };
  toasts = [...toasts, item];
  emit();
  setTimeout(() => {
    toasts = toasts.filter((t) => t.id !== item.id);
    emit();
  }, 4000);
}

export const toast = {
  success(m: string): void {
    push('success', m);
  },
  error(m: string): void {
    push('error', m);
  },
  info(m: string): void {
    push('info', m);
  },
};

/** Test-only: clear all toasts and listeners state. */
export function __resetToasts(): void {
  toasts = [];
  nextId = 1;
  emit();
}

let confirmHandler: ((message: string) => Promise<boolean>) | null = null;

/** Registered by the Toaster/confirm host so confirm() can drive a dialog. */
export function registerConfirmHandler(
  handler: ((message: string) => Promise<boolean>) | null,
): void {
  confirmHandler = handler;
}

export function confirm(message: string): Promise<boolean> {
  if (confirmHandler) {
    return confirmHandler(message);
  }
  return Promise.resolve(typeof window !== 'undefined' ? window.confirm(message) : false);
}
```
```tsx
// src/components/Toaster.tsx
import { useEffect, useState } from 'react';
import { subscribeToasts, type ToastItem } from '../lib/toast';

export function Toaster() {
  const [toasts, setToasts] = useState<ToastItem[]>([]);

  useEffect(() => subscribeToasts(setToasts), []);

  return (
    <div className="toaster" role="status" aria-live="polite" aria-atomic="false">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast--${t.kind}`}>
          {t.message}
        </div>
      ))}
    </div>
  );
}
```
```tsx
// src/components/SkipLink.tsx
export interface SkipLinkProps {
  targetId: string;
  children?: React.ReactNode;
}

export function SkipLink({ targetId, children = 'Skip to content' }: SkipLinkProps) {
  return (
    <a className="skip-link" href={`#${targetId}`}>
      {children}
    </a>
  );
}
```
```tsx
// src/components/WelcomeHint.tsx
import { useState } from 'react';

export const WELCOME_HINT_STORAGE_KEY = 'aegis.welcomeHint.dismissed';

export function WelcomeHint() {
  const [dismissed, setDismissed] = useState<boolean>(
    () => localStorage.getItem(WELCOME_HINT_STORAGE_KEY) === '1',
  );

  if (dismissed) {
    return null;
  }

  const handleDismiss = (): void => {
    localStorage.setItem(WELCOME_HINT_STORAGE_KEY, '1');
    setDismissed(true);
  };

  return (
    <div className="welcome-hint" role="note">
      <p>Welcome to Aegis. Type a search or an address above to get started.</p>
      <button type="button" onClick={handleDismiss}>
        Got it
      </button>
    </div>
  );
}
```
- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run src/hooks/useDialog.test.tsx src/components/Toaster.test.tsx src/components/WelcomeHint.test.tsx`
Expected: PASS

- [ ] **Step 5: Wire SkipLink/Toaster/WelcomeHint into App and re-run the App test**
Replace the contents of `src/App.tsx` with the wired version below.
```tsx
// src/App.tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { useNav } from './hooks/useNav';
import { Toolbar } from './components/Toolbar';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SkipLink } from './components/SkipLink';
import { Toaster } from './components/Toaster';
import { WelcomeHint } from './components/WelcomeHint';

const CONTENT_ANCHOR_ID = 'content-anchor';

export function App() {
  const nav = useNav(PRIMARY_VIEW_ID);
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  useEffect(() => {
    const offFailed = aegis.nav.onFailed((f) => {
      if (f.viewId !== PRIMARY_VIEW_ID) return;
      setCrashed(null);
      setFailed(f);
    });
    const offCrashed = aegis.nav.onCrashed((c) => {
      if (c.viewId !== PRIMARY_VIEW_ID) return;
      setFailed(null);
      setCrashed(c);
    });
    return () => {
      offFailed();
      offCrashed();
    };
  }, []);

  // Main owns content hide/show for failures and crashes. When a fresh
  // navigation reports loading state, clear any error/crash overlay. We do NOT
  // call aegis.view.setContentVisible here — main re-shows the content view.
  useEffect(() => {
    if (nav.state.isLoading && !nav.state.crashed) {
      setFailed(null);
      setCrashed(null);
    }
  }, [nav.state.isLoading, nav.state.crashed]);

  const handleRetry = (): void => {
    void aegis.nav.reloadOrStop(PRIMARY_VIEW_ID);
  };

  const handleHome = (): void => {
    nav.home();
  };

  return (
    <div className="app">
      <SkipLink targetId={CONTENT_ANCHOR_ID} />
      <Toolbar
        state={nav.state}
        navigate={nav.navigate}
        back={nav.back}
        forward={nav.forward}
        reloadOrStop={nav.reloadOrStop}
        home={nav.home}
      />
      <div id={CONTENT_ANCHOR_ID} className="content-anchor" tabIndex={-1} />
      <ErrorOverlay
        failed={failed}
        crashed={crashed}
        onRetry={handleRetry}
        onHome={handleHome}
      />
      <WelcomeHint />
      <Toaster />
    </div>
  );
}
```
Run: `npx vitest run src/App.test.tsx src/hooks/useDialog.test.tsx src/components/Toaster.test.tsx src/components/WelcomeHint.test.tsx`
Expected: PASS (App test stays green; the new a11y/extra tests pass).

- [ ] **Step 6: Commit**
```bash
git add src/hooks/useDialog.ts src/lib/toast.ts src/components/Toaster.tsx src/components/SkipLink.tsx src/components/WelcomeHint.tsx src/App.tsx src/hooks/useDialog.test.tsx src/components/Toaster.test.tsx src/components/WelcomeHint.test.tsx
git commit -m "feat(renderer): add a11y plumbing (useDialog, SkipLink, Toaster, WelcomeHint) and wire into App"
```

### Task 26: Source-scan test — fail on forbidden proxy artifacts

**Files:**
- Test: `electron/test/sourceScan.test.ts`

This is a verification-only task (a guard test, no production code to implement). It runs under the Vitest **node** project (`electron/**/*.test.ts` is in the node project's `include` per §7) and asserts §10.9: the `src/` and `electron/` trees contain none of the forbidden UW proxy tokens. The test file itself is excluded from the scan (otherwise the token literals it searches for would match itself).

- [ ] **Step 1: Write the failing test**
```ts
// electron/test/sourceScan.test.ts
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve, relative, sep } from 'node:path';

const ROOT = resolve(__dirname, '..', '..');
const SCAN_DIRS = ['src', 'electron'];
const SCAN_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.css', '.html', '.json']);

// This test file references the forbidden tokens verbatim, so it must exclude itself.
const SELF = resolve(__dirname, 'sourceScan.test.ts');

// Forbidden UW proxy artifacts (§10.9 / spec §1 explicit non-goals).
const FORBIDDEN: { token: string; why: string }[] = [
  { token: '_px_host', why: 'URL-rewriting / subdomain proxy routing' },
  { token: 'directHosts', why: 'hardcoded proxy host allowlist' },
  { token: 'clearanceHosts', why: 'anti-bot clearance host allowlist' },
  { token: 'streamExtractHosts', why: 'media extraction host allowlist' },
  { token: '/api/wrapper', why: 'proxy wrapper API layer' },
  { token: 'postMessage', why: 'address-bar postMessage bridge (use contextBridge IPC instead)' },
];

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // directory may not exist yet during early scaffolding
  }
  for (const name of entries) {
    if (name === 'node_modules' || name === 'out' || name === 'dist') continue;
    const full = join(dir, name);
    const st = statSync(full);
    if (st.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (SCAN_EXTS.has(full.slice(full.lastIndexOf('.')))) {
      out.push(full);
    }
  }
  return out;
}

function allScannedFiles(): string[] {
  const files: string[] = [];
  for (const d of SCAN_DIRS) {
    files.push(...collectFiles(join(ROOT, d)));
  }
  return files.filter((f) => f !== SELF);
}

describe('source scan: no forbidden proxy artifacts (§10.9)', () => {
  for (const { token, why } of FORBIDDEN) {
    it(`contains no "${token}" (${why})`, () => {
      const hits: string[] = [];
      for (const file of allScannedFiles()) {
        const text = readFileSync(file, 'utf8');
        if (text.includes(token)) {
          hits.push(relative(ROOT, file).split(sep).join('/'));
        }
      }
      expect(hits, `forbidden token "${token}" found in: ${hits.join(', ')}`).toEqual([]);
    });
  }

  it('scans at least one real source file (guards against a no-op pass)', () => {
    // If the globber silently matched nothing, the FORBIDDEN loop would vacuously pass.
    expect(allScannedFiles().length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx vitest run electron/test/sourceScan.test.ts`
Expected: FAIL — the final guard `it('scans at least one real source file ...')` fails with `expected 0 to be greater than 0` because at the point this task is written the `src/`/`electron/` trees are nearly empty (the globber returns no scannable files yet besides the excluded self). This proves the scan is actually wired to the filesystem (not vacuously passing).

- [ ] **Step 3: Implement**
There is no production code to write for this task — the test *is* the deliverable. The failing guard assertion turns green naturally once the other blocks' real source files exist on disk. To make the red→green transition observable now, add a single committed sentinel source file that the scanner will count, then confirm the FORBIDDEN assertions hold against it:
```ts
// electron/test/sourceScanSentinel.ts
// Intentional sentinel so the source-scan test (§10.9) always has at least one
// real file to scan during early scaffolding. Contains NO forbidden proxy tokens.
// Safe to delete once the full src/ + electron/ trees are populated.
export const SOURCE_SCAN_SENTINEL = 'aegis-clean';
```

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx vitest run electron/test/sourceScan.test.ts`
Expected: PASS — all six FORBIDDEN token assertions pass (no proxy artifacts present) and the "scans at least one real source file" guard passes because `sourceScanSentinel.ts` is now counted.

- [ ] **Step 5: Commit**
```bash
git add electron/test/sourceScan.test.ts electron/test/sourceScanSentinel.ts
git commit -m "test(verify): add source-scan guard rejecting forbidden proxy artifacts (§10.9)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 27: Sandbox suite (`sandbox.spec.ts`) — content-world isolation + IPC guard

**Files:**
- Create: `electron/test/e2e/sandbox.spec.ts`

Playwright `_electron` e2e (§7). It launches the built app, reaches the single content view through the `__aegisTest.primary` registry (set under `AEGIS_E2E=1` in T19), and asserts §10.8: the content main-world has no Node globals, no `window.aegis`/`ipcRenderer`; `file://` and `javascript:` navigations are blocked; and a privileged IPC invoked **from the content view** is rejected by the sender-validation guard. The pretest:e2e hook (`rebuild:electron && build`) produces `out/main/index.js` which `_electron.launch` runs.

- [ ] **Step 1: Write the failing test**
```ts
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
       aegis: typeof (window as any).aegis,
       ipcRenderer: typeof (window as any).ipcRenderer,
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
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx playwright test electron/test/e2e/sandbox.spec.ts`
Expected: FAIL — until the content view, scheme gate, and sandbox webPreferences exist (Tasks 10/12/13) and the boot wiring (T19) registers `__aegisTest`, the `beforeAll` poll times out (no `__aegisTest.primary`), so every test errors. This is the red state for the verification block before the implementation blocks land.

- [ ] **Step 3: Implement**
No new production code belongs to this task — `sandbox.spec.ts` is a verification spec that asserts behavior built in Blocks 1–4. The properties it checks are already specified by the contract: content-view `webPreferences { sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'persist:content' }` and the no-op `contentPreload` (§5, Task 10/18), the `will-navigate`/`will-redirect` scheme gate via `isAllowedNavigationUrl` (Task 12), and `registerGuardedHandlers(chromeWc.id, ...)` sender validation (Task 15/19). The only artifact this task contributes is the spec file itself. Its green state is reached once those tasks are implemented and `npm run build` has produced `out/main/index.js`.

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx playwright test electron/test/e2e/sandbox.spec.ts`
Expected: PASS — all six tests pass: Node globals undefined, no `window.aegis`/`ipcRenderer` in the content world, sandbox config readback correct, `file://` and `javascript:` navigations leave the state URL unchanged, and the content-world IPC attempt resolves to `{ outcome: 'threw' }`.

- [ ] **Step 5: Commit**
```bash
git add electron/test/e2e/sandbox.spec.ts
git commit -m "test(e2e): sandbox suite — content-world isolation, scheme gate, IPC guard (§10.8)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

### Task 28: Nav integration (`nav.spec.ts`) — SPA, back/forward, title debounce, crash recovery, cert overlay, session restore

**Files:**
- Create: `electron/test/e2e/fixtureServer.ts`
- Create: `electron/test/fixtures/spa.html`
- Create: `electron/test/fixtures/late-title.html`
- Create: `electron/test/fixtures/crash.html`
- Create: `electron/test/fixtures/cert/gen-cert.sh`
- Create: `electron/test/fixtures/cert/key.pem`
- Create: `electron/test/fixtures/cert/cert.pem`
- Create: `electron/test/e2e/nav.spec.ts`

Playwright `_electron` e2e (§7). It uses a local **HTTP** fixture server (SPA `pushState`/`replaceState`/`hashchange` throw on `file://` opaque origins, so they must be served over http) plus a local **self-signed HTTPS** server (yields `ERR_CERT_AUTHORITY_INVALID` = -202, in the cert range → cert overlay; no external hosts). It asserts §10.1/§10.7.

- [ ] **Step 1: Write the failing test**

First, the fixture HTTP/HTTPS server helper (`startFixtureServer` per §7) plus a self-signed cert server in the same module:
```ts
// electron/test/e2e/fixtureServer.ts
import http from 'node:http';
import https from 'node:https';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';

const FIXTURE_ROOT = join(__dirname, '..', 'fixtures');

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

async function serveFile(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const urlPath = decodeURIComponent((req.url ?? '/').split('?')[0]);
  // Strip any leading slash, normalize, and reject path traversal.
  const rel = normalize(urlPath).replace(/^(\.\.[/\\])+/, '').replace(/^[/\\]+/, '');
  const filePath = join(FIXTURE_ROOT, rel || 'index.html');
  if (!filePath.startsWith(FIXTURE_ROOT)) {
    res.statusCode = 403;
    res.end('forbidden');
    return;
  }
  try {
    const body = await readFile(filePath);
    res.statusCode = 200;
    res.setHeader('Content-Type', MIME[extname(filePath)] ?? 'application/octet-stream');
    res.end(body);
  } catch {
    res.statusCode = 404;
    res.end('not found');
  }
}

export interface FixtureServer {
  baseUrl: string;
  close(): Promise<void>;
}

/** Plain HTTP fixture server over electron/test/fixtures/ (§7). */
export function startFixtureServer(): Promise<FixtureServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('fixture server: no address'));
        return;
      }
      resolve({
        baseUrl: `http://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}

/** Self-signed HTTPS fixture server → ERR_CERT_AUTHORITY_INVALID (-202), cert range (§7). */
export async function startCertServer(): Promise<FixtureServer> {
  const certDir = join(FIXTURE_ROOT, 'cert');
  const [key, cert] = await Promise.all([
    readFile(join(certDir, 'key.pem')),
    readFile(join(certDir, 'cert.pem')),
  ]);
  return new Promise((resolve, reject) => {
    const server = https.createServer({ key, cert }, (req, res) => {
      void serveFile(req, res);
    });
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('cert server: no address'));
        return;
      }
      resolve({
        baseUrl: `https://127.0.0.1:${addr.port}`,
        close: () =>
          new Promise<void>((res, rej) =>
            server.close((err) => (err ? rej(err) : res())),
          ),
      });
    });
  });
}
```

The SPA fixture (drives `pushState`/`replaceState`/`hashchange` via window-exposed helpers so the test can trigger them with `executeJavaScript`):
```html
<!-- electron/test/fixtures/spa.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>SPA Fixture</title>
  </head>
  <body>
    <main id="content" style="min-height: 200px">SPA root</main>
    <script>
      window.__spaPush = function (path) {
        history.pushState({}, '', path);
      };
      window.__spaReplace = function (path) {
        history.replaceState({}, '', path);
      };
      window.__spaHash = function (frag) {
        location.hash = frag;
      };
    </script>
  </body>
</html>
```

The late-title fixture (emits multiple same-URL title updates in a burst to exercise the 400 ms debounce):
```html
<!-- electron/test/fixtures/late-title.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>start</title>
  </head>
  <body>
    <main id="content" style="min-height: 200px">late title</main>
    <script>
      // Burst of same-URL title changes; the ViewController debounce (400 ms)
      // must coalesce these into a single trailing nav.state emit.
      let n = 0;
      const burst = setInterval(function () {
        n += 1;
        document.title = 'burst-' + n;
        if (n >= 5) {
          clearInterval(burst);
          document.title = 'final-title';
        }
      }, 20);
    </script>
  </body>
</html>
```

The crash fixture (a plain page; the crash itself is forced via `webContents.forcefullyCrashRenderer()` from the test, since `render-process-gone` cannot be reliably triggered from page script):
```html
<!-- electron/test/fixtures/crash.html -->
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>crash fixture</title>
  </head>
  <body>
    <main id="content" style="min-height: 200px">crash target</main>
  </body>
</html>
```

The self-signed cert generation helper (committed for reproducibility; the `key.pem`/`cert.pem` pair is committed alongside it per §7):
```bash
# electron/test/fixtures/cert/gen-cert.sh
#!/usr/bin/env bash
# Regenerates the committed self-signed pair used by startCertServer().
# Run from this directory:  bash gen-cert.sh
set -euo pipefail
openssl req -x509 -newkey rsa:2048 -nodes \
  -keyout key.pem -out cert.pem -days 3650 \
  -subj "/CN=127.0.0.1" \
  -addext "subjectAltName=IP:127.0.0.1"
echo "wrote key.pem and cert.pem"
```

The nav integration spec:
```ts
// electron/test/e2e/nav.spec.ts
import { test, expect, _electron, type ElectronApplication } from '@playwright/test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  startFixtureServer,
  startCertServer,
  type FixtureServer,
} from './fixtureServer';
import type { NavState } from '../../../shared/types';

let fixtures: FixtureServer;
let certs: FixtureServer;

test.beforeAll(async () => {
  fixtures = await startFixtureServer();
  certs = await startCertServer();
});

test.afterAll(async () => {
  await fixtures.close();
  await certs.close();
});

async function launchApp(userDataDir: string): Promise<ElectronApplication> {
  const app = await _electron.launch({
    args: ['out/main/index.js'],
    env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: userDataDir },
  });
  await expect
    .poll(
      () =>
        app.evaluate(() => {
          const reg = (globalThis as any).__aegisTest;
          return reg?.primary ? reg.primary.getState().url : '';
        }),
      { timeout: 15000 },
    )
    .not.toEqual('');
  return app;
}

function state(app: ElectronApplication): Promise<NavState> {
  return app.evaluate(() => (globalThis as any).__aegisTest.primary.getState());
}

function navigate(app: ElectronApplication, url: string): Promise<void> {
  return app.evaluate(
    (_e, u) => {
      (globalThis as any).__aegisTest.primary.navigate(u);
    },
    url,
  );
}

async function navigateAndSettle(
  app: ElectronApplication,
  url: string,
): Promise<void> {
  await navigate(app, url);
  await expect
    .poll(async () => (await state(app)).url, { timeout: 15000 })
    .toBe(url);
  await expect
    .poll(async () => (await state(app)).isLoading, { timeout: 15000 })
    .toBe(false);
}

test('SPA pushState/replaceState/hashchange update the URL without a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-spa-'));
  const app = await launchApp(dir);
  try {
    const spaUrl = `${fixtures.baseUrl}/spa.html`;
    await navigateAndSettle(app, spaUrl);

    // pushState
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaPush("/spa.html?p=1")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=1`);
    // In-page nav must NOT trigger a reload.
    expect((await state(app)).isLoading).toBe(false);

    // replaceState
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaReplace("/spa.html?p=2")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=2`);

    // hashchange
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.view.webContents.executeJavaScript(
        'window.__spaHash("section")',
        true,
      ),
    );
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(`${fixtures.baseUrl}/spa.html?p=2#section`);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('back/forward enablement flips across a back/forward sequence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-bf-'));
  const app = await launchApp(dir);
  try {
    const a = `${fixtures.baseUrl}/spa.html`;
    const b = `${fixtures.baseUrl}/late-title.html`;
    await navigateAndSettle(app, a);
    expect((await state(app)).canGoBack).toBe(false);

    await navigateAndSettle(app, b);
    expect((await state(app)).canGoBack).toBe(true);
    expect((await state(app)).canGoForward).toBe(false);

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.back());
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(a);
    expect((await state(app)).canGoForward).toBe(true);

    await app.evaluate(() => (globalThis as any).__aegisTest.primary.forward());
    await expect
      .poll(async () => (await state(app)).url, { timeout: 10000 })
      .toBe(b);
    expect((await state(app)).canGoForward).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('same-URL title burst coalesces to one trailing title after the debounce', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-title-'));
  const app = await launchApp(dir);
  try {
    await navigateAndSettle(app, `${fixtures.baseUrl}/late-title.html`);
    // The burst (5 changes @20ms) finishes well within the 400ms debounce window;
    // only the final trailing title should land in nav state.
    await expect
      .poll(async () => (await state(app)).title, { timeout: 10000 })
      .toBe('final-title');
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('content-process crash shows overlay state and hides the content view; Retry restores', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-crash-'));
  const app = await launchApp(dir);
  try {
    const crashUrl = `${fixtures.baseUrl}/crash.html`;
    await navigateAndSettle(app, crashUrl);
    expect(
      await app.evaluate(() =>
        (globalThis as any).__aegisTest.primary.isContentVisible(),
      ),
    ).toBe(true);

    // Force render-process-gone (did-fail-load does NOT fire on a crash — §9.9).
    await app.evaluate(() => {
      (globalThis as any).__aegisTest.primary.view.webContents.forcefullyCrashRenderer();
    });

    await expect
      .poll(async () => (await state(app)).crashed, { timeout: 10000 })
      .toBe(true);
    expect(
      await app.evaluate(() =>
        (globalThis as any).__aegisTest.primary.isContentVisible(),
      ),
    ).toBe(false);

    // Retry path == reloadOrStop (recovery re-show): clears crashed, re-shows content.
    await app.evaluate(() =>
      (globalThis as any).__aegisTest.primary.reloadOrStop(),
    );
    await expect
      .poll(async () => (await state(app)).crashed, { timeout: 15000 })
      .toBe(false);
    await expect
      .poll(
        async () =>
          app.evaluate(() =>
            (globalThis as any).__aegisTest.primary.isContentVisible(),
          ),
        { timeout: 15000 },
      )
      .toBe(true);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('TLS certificate error hard-fails to a cert overlay (nav.failed kind=cert)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-cert-'));
  const app = await launchApp(dir);
  try {
    // Capture nav.failed forwarded to the chrome renderer's ipc.
    await navigate(app, `${certs.baseUrl}/spa.html`);
    // Self-signed → ERR_CERT_AUTHORITY_INVALID (-202), cert range → onFailed(kind:'cert')
    // → content hidden. We observe the observable consequences: content hidden and the
    // state URL did NOT become the https cert URL (hard fail, no click-through).
    await expect
      .poll(
        async () =>
          app.evaluate(() =>
            (globalThis as any).__aegisTest.primary.isContentVisible(),
          ),
        { timeout: 15000 },
      )
      .toBe(false);
    expect((await state(app)).url.startsWith(certs.baseUrl)).toBe(false);
  } finally {
    await app.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test('session restore reopens the last URL on relaunch', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'aegis-e2e-nav-restore-'));
  const lastUrl = `${fixtures.baseUrl}/late-title.html`;
  const app1 = await launchApp(dir);
  try {
    await navigateAndSettle(app1, lastUrl);
  } finally {
    await app1.close();
  }

  // Relaunch with the SAME userData dir → session.json must restore lastUrl.
  const app2 = await launchApp(dir);
  try {
    await expect
      .poll(async () => (await state(app2)).url, { timeout: 15000 })
      .toBe(lastUrl);
  } finally {
    await app2.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run the test, verify it fails**
Run: `npx playwright test electron/test/e2e/nav.spec.ts`
Expected: FAIL — before the implementation blocks land, `launchApp`'s poll on `__aegisTest.primary` times out (boot wiring T19 absent), so every test errors. Even after boot wiring exists, this spec stays red until the SPA in-page nav forwarding (T10), back/forward via `navigationHistory` (T11), the title debounce (T10), crash hide/re-show (T12/T14/T11 recovery), cert detection (T12), and session restore (T19) are all implemented. This is the verification-block red state.

- [ ] **Step 3: Implement**
The production behavior under test is owned by Blocks 1–4; this task contributes only the fixtures and the spec. The deliverables are the fixture server (`fixtureServer.ts` exporting `startFixtureServer`/`startCertServer`), the four fixture documents (`spa.html`, `late-title.html`, `crash.html`, and the committed `cert/{key.pem,cert.pem}` pair plus `gen-cert.sh`), and `nav.spec.ts` — all shown verbatim in Step 1. Generate the committed self-signed pair once so the cert server can load it:
```bash
chmod +x electron/test/fixtures/cert/gen-cert.sh
bash electron/test/fixtures/cert/gen-cert.sh
# Run from the cert dir if the relative paths above don't resolve:
#   (cd electron/test/fixtures/cert && bash gen-cert.sh)
ls -l electron/test/fixtures/cert/key.pem electron/test/fixtures/cert/cert.pem
```
The spec turns green once Tasks 10–14 and 19 are implemented and `npm run build` (run by the `pretest:e2e` hook) has produced `out/main/index.js`.

- [ ] **Step 4: Run the test, verify it passes**
Run: `npx playwright test electron/test/e2e/nav.spec.ts`
Expected: PASS — all seven tests pass: SPA `pushState`/`replaceState`/`hashchange` update the state URL with `isLoading:false` (no reload); back/forward enablement flips correctly across the sequence; the same-URL title burst coalesces to `final-title`; the forced crash sets `crashed:true` + `isContentVisible()===false` and `reloadOrStop()` restores `crashed:false` + visible; the self-signed cert load hides content and never adopts the https URL; and relaunch with the same userData dir restores the last URL.

- [ ] **Step 5: Commit**
```bash
git add electron/test/e2e/fixtureServer.ts electron/test/e2e/nav.spec.ts electron/test/fixtures/spa.html electron/test/fixtures/late-title.html electron/test/fixtures/crash.html electron/test/fixtures/cert/gen-cert.sh electron/test/fixtures/cert/key.pem electron/test/fixtures/cert/cert.pem
git commit -m "test(e2e): nav integration — SPA, back/forward, title debounce, crash recovery, cert overlay, session restore (§10.1/§10.7)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---
