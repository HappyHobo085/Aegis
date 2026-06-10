# Aegis Phase 5 — Plan Contract (source-verified)

**AUTHORITATIVE** integration facts (Electron 42.4.0, verified from `node_modules/electron/electron.d.ts` +
the codebase), mechanisms, shared/types additions, interface ledger, conventions, and task skeleton. Drafters:
use ONLY the names/signatures here for anything cross-module. Spec:
`docs/superpowers/specs/2026-06-11-aegis-phase5-design.md`.

---

## §1 As-built + Electron-42 facts (VERIFIED — do not re-guess)

### 1.1 Content view / session (the wiring anchor)
- `ViewController` (`electron/main/viewController.ts`): content `new WebContentsView({ webPreferences: { preload,
  sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true, partition:'persist:content' } })`
  (`:49-58`). Accessors: `vc.contentWebContents` (`:69`), `vc.contentSession` (`:74`), `vc.view`, `vc.id`.
- `wireSecurity()` (`:158-179`, called from ctor `:61`) currently:
  `ses.setPermissionRequestHandler((_wc,_p,cb)=>cb(false))` + `ses.setPermissionCheckHandler(()=>false)` (`:163-164`);
  `ses.on('will-download', (event)=>event.preventDefault())` (`:167-169`); `wc.setWindowOpenHandler` deny (`:174-178`).
- The top-level window is a `BaseWindow` created in `electron/main/window.ts:11` (`createMainWindow()` returns
  `{ win, chromeView }`); `index.ts` holds `win`. `win.setFullScreen(flag)` / `win.isFullScreen()` exist (BaseWindow).
- Boot wiring lives in `electron/main/index.ts` (the `registerGuardedHandlers(chromeWc.id, {...})` call `:239-250`;
  `__aegisTest` registry `:252-277`).

### 1.2 Downloads (Electron 42)
- **`will-download` is a SESSION event** (NOT WebContents): `session.on('will-download', (event: Event, item:
  DownloadItem, webContents: WebContents) => void)`. The current handler at `viewController.ts:167-169` only takes
  `(event)` and must be REMOVED; the real handler attaches to `vc.contentSession` in boot (deps available there).
- `DownloadItem`: `setSavePath(path)` — **only valid SYNCHRONOUSLY inside the will-download callback** (sets the
  save path, recursive-mkdir); `getFilename()`, `getURL()`, `getTotalBytes()` (0 if unknown), `getReceivedBytes()`,
  `getState()` (`progressing|completed|cancelled|interrupted`), `getStartTime()`, `cancel()`, `pause()`, `resume()`,
  `isPaused()`; events `item.on('updated', (e, state:'progressing'|'interrupted')=>…)` and
  `item.on('done', (e, state:'completed'|'cancelled'|'interrupted')=>…)`.
- `app.getPath('downloads')` → OS Downloads dir. `dialog.showSaveDialog(win, SaveDialogOptions)` /
  `dialog.showOpenDialog(win, OpenDialogOptions)` → `Promise<{canceled, filePath}>` / `Promise<{canceled,
  filePaths}>`. `shell.openPath(path): Promise<string>` (resolves `''` on success). `shell.showItemInFolder(path):
  void`. (Dialogs need a `BaseWindow` ref → the Data export/import handlers take `win`.)

### 1.3 Permissions (Electron 42)
- `session.setPermissionRequestHandler((wc, permission, callback:(granted:boolean)=>void, details)=>void)` —
  `details` base = `PermissionRequest { isMainFrame, requestingUrl: string }` (use `requestingUrl`; **there is no
  `requestingOrigin` on the request details**); `MediaAccessPermissionRequest` adds `mediaTypes?: ('video'|'audio')[]`.
  Permission union (request) includes `geolocation|notifications|media|clipboard-read|…` (NOT hid/serial/usb).
- `session.setPermissionCheckHandler((wc|null, permission, requestingOrigin: string, details)=>boolean)` —
  `requestingOrigin` IS a positional param here. Return `boolean`.
- Phase-5 set (the meaningful ones): `geolocation`, `notifications`, `media`, `clipboard-read`. All others stay denied.

### 1.4 Media / PDF / fullscreen (Electron 42)
- **Autoplay:** `webPreferences.autoplayPolicy: 'document-user-activation-required'` (typed per-view field; default
  `no-user-gesture-required` = autoplay-with-sound allowed). Set in the content `webPreferences` (viewController). No
  command-line switch needed.
- **PDF:** `webPreferences.plugins: true` (default `false`; content view does NOT set it today) → Chromium renders
  `application/pdf` inline. Add to the content `webPreferences`.
- **Fullscreen:** content WC events `'enter-html-full-screen'` / `'leave-html-full-screen'` (no args). Wire in boot:
  `vc.contentWebContents.on('enter-html-full-screen', ()=>win.setFullScreen(true))` + leave → `false` (needs `win`,
  available in index.ts; ViewController does NOT hold it).

### 1.5 CSP (chrome renderer) — ALREADY PRESENT; harden + build-mode-aware
- `src/index.html:6-9` already has `<meta http-equiv="Content-Security-Policy" content="default-src 'self';
  style-src 'self' 'unsafe-inline'; script-src 'self'">`. It is copied verbatim to `out/renderer/index.html`. It is
  hardcoded for BOTH modes → in dev (vite serves `src/index.html`) it breaks HMR (inline scripts, the `ws:` socket
  via missing `connect-src`→`default-src 'self'`, eval).
- Chrome loaded: dev `chromeWc.loadURL(process.env.ELECTRON_RENDERER_URL)`; prod `chromeWc.loadFile('../renderer/
  index.html')` (`window.ts:33-37`). prod `loadFile` has no HTTP layer → CSP must stay a document `<meta>` (NOT
  `onHeadersReceived`, which is intentionally absent). electron-vite renderer `root: src/` (`electron.vite.config.ts
  :58-66`); no `transformIndexHtml`/CSP plugin today.
- Chrome `webPreferences` (`window.ts:13-20`): `preload, sandbox:true, contextIsolation:true, nodeIntegration:false`
  (webSecurity default true).

### 1.6 Security controls for the audit doc (verified present + tested)
Scheme allowlist `electron/lib/schemes.ts` (`ALLOWED_NAV_SCHEMES=['https:','http:']`, `isAllowedNavigationUrl`;
tests `schemes.test.ts`); sender-guarded IPC `ipc/guard.ts` (`event.sender.id===chromeWebContentsId`; tests
`guard.test.ts` + e2e `sandbox.spec.ts:124`); deny-all popups (`window.ts:28` chrome; `viewController.ts:174-178`
content via `decideWindowOpen` `windowOpen.ts`; tests `windowOpen.test.ts` + e2e `chromeLockdown`/`popup`);
nav gating `will-navigate`/`will-redirect` (`window.ts:29-31` chrome `isAppUrl`; `viewController.ts:111-115` content
`isAllowedNavigationUrl`; tests `viewController.test.ts` + e2e `sandbox.spec.ts`); `webviewTag` never enabled (no
`<webview>`); `onHeadersReceived`/`webRequest` ABSENT. Locked webPreferences both views (e2e `sandbox.spec.ts:76`).

### 1.7 Renderer extension points
- **Sidebar** (`src/components/Sidebar.tsx`): `type Tab='history'|'saved'`; props `{open,onToggle,history,saved}`;
  per-tab `useId()` pairs; **panels are a BINARY TERNARY** (`tab==='history' ? … : …`) — adding a 3rd `downloads`
  tab REQUIRES converting the ternary to a map/switch (the `else` would wrongly catch downloads).
- **SettingsModal** (`src/components/SettingsModal.tsx`): DATA-DRIVEN — `SettingsTab` union + `TAB_LABELS` +
  `TAB_ORDER` + `SettingsModalProps` (one `ReactNode` per tab) + `tabIds` + `panels` Records. Add tabs by extending
  those maps (no JSX change). Current 6 tabs; add `downloads`, `sitePermissions`, `data`.
- **App** (`src/App.tsx`): hooks `useFavorites/useHistory/useSaved/useSettings/useSubscriptions/useCustomFilters`
  (`:51-56`); `settingsOpen`/`sidebarOpen` state (`:60-61`); Sidebar always mounted (`:155-176`); `{settingsOpen &&
  <SettingsModal …6 tabs…/>}` (`:196-220`); gear opens settings (`:141`).
- **IPC recipe:** `buildXHandlers(repo): Record<string,(...a:any[])=>any>` (args without event) → spread into
  `registerGuardedHandlers(chromeWc.id,{...})`; preload thin `ipcRenderer.invoke` wrappers + `subscribe<T>(channel,
  cb)` helper (`chromePreload.ts:11-15`) + a main-side `chromeWc.send(IPC.evt…,payload)` forwarder; `AegisApi`
  typed in `shared/types.ts`.
- **executeJavaScript:** `wc.executeJavaScript(code: string, userGesture?: boolean): Promise<any>` — picker uses
  `vc.contentWebContents.executeJavaScript(pickerCode, true)`.
- **CustomFiltersRepo** (`customFiltersRepo.ts`): `get():string` / `set(text):void` (OVERWRITES) — picker append =
  read-modify-write `set(get()+'\n'+rule)`; then `rebuildEngineFromCache()` (Phase-4, in index.ts) applies on next nav.

### 1.8 Repos for export/import (clear() audit)
- `FavoritesRepo`: `list():Favorite[]`, `add({name,url,tags}):Favorite[]`, `remove(id)`. **`clear()` MISSING — ADD.**
- `SavedRepo`: `list():SavedItem[]`, `add({url,title}, now?):SavedItem[]`, `remove(id)`. **`clear()` MISSING — ADD.**
- `HistoryRepo`: `list({limit?,offset?})` (default limit 200; trimmed to 500 — pass `limit>=500` to export all),
  `record({url,title}, now=Date.now):void` (dedups vs most-recent + trims 500; pass `now:()=>entry.visitedAt` to
  preserve timestamps on import), `clear():void` **EXISTS**.
- `SettingsRepo`: `get():Settings`, `set(partial):Settings` (upsert). Replace = `set(importedSettings)` (overwrites
  all known keys; no separate clear needed).
- e2e registry: `subsRepo.all()` (NOT list). `__aegisTest.places={favoritesRepo,historyRepo,savedRepo,
  setContentInset}`; `__aegisTest.phase4={settingsRepo,subsRepo,customFiltersRepo,rebuildFromCache,updateNow,navHome}`.

### 1.9 ABI / git
DB unit tests → `npm run rebuild:node && npx vitest run <f>`; pure renderer/logic → `npx vitest run <f>`; e2e →
`npm run rebuild:electron && npm run build && npx playwright test <f>` (ABI already Electron after the first e2e
task). Full gate: `npm test` then `npm run build && npm run test:e2e`. Branch `phase-5`, LOCAL commits only
(never push/remote/branch-rename).

---

## §2 Phase-5 mechanisms

### 2.1 Downloads
New `electron/main/downloads.ts`: `wireDownloads(session, { downloadsRepo, settingsRepo, onChanged, liveItems })`
attaches `session.on('will-download', (event, item, webContents) => {…})`: resolve dir =
`settingsRepo.get().downloadDir || app.getPath('downloads')`; `savePath = uniquify(join(dir, item.getFilename()))`;
`item.setSavePath(savePath)` (SYNCHRONOUS, in-callback); `const row = downloadsRepo.record({url,filename,savePath,
state:'progressing',receivedBytes:0,totalBytes:item.getTotalBytes(),startedAt:now})`; `liveItems.set(row.id, item)`;
`item.on('updated', (_e,state)=> downloadsRepo.update(row.id,{receivedBytes:item.getReceivedBytes(),
totalBytes:item.getTotalBytes(),state}) + onChanged())`; `item.on('done',(_e,state)=> update final + liveItems.delete
+ onChanged())`. The DELETE of the floor preventDefault (viewController) is required (Task 5). Pure helpers:
`uniquifyFilename(name, existsFn)`, `resolveDownloadDir(settingDir, osDir)` — unit-tested. `liveItems: Map<number,
DownloadItem>` enables `downloads.cancel(id)` → `liveItems.get(id)?.cancel()`.

### 2.2 Permissions (remembered)
New `electron/main/permissions.ts`: `wirePermissions(session, { permissionsRepo, prompt })` RE-SETS both handlers
on the content session (last-set wins; ViewController's deny floor stays as the safe default before this runs):
- request: `origin = originOf(details.requestingUrl)`; `remembered = permissionsRepo.get(origin, permission)`; if
  remembered → `callback(remembered==='allow')`; else if `permission` in the Phase-5 set → `prompt(origin,
  permission)` (returns Promise<'allow'|'deny'>) → `permissionsRepo.set(origin,permission,decision)` +
  `callback(decision==='allow')`; else `callback(false)`.
- check: `remembered = permissionsRepo.get(requestingOrigin, permission)`; return `remembered==='allow'` (deny if none).
Pure `resolvePermission(remembered, permission, inSet)` → `{decision}|{prompt:true}|{deny:true}` — unit-tested.
`prompt` is a main→chrome flow: a `permissions.prompt` event (with a request id) → renderer dialog → a guarded
`permissions.resolve(requestId, decision)` reply; main correlates via a pending-Map.

### 2.3 Media / PDF / fullscreen
`autoplayPolicy:'document-user-activation-required'` + `plugins:true` added to the content `webPreferences`
(viewController, Task 5). Fullscreen listeners wired in index.ts boot (Task 12) needing `win`.

### 2.4 CSP (build-mode-aware, chrome-only)
Add a `transformIndexHtml` plugin to the renderer config in `electron.vite.config.ts` that injects the CSP `<meta>`
branching on `command`/mode: **prod/build** = `default-src 'self'; script-src 'self'; style-src 'self'
'unsafe-inline'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none';
frame-src 'none'; form-action 'none'`; **dev/serve** = relaxed (`script-src 'self' 'unsafe-inline' 'unsafe-eval';
connect-src 'self' ws:` etc.). REMOVE the static `<meta>` from `src/index.html`. The visited content view gets NO
app CSP (correct). e2e asserts the built `out/renderer/index.html` carries the strict directives.

### 2.5 Data export/import
`buildDataHandlers({ favoritesRepo, historyRepo, savedRepo, settingsRepo, win })`:
- `data.export()` → `payload = { version:1, favorites:list, history:list({limit:100000}), saved:list,
  settings:get }`; `dialog.showSaveDialog(win,{defaultPath:'aegis-export.json',filters:[{name:'JSON',extensions:
  ['json']}]})`; if not canceled `writeFile(filePath, JSON.stringify(payload,null,2))`; return `{ ok, path }`.
- `data.import(mode:'merge'|'replace')` → `dialog.showOpenDialog(win,{properties:['openFile'],filters:[json]})`;
  read+`validateExport(json)` (pure); if `replace`: `favoritesRepo.clear()/savedRepo.clear()/historyRepo.clear()` then
  insert all + `settingsRepo.set(payload.settings)`; if `merge`: insert rows whose url is not already present + shallow
  `settingsRepo.set(payload.settings)`. History inserts via `record(e,()=>e.visitedAt)`; favorites/saved via `add`.
  Return `{ ok, counts }`. Pure `validateExport(json)` + `planImport(payload, existing, mode)` — unit-tested.

### 2.6 Element picker
`buildPickerHandlers({ vc, customFiltersRepo, rebuildFromCache })`: `picker.start()` → `host = hostOf(vc.getState()
.url)`; `selector = await vc.contentWebContents.executeJavaScript(PICKER_IIFE, true)` (the IIFE overlays a hover
highlight + returns a Promise resolving with a computed CSS selector on click, or null on Esc/cancel); if selector:
`rule = `${host}##${selector}``; `customFiltersRepo.set(customFiltersRepo.get() + (existing?'\n':'') + rule)`;
`rebuildFromCache()`; return `{ ok, rule }`. Pure `computeSelectorScript()` (returns the IIFE string) +
`appendCosmeticRule(existing, host, selector)` — unit-tested; the live injection is e2e-tested.

---

## §3 shared/types additions

New `IPC` channels: `downloadsList:'downloads.list'`, `downloadsRemove:'downloads.remove'`,
`downloadsClear:'downloads.clear'`, `downloadsOpenFile:'downloads.openFile'`,
`downloadsShowInFolder:'downloads.showInFolder'`, `downloadsCancel:'downloads.cancel'`,
`evtDownloadsChanged:'downloads.changed'`; `permissionsList:'permissions.list'`,
`permissionsRemove:'permissions.remove'`, `permissionsClear:'permissions.clear'`,
`permissionsResolve:'permissions.resolve'`, `evtPermissionsPrompt:'permissions.prompt'`;
`dataExport:'data.export'`, `dataImport:'data.import'`; `pickerStart:'picker.start'`.

New types: `DownloadEntry { id:number; url:string; filename:string; savePath:string; state:'progressing'|
'completed'|'cancelled'|'interrupted'; receivedBytes:number; totalBytes:number; startedAt:number }`;
`SitePermission { origin:string; permission:string; decision:'allow'|'deny' }`; `PermissionPrompt { requestId:number;
origin:string; permission:string }`; `ImportMode='merge'|'replace'`; `Settings` gains `downloadDir: string`.

New `AegisApi` members: `downloads:{ list():Promise<DownloadEntry[]>; remove(id):Promise<DownloadEntry[]>;
clear():Promise<DownloadEntry[]>; openFile(id):Promise<void>; showInFolder(id):Promise<void>;
cancel(id):Promise<void>; onChanged(cb:()=>void):()=>void }`; `permissions:{ list():Promise<SitePermission[]>;
remove(origin,permission):Promise<SitePermission[]>; clear():Promise<SitePermission[]>;
resolve(requestId,decision):Promise<void>; onPrompt(cb:(p:PermissionPrompt)=>void):()=>void }`; `data:{
export():Promise<{ok:boolean;path?:string}>; import(mode:ImportMode):Promise<{ok:boolean;counts?:any}> }`;
`picker:{ start():Promise<{ok:boolean;rule?:string}> }`.

---

## §4 Interface ledger (exact signatures)

- `electron/main/db/downloadsRepo.ts` `class DownloadsRepo { constructor(db); list():DownloadEntry[];
  record(input:Omit<DownloadEntry,'id'>):DownloadEntry; update(id,partial:Partial<DownloadEntry>):void;
  remove(id):void; clear():void; get(id):DownloadEntry|undefined }` + `downloads` table.
- `electron/main/db/permissionsRepo.ts` `class PermissionsRepo { constructor(db); get(origin,permission):
  ('allow'|'deny')|undefined; set(origin,permission,decision):void; list():SitePermission[]; remove(origin,
  permission):void; clear():void }` + `site_permissions` table (PK origin,permission).
- `FavoritesRepo.clear():void`, `SavedRepo.clear():void` (new).
- `electron/main/downloads.ts` `wireDownloads(session, opts):void`; `electron/main/ipc/downloads.ts`
  `buildDownloadsHandlers(downloadsRepo, { liveItems, onChanged? }):Record<…>`.
- `electron/main/permissions.ts` `wirePermissions(session, opts):void`; `electron/main/ipc/permissions.ts`
  `buildPermissionsHandlers(permissionsRepo, { resolvePrompt }):Record<…>`.
- `electron/main/ipc/data.ts` `buildDataHandlers(repos, win):Record<…>`.
- `electron/main/ipc/picker.ts` `buildPickerHandlers({vc,customFiltersRepo,rebuildFromCache}):Record<…>`.
- pure helpers: `electron/main/downloads.ts` (uniquifyFilename, resolveDownloadDir) ; `permissions.ts`
  (resolvePermission, originOf); `ipc/data.ts` or a `dataPort.ts` (validateExport, planImport) ; `picker.ts`
  (appendCosmeticRule, the PICKER_IIFE constant + a `computeSelector` reference impl tested in jsdom).
- renderer: `useDownloads()` `{ downloads, remove, clear, openFile, showInFolder, cancel }` (+ onChanged refresh);
  `usePermissions()` `{ permissions, remove, clear, prompt }` (prompt = the active PermissionPrompt|null + resolve);
  `DownloadsPanel`, `DownloadsTab`, `SitePermissionsTab`, `DataTab`, a permission-prompt dialog, a downloads
  toolbar indicator, a picker action button. `useSettings` reused for `downloadDir`.

---

## §5 Conventions
TDD (failing test → minimal impl → green → commit; one commit/task; COMPLETE runnable code, no placeholders).
Repos: constructor(db) + prepared statements + additive `CREATE TABLE IF NOT EXISTS`. IPC builders return
`Record<string,(...a:any[])=>any>` (args without event), merged into the single `registerGuardedHandlers`. Preload
invoke wrappers + `subscribe<T>`; `AegisApi` typed. Engine rebuilds via `rebuildEngineFromCache` (Phase-4). Dialogs
need `win`. Downloads/permissions/fullscreen wired in boot (index.ts) where session+repos+win+forwarder are in
scope; the will-download floor + (optionally) the permission floor are removed/overridden as specified. Test
commands per §1.9. Branch `phase-5`, LOCAL only. Each task ends with a "New names introduced" list.

---

## §6 Task skeleton (drafters expand each into full TDD steps)

**Block A — data layer (Node-ABI DB tests)**
- T1: `shared/types.ts` — all new IPC channels + types (DownloadEntry/SitePermission/PermissionPrompt/ImportMode) +
  `Settings.downloadDir` + AegisApi (downloads/permissions/data/picker) + type test.
- T2: `DownloadsRepo` + `downloads` table + tests.
- T3: `PermissionsRepo` + `site_permissions` table + tests.
- T4: `FavoritesRepo.clear()` + `SavedRepo.clear()` + tests (for replace-import).

**Block B — main wiring (mixed; build + tsc where boot)**
- T5: content `webPreferences` add `autoplayPolicy:'document-user-activation-required'` + `plugins:true`; REMOVE the
  will-download `preventDefault` floor from `wireSecurity` (downloads handled in T12); update `viewController.test`.
- T6: pure helpers + tests — `uniquifyFilename`/`resolveDownloadDir` (downloads), `resolvePermission`/`originOf`
  (permissions), `validateExport`/`planImport` (data), `appendCosmeticRule` (+ selector ref impl) (picker).
- T7: `electron/main/downloads.ts` `wireDownloads` + `electron/main/ipc/downloads.ts` `buildDownloadsHandlers`
  (list/remove/clear/openFile→shell.openPath/showInFolder→shell.showItemInFolder/cancel→liveItems) + tests (fake
  session/item + fake repo).
- T8: `electron/main/permissions.ts` `wirePermissions` (re-set both handlers, remembered+prompt) +
  `electron/main/ipc/permissions.ts` `buildPermissionsHandlers` (list/remove/clear/resolve) + the prompt
  pending-Map + tests.
- T9: `electron/main/ipc/data.ts` `buildDataHandlers` (export→saveDialog+write; import→openDialog+validate+plan+apply
  merge/replace) + tests (fake dialogs/repos/fs).
- T10: `electron/main/ipc/picker.ts` `buildPickerHandlers` (executeJavaScript inject → append cosmetic rule →
  rebuildFromCache) + the PICKER_IIFE + tests (pure helpers + a fake vc/executeJavaScript).
- T11: CSP build-mode-aware `transformIndexHtml` plugin in `electron.vite.config.ts` (strict prod + relaxed dev) +
  remove the static meta from `src/index.html`; verify via `npm run build` + assert `out/renderer/index.html` CSP.
- T12: boot wiring in `index.ts` — construct DownloadsRepo/PermissionsRepo; `wireDownloads(vc.contentSession,…)`;
  `wirePermissions(vc.contentSession,…)`; fullscreen listeners (`win.setFullScreen`); register all new handlers;
  `__aegisTest` add `phase5:{ downloadsRepo, permissionsRepo }` (+ keep places/phase4). Verify build + tsc-clean index.ts.
- T13: `chromePreload.ts` — downloads/permissions/data/picker namespaces + the two events (downloads.changed,
  permissions.prompt) + tests; confirm chromePreload.ts tsc-clean.

**Block C — renderer hooks (jsdom)**
- T14: `useDownloads` + tests.
- T15: `usePermissions` (list/remove/clear + the prompt event→active prompt + resolve) + tests.

**Block D — UI + App wiring (jsdom)**
- T16: `DownloadsPanel` + Sidebar 3rd tab (convert the panel ternary to a map; add `downloads` to Tab/props/useId) +
  Sidebar.test updates + tests.
- T17: toolbar downloads indicator (active-count badge → opens sidebar to Downloads) + Toolbar slot + tests.
- T18: `DownloadsTab` (downloadDir editor via useSettings) + tests.
- T19: `SitePermissionsTab` (list/remove/clear) + the permission-prompt dialog component + tests.
- T20: `DataTab` (Export + Import with merge/replace choice + confirm-on-replace) + tests.
- T21: element-picker action button (toolbar or Settings) → `aegis.picker.start()` + tests.
- T22: App wiring — mount the 3 new Settings tabs + Downloads sidebar tab + indicator + picker action + the
  permission-prompt; wire useDownloads/usePermissions; App.test/Sidebar.test/Toolbar.test updates; tsc production-clean.

**Block E — e2e + docs + gate (Electron ABI)**
- T23: downloads e2e — a real fixture download → DownloadsRepo state + file on disk + downloads.changed; cancel/clear.
- T24: permissions e2e (request→remembered round-trip via the content WC) + CSP e2e (built chrome carries the strict
  CSP directives) + autoplay/PDF/fullscreen policy checks (webPreferences/state level).
- T25: data export/import e2e (round-trip merge AND replace via `__aegisTest`) + element-picker e2e (inject → selector
  → customFilter → cosmetic hide on a fixture).
- T26: write `docs/` — security-audit sign-off + engine/Chromium update policy + deferred-distribution (packaging/
  signing/auto-update needs) — then the FULL dual-ABI regression gate (`npm test` then `npm run build && npm run
  test:e2e`), all green, no regression. Phase-5 exit.

(~26 tasks. Drafters: expand each into the full TDD template with exact paths + complete code; pin every cross-module
name from §1/§3/§4; honor §2 mechanisms exactly.)
