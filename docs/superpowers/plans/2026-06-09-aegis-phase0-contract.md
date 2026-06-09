# Aegis Phase 0 — Plan Contract (authoritative, v2)

Companion to the Phase-0 implementation plan. **Every task must conform to this contract.** Cross-module
names, signatures, versions, and Electron API forms below are fixed; tasks may introduce new names only
*within their own files* and must list them.

> **v2 incorporates the adversarial plan-review fixes:** a dedicated boot-wiring task (T19); the `__aegisTest`
> registry (no `__aegisWindow`); single content-view ownership (window.ts owns chrome only, ViewController owns
> the one content view, index.ts composes); full renderer test toolchain (testing-library + jsdom + Vitest-4
> `projects` + setup file, NOT the removed `environmentMatchGlobs`); the better-sqlite3 dual-ABI strategy;
> `ViewController.isContentVisible()` instead of the unverified `WebContentsView.getVisible()`; content re-show
> on the `reloadOrStop` recovery path; `.spec.ts` e2e naming + local http/https fixture servers; and the
> guard-test / contentPreload / SPA-fixture corrections.

Phase 0 = foundation + real navigation + shell chrome + persistence base + resilience + the security floor.
**No filter engine** (Phase 1) — so `electron/main/adblock/`, `AdblockButton`, `BlockedBadge`, and the
`adblock.*`/`lists.*` IPC are **not** in Phase 0.

---

## 1. Versions & scripts (package.json)

**dependencies**
- `better-sqlite3` ^12.10.0

**devDependencies**
- `electron` ^42.3.3
- `electron-vite` ^5.0.0
- `@electron/rebuild` ^4.0.4
- `vitest` ^4.1.8
- `@vitejs/plugin-react` ^4.3.4
- `@testing-library/react` ^16.1.0
- `@testing-library/jest-dom` ^6.6.0
- `@testing-library/user-event` ^14.5.0
- `jsdom` ^25.0.0
- `@playwright/test` ^1.49.0  *(install with the explicit pin: `npm i -D @playwright/test@^1.49.0`)*
- `typescript` ^5.7.0, `react` ^19, `react-dom` ^19
- `@types/better-sqlite3` ^7.6.11, `@types/react` ^19, `@types/react-dom` ^19, `@types/node` ^22

**scripts** — note the **dual-ABI hooks** (§2.1):
```json
{
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
}
```
There is **no `postinstall`** (it would fight the ABI hooks). `type` is left as CommonJS for main/preload
(electron-vite emits CJS for those by default); the renderer is ESM. Use electron-vite defaults.

---

## 2. electron-vite config & build

`electron.vite.config.ts` — three builds:
- **main:** entry `electron/main/index.ts`; `build.rollupOptions.external: ['better-sqlite3']`.
- **preload:** inputs `electron/preload/chromePreload.ts`, `electron/preload/contentPreload.ts`.
- **renderer:** `root: resolve(__dirname, 'src')`, `@vitejs/plugin-react`, input `resolve(__dirname, 'src/index.html')`.

Outputs: `out/main`, `out/preload`, `out/renderer`. **`index.html` lives at `src/index.html`** (renderer root),
not the repo root — this is the standard electron-vite layout and avoids the root/input mismatch. Dev renderer
URL is injected by electron-vite as `process.env.ELECTRON_RENDERER_URL`.

`electron-builder.yml` is minimal (`asarUnpack: ["**/node_modules/better-sqlite3/**"]`); full packaging is Phase 5.

### 2.1 better-sqlite3 dual-ABI strategy (resolves the node-vs-Electron conflict)
`better-sqlite3` is a native module with **one binary, two incompatible ABIs**: unit tests run under the **Node**
runtime (Vitest), but the app (dev/build/e2e) runs under **Electron**. The scripts above flip the ABI automatically:
- `pretest` → `rebuild:node` (`npm rebuild better-sqlite3`) builds the **Node** ABI before unit tests.
- `predev` / `prebuild` / `pretest:e2e` → `rebuild:electron` (`electron-rebuild`) builds the **Electron** ABI.

Cost: switching between `npm test` and `npm run dev`/`test:e2e` triggers a recompile (~10–30 s). This is expected;
document it. Unit tests that touch better-sqlite3 (sqlite/settingsRepo/session) therefore run under the **Node** ABI;
the live app uses the **Electron** ABI.

---

## 3. File structure (Phase 0)

```
aegis/
├─ electron.vite.config.ts          three-build config (external better-sqlite3)
├─ electron-builder.yml             minimal (asarUnpack better-sqlite3)
├─ playwright.config.ts             e2e (testDir electron/test/e2e; default *.spec.ts match)
├─ vitest.config.ts                 Vitest 4 `projects`: node (electron+shared) / jsdom (src)
├─ vitest.setup.ts                  imports '@testing-library/jest-dom/vitest' + cleanup()
├─ tsconfig.json / tsconfig.node.json
├─ shared/
│  └─ types.ts                      IPC contract + data-model types (SEE §4 — create verbatim)
├─ electron/
│  ├─ lib/
│  │  ├─ schemes.ts                 isAllowedNavigationUrl (dependency-free; imported by main + renderer)
│  │  └─ atomicFile.ts              writeFileAtomic / readFileSafe
│  ├─ main/
│  │  ├─ index.ts                   app lifecycle + FULL boot wiring (T19): DB, ViewController, IPC, session, __aegisTest
│  │  ├─ constants.ts               CHROME_TOP_HEIGHT, isAppUrl
│  │  ├─ window.ts                  createMainWindow() → BaseWindow + chromeView ONLY; layout(); chrome lockdown; closed cleanup
│  │  ├─ viewController.ts          ViewController (the ONE content WebContentsView + nav + events + security handlers)
│  │  ├─ session.ts                 readLastSession / writeLastSession (session.json via atomicFile)
│  │  ├─ db/
│  │  │  ├─ sqlite.ts               openDb + runMigrations
│  │  │  └─ settingsRepo.ts         DEFAULT_SETTINGS + SettingsRepo
│  │  └─ ipc/
│  │     ├─ guard.ts                registerGuardedHandlers (sender validation)
│  │     ├─ nav.ts                  buildNavHandlers + buildViewEventForwarders
│  │     └─ settings.ts             buildSettingsHandlers
│  ├─ preload/
│  │  ├─ chromePreload.ts           contextBridge → window.aegis (AegisApi)
│  │  └─ contentPreload.ts          no-op in Phase 0 (see §6.4 note); kept as the content-view preload entry
│  └─ test/
│     ├─ e2e/                       Playwright `_electron` specs (*.spec.ts) + fixtureServer.ts
│     └─ fixtures/                  spa.html, late-title.html, crash.html, cert/{key.pem,cert.pem}
└─ src/ (renderer)
   ├─ index.html                    renderer entry (electron-vite root = src)
   ├─ main.tsx                      React root (ErrorBoundary → App)
   ├─ App.tsx                       shell layout; subscribes nav events; chrome-only overlay visibility
   ├─ index.css                     CSS custom properties (--accent-color, etc.)
   ├─ components/
   │  ├─ AddressBar.tsx  NavControls.tsx  Toolbar.tsx  ErrorOverlay.tsx
   │  ├─ ErrorBoundary.tsx  Toaster.tsx  WelcomeHint.tsx  SkipLink.tsx
   ├─ hooks/
   │  ├─ useNav.ts  useDialog.ts
   └─ lib/
      ├─ addressParse.ts  ipcClient.ts  theme.ts  toast.ts
```

---

## 4. `shared/types.ts` — EXACT content (create verbatim in Task 1)

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

---

## 5. Electron API ledger (verified for Electron 42.3.3 — use EXACTLY; do NOT use deprecated forms)

- **Window composition:** `const win = new BaseWindow({ width, height })`. `win.contentView.addChildView(view)`
  (z-order = add order; add **chromeView first**, then the content view, so content sits over the chrome's
  content region). `win.contentView.removeChildView(view)`. `win.getContentBounds()` → `{ x, y, width, height }`.
- **Ownership:** `window.ts` creates the `BaseWindow` + the **chromeView** only. The **single content view** is
  owned by `ViewController` (`vc.view`). `index.ts` (T19) calls `win.contentView.addChildView(vc.view)` and drives
  layout. **window.ts must NOT create a content view.**
- **Views:** `const view = new WebContentsView({ webPreferences })`.
  - chromeView webPreferences: `{ preload: <out/preload/chromePreload.js>, sandbox: true, contextIsolation: true, nodeIntegration: false }`.
  - content view webPreferences: `{ preload: <out/preload/contentPreload.js>, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, partition: 'persist:content' }`.
  - `view.setBounds({ x, y, width, height })`; `view.setVisible(boolean)`. **There is no `view.getVisible()` —
    track visibility in `ViewController` and expose `isContentVisible()`.**
- **Load chrome:** dev → `chromeView.webContents.loadURL(process.env.ELECTRON_RENDERER_URL!)`;
  prod → `chromeView.webContents.loadFile(join(__dirname, '../renderer/index.html'))`.
- **Layout (in window.ts `layout(win, chromeView, contentView?)`):** `const { width, height } = win.getContentBounds()`;
  `chromeView.setBounds({ x:0, y:0, width, height })`; if `contentView` →
  `contentView.setBounds({ x:0, y:CHROME_TOP_HEIGHT, width, height: height - CHROME_TOP_HEIGHT })`. Call on
  `win.on('resize', ...)`.
- **Navigation (content `wc`):** `wc.loadURL(url)`, `wc.reload()`, `wc.stop()`, `wc.isLoading()`, `wc.getURL()`,
  `wc.getTitle()`, and the **navigationHistory** API: `wc.navigationHistory.canGoBack()`,
  `wc.navigationHistory.goBack()`, `wc.navigationHistory.canGoForward()`, `wc.navigationHistory.goForward()`.
  **Do NOT use the deprecated `wc.canGoBack()/goBack()/canGoForward()/goForward()`.**
- **Nav events (`wc.on(...)`):** `'did-start-loading'`; `'did-stop-loading'`; `'did-navigate', (event, url)`;
  `'did-navigate-in-page', (event, url, isMainFrame)`; `'page-title-updated', (event, title)`;
  `'did-fail-load', (event, errorCode, errorDescription, validatedURL, isMainFrame)`;
  `'render-process-gone', (event, details)` (`details.reason: string`); `'unresponsive'`;
  `'will-navigate', (event, url)`; `'will-redirect', (event, url)`.
- **Certificate errors:** do NOT override (default = hard fail). Detect from `did-fail-load`:
  `errorCode <= -200 && errorCode > -300` → `kind: 'cert'`, else `'load'`. Emit `nav.failed` only when
  `isMainFrame === true`.
- **Permissions (content session `ses = vc.view.webContents.session`):**
  `ses.setPermissionRequestHandler((wc, permission, callback) => callback(false))`;
  `ses.setPermissionCheckHandler(() => false)`.
- **Downloads:** `ses.on('will-download', (event) => event.preventDefault())`.
- **Popups (content `wc.setWindowOpenHandler((details) => ...)`):** `details = { url, frameName, features, disposition, referrer, postBody }`.
  Policy: if `disposition` ∈ `{ 'background-tab', 'save-to-disk', 'other' }` → `{ action: 'deny' }` (popunder).
  Else if `isAllowedNavigationUrl(details.url)` → `wc.loadURL(details.url)` (route in-place) then `{ action: 'deny' }`.
  Else `{ action: 'deny' }`. (Gesture precision is a known open item.)
- **Chrome renderer lockdown (`chromeView.webContents`):** `setWindowOpenHandler(() => ({ action: 'deny' }))`;
  `on('will-navigate', (event, url) => { if (!isAppUrl(url)) event.preventDefault() })`.
- **Lifecycle:** `win.on('closed', () => { vc.destroy(); chromeView.webContents.close() })` where
  `vc.destroy()` calls `this.view.webContents.close()` (WebContentsView does NOT auto-destroy on BaseWindow close).
- **IPC:** main `ipcMain.handle(channel, handler)`; events `chromeView.webContents.send(channel, payload)`.
  Preload: `ipcRenderer.invoke(channel, ...args)` and `ipcRenderer.on(channel, (_e, payload) => ...)`.
  **Sender validation:** in every handler, reject unless `event.sender.id === chromeWebContentsId`.

---

## 6. Interface ledger (cross-module signatures — use EXACTLY)

```ts
// electron/lib/schemes.ts
export function isAllowedNavigationUrl(url: string): boolean;
// true for https:, http:, and exactly 'about:blank'; false for file:, javascript:, data:, chrome:, others, invalid.

// electron/lib/atomicFile.ts
export function writeFileAtomic(filePath: string, data: string): void; // temp `${filePath}.tmp-${process.pid}` then rename
export function readFileSafe(filePath: string): string | null;          // null on ENOENT / read error

// electron/main/constants.ts
export const CHROME_TOP_HEIGHT: number; // 56
export function isAppUrl(url: string): boolean; // dev renderer origin OR file: under out/renderer

// electron/main/db/sqlite.ts
import type Database from 'better-sqlite3';
export function openDb(dbPath: string): Database.Database;   // ':memory:' allowed in tests
export function runMigrations(db: Database.Database): void;  // idempotent; creates settings table (Phase 0)

// electron/main/db/settingsRepo.ts
export const DEFAULT_SETTINGS: Settings;
export class SettingsRepo {
  constructor(db: Database.Database);
  get(): Settings;                       // merges stored over DEFAULT_SETTINGS
  set(partial: Partial<Settings>): Settings;
}

// electron/main/session.ts
export function readLastSession(dataDir: string): { url: string; title: string } | null;
export function writeLastSession(dataDir: string, s: { url: string; title: string }): void;

// electron/main/window.ts
import { BaseWindow, WebContentsView } from 'electron';
export function createMainWindow(): { win: BaseWindow; chromeView: WebContentsView }; // chrome lockdown applied here
export function layout(win: BaseWindow, chromeView: WebContentsView, contentView?: WebContentsView): void;

// electron/main/viewController.ts
import { WebContentsView } from 'electron';
export interface ViewControllerOpts {
  contentPreloadPath: string;
  onState: (s: NavState) => void;
  onFailed: (f: NavFailed) => void;
  onCrashed: (c: NavCrashed) => void;
}
/** Optional test-only injection (APPROVED deviation from a bare constructor): timer for the title debounce. */
export interface ViewControllerDeps {
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (h: ReturnType<typeof setTimeout>) => void;
}
export class ViewController {
  readonly id: ViewId;            // PRIMARY_VIEW_ID in Phase 0
  readonly view: WebContentsView; // partition 'persist:content'
  constructor(opts: ViewControllerOpts, deps?: ViewControllerDeps);
  navigate(url: string): void;    // scheme-checked; rejects → onFailed(kind:'load'); sets pendingShowOnStart
  back(): void;
  forward(): void;
  reloadOrStop(): void;           // stop() if isLoading() else reload(); ALSO sets pendingShowOnStart + clears crashed (recovery re-show)
  getState(): NavState;
  isContentVisible(): boolean;    // tracks setVisible() state
  setBounds(rect: { x: number; y: number; width: number; height: number }): void;
  setVisible(v: boolean): void;   // updates the tracked flag
  destroy(): void;                // this.view.webContents.close()
}

// electron/main/ipc/guard.ts
import type { IpcMainInvokeEvent } from 'electron';
export function registerGuardedHandlers(
  chromeWebContentsId: number,
  handlers: Record<string, (...args: any[]) => any>, // args are the invoke args WITHOUT the event
): void; // wraps ipcMain.handle: validates event.sender.id === chromeWebContentsId, then calls handler(...args)

// electron/main/ipc/nav.ts
export function buildNavHandlers(vc: ViewController, settingsRepo: SettingsRepo): Record<string, (...a: any[]) => any>;
// keys: IPC.navNavigate (viewId,url)->vc.navigate; navBack/navForward/navReloadOrStop (viewId)->vc.*;
//       navHome (viewId)->vc.navigate(settingsRepo.get().homeUrl); navGetState (viewId)->vc.getState();
//       viewSetContentVisible (viewId,visible)->vc.setVisible(visible)
export function buildViewEventForwarders(
  chromeWc: Electron.WebContents,
): Pick<ViewControllerOpts, 'onState' | 'onFailed' | 'onCrashed'>;
// onState->send(evtNavState); onFailed->send(evtNavFailed); onCrashed->send(evtNavCrashed)

// electron/main/ipc/settings.ts
export function buildSettingsHandlers(settingsRepo: SettingsRepo): Record<string, (...a: any[]) => any>;
// keys: IPC.settingsGet ()->repo.get(); IPC.settingsSet (partial)->repo.set(partial)

// src/lib/addressParse.ts
export type AddressParseResult =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload' }
  | { kind: 'rejected'; reason: string };
export function addressParse(raw: string, ctx: { currentUrl: string; searchTemplate: string }): AddressParseResult;

// src/lib/ipcClient.ts
export const aegis: AegisApi; // = window.aegis

// src/lib/theme.ts
export function applyTheme(s: Pick<Settings, 'primaryColor'>): void; // sets --accent-color on :root

// src/lib/toast.ts
export const toast: { success(m: string): void; error(m: string): void; info(m: string): void };
export function confirm(message: string): Promise<boolean>;

// src/hooks/useNav.ts
export function useNav(viewId: ViewId): {
  state: NavState;
  navigate(raw: string): void;   // addressParse(raw, {currentUrl: state.url, searchTemplate}) then aegis.nav.navigate / reloadOrStop
  back(): void; forward(): void; reloadOrStop(): void; home(): void;
};

// src/hooks/useDialog.ts
export function useDialog<T extends HTMLElement>(onClose: () => void): React.RefObject<T | null>; // focus trap + Escape + focus restore
```

---

## 7. Conventions

- **addressParse logic:** trim input. If it equals `ctx.currentUrl` → `{kind:'reload'}`. If it parses with a
  scheme → `isAllowedNavigationUrl` ? `{kind:'navigate',url}` : `{kind:'rejected'}`. If no scheme but it looks
  like a host (contains a dot, no spaces) → prepend `https://` and re-check the allowlist. Otherwise → search:
  `{kind:'navigate', url: searchTemplate.replace('%s', encodeURIComponent(trimmed))}` (the trimmed input). Import the shared
  `electron/lib/schemes.ts` from the renderer (dependency-free).
- **Overlay-visibility ownership (no double-drive):**
  - **Main owns** content-view hide/show for **load/cert failures and crashes**: `ViewController` calls
    `setVisible(false)` on `did-fail-load`(main-frame)/`render-process-gone`; it re-shows (`setVisible(true)`)
    when a fresh navigation starts (`did-start-loading` after a `navigate()` **or** `reloadOrStop()` recovery,
    gated by an internal `pendingShowOnStart`).
  - **Renderer owns** visibility only for **chrome-initiated full-area overlays** (confirm dialog, welcome hint),
    via `aegis.view.setContentVisible(viewId, boolean)`. App.tsx must NOT call `setContentVisible` for the
    error/crash overlay (main already handles those).
- **Title debounce:** `page-title-updated` for the **same URL** coalesces to one trailing emit after **400 ms**
  using the injectable timer (`ViewControllerDeps`); a `did-navigate` to a new URL flushes immediately.
- **Session restore:** in `index.ts` (T19): on boot, `readLastSession(userData)` → `vc.navigate(url)` else
  `vc.navigate(settings.homeUrl)`. The `onState` callback persists `writeLastSession(userData,{url,title})` when
  `url` changes (track last-persisted in a closure to avoid redundant writes on loading/title churn).
- **Data dir:** `app.getPath('userData')` (override with `process.env.AEGIS_USER_DATA` when set, for e2e isolation).
  DB: `join(userData,'aegis.db')`; session: `join(userData,'session.json')`.
- **Test-only registry:** in `index.ts` (T19), when `process.env.AEGIS_E2E === '1'`, set
  `(globalThis as any).__aegisTest = { primary: vc }`. Never in production paths. (There is no `__aegisWindow`.)
- **Vitest 4 config (`projects`, NOT `environmentMatchGlobs`):**
  ```ts
  import { defineConfig } from 'vitest/config';
  import react from '@vitejs/plugin-react';
  export default defineConfig({
    plugins: [react()],
    test: {
      globals: true,
      projects: [
        { extends: true, test: { name: 'node', environment: 'node',
            include: ['shared/**/*.test.ts', 'electron/**/*.test.ts'],
            exclude: ['electron/test/e2e/**', 'node_modules/**', 'out/**'] } },
        { extends: true, test: { name: 'dom', environment: 'jsdom', setupFiles: ['./vitest.setup.ts'],
            include: ['src/**/*.test.{ts,tsx}'] } },
      ],
    },
  });
  ```
  `vitest.setup.ts`:
  ```ts
  import '@testing-library/jest-dom/vitest';
  import { afterEach } from 'vitest';
  import { cleanup } from '@testing-library/react';
  afterEach(() => cleanup());
  ```
  Add `"@testing-library/jest-dom"` to `tsconfig.json` `compilerOptions.types`.
- **Unit-test commands:** `npx vitest run <file>` (pretest flips to Node ABI). Mocks of `electron` use
  `vi.hoisted(() => ({ ... }))` for any shared state referenced inside `vi.mock('electron', ...)` (Vitest hoists
  `vi.mock`); never declare a name twice.
- **E2E (Playwright `_electron`):** files are `*.spec.ts` under `electron/test/e2e/`. Launch with
  `const { _electron } = require('@playwright/test'); const app = await _electron.launch({ args: ['out/main/index.js'], env: { ...process.env, AEGIS_E2E: '1', AEGIS_USER_DATA: <tmp dir> } });`
  Reach the content view via `await app.evaluate(() => (globalThis).__aegisTest.primary.view.webContents.executeJavaScript('typeof require'))`,
  and state via `await app.evaluate(() => (globalThis).__aegisTest.primary.getState())` /
  `(globalThis).__aegisTest.primary.isContentVisible()`.
  - **Fixtures over HTTP, not file://:** `electron/test/e2e/fixtureServer.ts` exports
    `startFixtureServer(): Promise<{ baseUrl: string; close(): Promise<void> }>` using `http.createServer` to serve
    `electron/test/fixtures/`. SPA `history.pushState`/`replaceState` throw on `file://` (opaque origin), so the
    SPA/title tests MUST navigate to `${baseUrl}/spa.html`.
  - **Cert test uses a LOCAL self-signed HTTPS server** (commit `electron/test/fixtures/cert/{key.pem,cert.pem}`,
    a self-signed pair) via `https.createServer` — navigating to it yields `ERR_CERT_AUTHORITY_INVALID` (-202),
    in the cert range → cert overlay. **Do NOT depend on external hosts** (e.g. badssl.com).
- **contentPreload note:** under `contextIsolation:true`, a preload runs in an isolated world and **cannot**
  alter the page main-world `window.open`. So in Phase 0 `contentPreload.ts` is effectively a **no-op** (it exists
  as the content-view preload entry for Phase 1's engine wiring). The authoritative popup gate is the main-process
  `setWindowOpenHandler`. Do not claim the preload stubs `window.open`.
- **Commits:** conventional commits, one per task (or per red→green cycle).

---

## 8. Ordered task skeleton (expand each into full TDD steps)

**Block 1 — Scaffold & Window**
- **Task 1:** Project init — `package.json` (§1), `electron.vite.config.ts` (§2), `tsconfig*.json` (incl. jest-dom types), `vitest.config.ts` + `vitest.setup.ts` (§7), `playwright.config.ts`, `src/index.html`, `electron-builder.yml`, `.gitignore`, `shared/types.ts` (§4 verbatim), `electron/main/constants.ts`. Smoke: a Vitest test importing `shared/types` passes (`npx vitest run shared/types.test.ts`).
- **Task 2:** better-sqlite3 dual-ABI wiring (§2.1) — install, ABI scripts, vite `external`, `electron-builder.yml` `asarUnpack`. Smoke: a Node-ABI Vitest test that `new Database(':memory:')` round-trips a value (proves the rebuilt Node binary loads under Vitest). *(openDb is implemented in Task 6.)*
- **Task 3:** `electron/main/window.ts` — `createMainWindow()` (BaseWindow + chromeView ONLY, loads renderer) + `layout()` + `closed` cleanup; minimal `electron/main/index.ts` that calls `createMainWindow()` + `layout()` so the app launches showing the chrome (no content view yet — that arrives in T19). e2e smoke (`window.spec.ts`): app launches; chrome renderer loads (toolbar visible).
- **Task 4:** Chrome renderer lockdown — in `createMainWindow()`, `chromeWc.setWindowOpenHandler(deny)` + `will-navigate` app-only. e2e (`chromeLockdown.spec.ts`): `window.open`/external navigation from the chrome is blocked.

**Block 2 — Persistence**
- **Task 5:** `electron/lib/atomicFile.ts` + unit tests (temp-write+rename; null on missing).
- **Task 6:** `electron/main/db/sqlite.ts` — `openDb` + `runMigrations` (settings table) + unit tests (`:memory:`; idempotent).
- **Task 7:** `electron/main/db/settingsRepo.ts` — `DEFAULT_SETTINGS` + `SettingsRepo.get/set` (merge) + unit tests.
- **Task 8:** `electron/main/session.ts` — `readLastSession`/`writeLastSession` (via atomicFile) + unit tests.

**Block 3 — Content navigation + security handlers**
- **Task 9:** `electron/lib/schemes.ts` — `isAllowedNavigationUrl` + unit tests (https/http/about:blank pass; file/javascript/data/chrome/invalid reject).
- **Task 10:** `electron/main/viewController.ts` — construct the content view (persist:content, sandbox), `navigate` (scheme-checked; sets pendingShowOnStart), nav-state events (`did-navigate`, `did-navigate-in-page`, `did-start/stop-loading`, `page-title-updated` with 400 ms same-URL debounce via injected timer), `getState`, `setBounds`, `setVisible`+`isContentVisible`, `destroy`. Unit-test the debounce with an injected timer (mock the `electron` `WebContentsView` minimally).
- **Task 11:** Back/forward/`reloadOrStop` via `navigationHistory`; `canGoBack/canGoForward` in `getState`; `reloadOrStop` sets pendingShowOnStart + clears `crashed` (recovery re-show).
- **Task 12:** `will-navigate`/`will-redirect` scheme gate + `did-fail-load` → `onFailed` (cert-vs-load kind, main-frame only) + `setVisible(false)` on failure (main-owned hide).
- **Task 13:** Content-session security — both permission handlers (deny), `will-download` (cancel), `setWindowOpenHandler` (gesture policy §5).
- **Task 14:** Crash/hang — `render-process-gone`/`unresponsive` → `onCrashed` + `setVisible(false)`.

**Block 4 — IPC + preload + boot wiring**
- **Task 15:** `electron/main/ipc/guard.ts` — `registerGuardedHandlers` + unit test (rejects foreign sender id) using `vi.hoisted` for the mocked ipcMain registry.
- **Task 16:** `electron/main/ipc/nav.ts` — `buildNavHandlers(vc, settingsRepo)` + `buildViewEventForwarders(chromeWc)` + unit tests (handlers call the right vc methods; home reads settings).
- **Task 17:** `electron/main/ipc/settings.ts` — `buildSettingsHandlers(settingsRepo)` + unit tests.
- **Task 18:** `electron/preload/chromePreload.ts` (contextBridge → `window.aegis`, full `AegisApi` incl. `onState/onFailed/onCrashed` via `ipcRenderer.on` returning unsubscribers) + `electron/preload/contentPreload.ts` (no-op per §7) + `src/lib/ipcClient.ts`.
- **Task 19:** **`electron/main/index.ts` boot wiring** — resolve userData (AEGIS_USER_DATA override); `openDb(join(userData,'aegis.db'))` + `runMigrations` + `new SettingsRepo`; `createMainWindow()`; `const fwd = buildViewEventForwarders(chromeWc)`; build `onState` wrapper that forwards AND `writeLastSession` on url change; `new ViewController({ contentPreloadPath, onState, onFailed: fwd.onFailed, onCrashed: fwd.onCrashed })`; `win.contentView.addChildView(vc.view)` + `layout(win, chromeView, vc.view)` + resize handler; `registerGuardedHandlers(chromeWc.id, { ...buildNavHandlers(vc, repo), ...buildSettingsHandlers(repo) })`; session restore on boot (`readLastSession` else `settings.homeUrl`); set `__aegisTest = { primary: vc }` under `AEGIS_E2E`. e2e (`boot.spec.ts`): app launches with a content view that loads the home URL and reports state via `__aegisTest.primary.getState()`.

**Block 5 — Renderer chrome**
- **Task 20:** `src/lib/addressParse.ts` + unit tests (search/https-prepend/full-URL/reload/reject per §7).
- **Task 21:** `src/lib/theme.ts` + `src/index.css` (custom properties) + apply accent/siteName from settings.
- **Task 22:** `src/components/AddressBar.tsx`, `NavControls.tsx` (incl. loading indicator), `Toolbar.tsx`, `src/hooks/useNav.ts` + component tests (jsdom).
- **Task 23:** `src/components/ErrorOverlay.tsx` (load/cert/crash variants, retry/home) + component tests.
- **Task 24:** `src/components/ErrorBoundary.tsx` + `src/App.tsx` + `src/main.tsx` — subscribe `onState/onFailed/onCrashed`; render ErrorOverlay on failed/crashed (handleRetry → `aegis.nav.reloadOrStop`); chrome-only `setContentVisible` for confirm/welcome ONLY; boundary catches throws. Component tests (boundary catch; overlay-on-failed).
- **Task 25:** a11y + extras — `src/hooks/useDialog.ts`, `src/components/SkipLink.tsx`, `src/components/Toaster.tsx` (`aria-live`) + `src/lib/toast.ts` + `confirm`, `src/components/WelcomeHint.tsx` (persisted dismissal) + tests (focus trap, Escape, aria-live). Wire SkipLink/Toaster/WelcomeHint into App (re-run App test green).

**Block 6 — Verification (Playwright `_electron`)**
- **Task 26:** Source-scan test (Vitest, Node project) — fail if `src/`+`electron/` contain forbidden proxy tokens (`_px_host`, `directHosts`, `clearanceHosts`, `streamExtractHosts`, `/api/wrapper`, an address-bar `postMessage` bridge).
- **Task 27:** Sandbox suite (`sandbox.spec.ts`) — via `app.evaluate` on `__aegisTest.primary.view.webContents`: content `require/process/module/global` undefined; `window.aegis`/`ipcRenderer` undefined in the content world; `file://` and `javascript:` navigations blocked (state url unchanged / `nav.failed`); a privileged IPC invoked from the content view is rejected by the guard.
- **Task 28:** Nav integration (`nav.spec.ts`) using `fixtureServer` (http) + cert server (https self-signed): SPA `pushState`/`replaceState`/`hashchange` update the address bar (no reload); back/forward enablement flips; same-URL title debounce coalesces; crash recovery shows overlay and `isContentVisible()===false`, then Retry restores; cert failure shows cert overlay; session restore reopens last URL on relaunch.

---

## 9. Spec traceability (Phase-0 slice of spec §10)
§10.1 nav → T10,T11,T28 · §10.2 address bar → T20 · §10.7 resilience (overlay/crash/boundary/restore) → T12,T14,T19,T23,T24,T28 · §10.8 sandbox/config/probes → T10,T13,T15,T27 · §10.9 no proxy artifacts → T26 · theming → T21 · a11y → T25 · persistence → T5–T8,T19 · boot/runnable app → T19. (§10.3–10.6 ad-block are Phase 1+.)
