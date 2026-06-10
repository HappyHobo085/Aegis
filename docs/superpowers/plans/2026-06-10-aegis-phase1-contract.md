# Aegis Phase 1 — Plan Contract (authoritative)

**Date:** 2026-06-10 · **Spec:** `docs/superpowers/specs/2026-06-10-aegis-phase1-design.md` · **Branch:** `phase-1`
**Purpose:** the locked reference for the Phase-1 TDD plan — pinned versions, **source-verified** `@ghostery/adblocker` API, as-built Phase-0 integration facts, the full `shared/types.ts` additions, the interface ledger every task must match, conventions, and the task skeleton. Drafters expand the skeleton using ONLY the names/signatures here.

---

## 0. Pinned versions (verified installed in a temp probe)
- `electron` **42.4.0** (Node 22, V8 14.8; global `fetch`/`AbortController` available in main).
- `@ghostery/adblocker-electron` **2.18.0**, `@ghostery/adblocker-electron-preload` **2.18.0**, `@ghostery/adblocker` (core, transitive) **2.18.0**.
- Core engine serialization tag: `ENGINE_VERSION = 876` (exported from `@ghostery/adblocker`).
- **No `cross-fetch`** — use global `fetch` (dep-free; streaming size-cap via `response.body.getReader()`).
- Adblocker packages are **pure JS** → **no `electron-rebuild`** burden (only `better-sqlite3` still needs it; ABI npm-script story from Phase 0 is unchanged).

## 1. Source-verified `@ghostery/adblocker(-electron)` API (do not deviate)
From reading the installed 2.18.0 source:

**`ElectronBlocker extends FiltersEngine`:**
- `static fromLists(fetch, urls: string[], config?: Partial<Config>, caching?): Promise<ElectronBlocker>` — fetches lists **and** `$redirect` resources (calls `fetchResources`), then `parse` + `updateResources`. Used by `generate-seed` only.
- `static parse(text: string, config?: Partial<Config>): ElectronBlocker` — builds from concatenated list text; **does NOT fetch resources**.
- `static deserialize(buf: Uint8Array): ElectronBlocker` — throws on a serialization-version/format mismatch.
- `serialize(): Uint8Array`.
- `updateResources(data: string, checksum: string): boolean` — load `$redirect` resources (resources.json content) into an engine built via `parse`.
- `update({ newNetworkFilters?, newCosmeticFilters?, removedNetworkFilters?, ... }): boolean` / `updateFromDiff(...)` — in-place update (NOT used in Phase 1; we swap whole engines).
- `enableBlockingInSession(session): BlockingContext` — **idempotent** (WeakMap-keyed per session; returns the existing context if already enabled). Registers `onBeforeRequest`+`onHeadersReceived` (network) and, when `config.loadCosmeticFilters` (default true), the cosmetics preload + global `ipcMain.handle('@ghostery/adblocker/...')`.
- `disableBlockingInSession(session): void` — **throws `'Trying to disable blocking which was not enabled'` if not enabled** → always guard with `isBlockingEnabled`. Removes the session's webRequest listeners + preload + the global ipcMain handlers.
- `isBlockingEnabled(session): boolean`.
- **Main-frame requests are NOT filtered** (`onBeforeRequest` early-returns for `request.isMainFrame()`); top-frame defense remains the Phase-0 `will-navigate`/`will-redirect`/`setWindowOpenHandler` layer.

**Blocked-request counting — events on the engine instance (core `FiltersEngine` is an EventEmitter; emitted inside `match()`):**
- `blocker.on('request-blocked', (request, result) => void)`
- `blocker.on('request-redirected', (request, result) => void)`
- (also `'request-whitelisted'`, `'request-allowed'`, `'csp-injected'` — unused.)
- Remove with `blocker.removeListener('request-blocked', fn)` (EventEmitter API). The Electron wrapper emits NO events of its own and Electron allows only ONE `onBeforeRequest` listener per session → **counting MUST use these engine events**, not a second webRequest listener.

**`Config` defaults (all we need are on by default):** `loadNetworkFilters=true`, `loadCosmeticFilters=true`, `loadGenericCosmeticsFilters=true`, `enableMutationObserver=true`, `enableCompression=false`, `guessRequestTypeFromUrl=false`. **Phase 1 passes NO custom config** (defaults give all three layers).

**Default sources (verified constants; all HTTPS, ghostery/adblocker GitHub assets):** the 14 URLs of `adsAndTrackingLists` (easylist, peter-lowe/serverlist, ublock-origin/{badware,filters-2020..2024,filters,quick-fixes,resource-abuse,unbreak}, easylist/easyprivacy, ublock-origin/privacy). Resources: `https://raw.githubusercontent.com/ghostery/adblocker/master/packages/adblocker/assets/ublock-origin/resources.json`. These match spec §6.1. **Import the constant** `adsAndTrackingLists` from `@ghostery/adblocker-electron` for the default URL set (re-exported); hardcode the single resources URL as `RESOURCES_URL`.

**Preload package:** resolved at runtime by the engine via `require.resolve('@ghostery/adblocker-electron-preload')` → `.../dist/index.cjs`. Must be installed + (for packaging) externalized + asarUnpacked.

## 2. As-built Phase-0 integration facts (verified by reading the code)
- **Content session/WC:** `ViewController` builds the content `WebContentsView` with `partition:'persist:content'` (`viewController.ts:48-57`). Add getters: `get contentSession(): Electron.Session { return this.view.webContents.session }` and `get contentWebContents(): Electron.WebContents { return this.view.webContents }`. **No other VC change.**
- **Boot (`electron/main/index.ts`):** sync `boot()`; order today = openDb→runMigrations→SettingsRepo→createMainWindow→`buildViewEventForwarders(chromeWc)` (returns `{onState,onFailed,onCrashed}`)→`onState` wrapper (persists session)→`new ViewController({contentPreloadPath,onState,onFailed,onCrashed})`→`addChildView`+`layout`+resize→`registerGuardedHandlers(chromeWc.id, {...navHandlers, ...settingsHandlers})`→e2e test registry→**read last session → `vc.navigate(firstUrl)`** (the LAST step; `firstUrl = AEGIS_HOME_URL ?? last?.url ?? settings.homeUrl`)→`win.on('closed')`. **Insert adblock setup AFTER ViewController creation and BEFORE `vc.navigate`** (so blocking is primed for the first nav); schedule background refresh + 24 h timer AFTER navigate.
- **IPC guard:** `registerGuardedHandlers(senderWcId: number, handlers: Record<string, (e, ...args)=>...>)` from `electron/main/ipc/guard.ts` — wraps each handler with sender validation. Existing builders return plain handler maps: `buildNavHandlers(vc, settingsRepo)`, `buildSettingsHandlers(settingsRepo)`. New: `buildAdblockHandlers(controller)`, `buildListsHandlers(listManager-or-refreshFn)`.
- **Event forwarders:** `buildViewEventForwarders(chromeWc)` (`electron/main/ipc/nav.ts`) maps onState/onFailed/onCrashed to `chromeWc.send(IPC.evtNavState|...)`. Add `onBlockedCount` the same way → `chromeWc.send(IPC.evtAdblockBlockedCount, count)`.
- **DB:** `openDb(path)` + `runMigrations(db)` (`electron/main/db/sqlite.ts`); migrations are idempotent `CREATE TABLE IF NOT EXISTS`. Repos take the `db` handle (see `SettingsRepo`). **Add two `CREATE TABLE IF NOT EXISTS` + seeds to `runMigrations`.**
- **`did-start-navigation` (Electron 42.4.0):** `wc.on('did-start-navigation', (details) => ...)` where `details: { url: string; isSameDocument: boolean; isMainFrame: boolean; frame }`. Reconcile/reset only when `details.isMainFrame && !details.isSameDocument`.
- **atomicFile:** `writeFileAtomic(path, data: string)`, `readFileSafe(path): string | null` (`electron/lib/atomicFile.ts`). For binary engine blobs, add `writeFileAtomicBytes(path, data: Uint8Array)` + `readBytesSafe(path): Buffer | null` (Task in Block B) — same temp-write+rename + crash-safe-read pattern.
- **Renderer chrome:** `Toolbar.tsx` renders `NavControls` + `AddressBar`; `useNav.ts` owns nav state (has the current `url`). `ipcClient.ts` wraps `window.aegis`. `chromePreload.ts` exposes `window.aegis` via contextBridge; `useDialog`/`Toaster`/`theme` exist. Tests: Vitest projects (`node` for electron/shared, `jsdom` for src); component tests use `@testing-library/react`.

## 3. `shared/types.ts` additions (EXACT — single source of truth)
```ts
// ---- adblock data model ----
export interface AdblockState {
  enabled: boolean;            // global on/off
  allowlistedHosts: string[];  // hosts where blocking is suppressed
  sessionBlocked: number;      // monotonic session total
}
export interface BlockedCount {
  viewId: ViewId;
  page: number;                // resets each top-frame, non-same-document navigation
  session: number;             // monotonic
}
export interface ListSourceResult {
  listId: string;
  ok: boolean;
  error?: string;
}
export interface ListUpdateResult {
  perSource: ListSourceResult[];
  lastUpdated: number;         // epoch ms of this refresh attempt
}

// ---- IPC map additions (extend the existing `IPC` object) ----
//   adblockSetEnabled: 'adblock.setEnabled',
//   adblockToggleAllowlist: 'adblock.toggleAllowlist',
//   adblockGetState: 'adblock.getState',
//   listsUpdateNow: 'lists.updateNow',
//   evtAdblockBlockedCount: 'adblock.blockedCount',

// ---- AegisApi additions (extend the existing interface) ----
//   adblock: {
//     setEnabled(enabled: boolean): Promise<AdblockState>;
//     toggleAllowlist(host: string): Promise<AdblockState>;
//     getState(): Promise<AdblockState>;
//     onBlockedCount(cb: (c: BlockedCount) => void): () => void;
//   };
//   lists: { updateNow(): Promise<ListUpdateResult>; };
```
`setEnabled`/`toggleAllowlist` **return the new `AdblockState`** (UI syncs from the return value). Renderer derives `host` for `toggleAllowlist` from its nav-state `url` via `new URL(url).hostname`.

## 4. Interface ledger (every new module's exported surface — match EXACTLY)

**`electron/main/db/adblockRepo.ts`**
```ts
export class AdblockRepo {
  constructor(db: Database);            // better-sqlite3 Database
  getState(): { enabled: boolean; allowlistedHosts: string[] };
  setEnabled(enabled: boolean): void;
  isAllowlisted(host: string): boolean;
  toggleAllowlist(host: string): string[];   // returns new allowlist
}
```
**`electron/main/db/subsRepo.ts`**
```ts
export interface Subscription { listId: string; url: string; enabled: boolean; lastUpdated: number | null; etag: string | null; hash: string | null; }
export class SubsRepo {
  constructor(db: Database);
  seedDefaults(defaults: { listId: string; url: string }[]): void;  // idempotent INSERT OR IGNORE
  all(): Subscription[];
  updateMeta(listId: string, meta: { lastUpdated: number; etag: string | null; hash: string }): void;
}
```
**`electron/lib/atomicFile.ts` (additions)**
```ts
export function writeFileAtomicBytes(path: string, data: Uint8Array): void;
export function readBytesSafe(path: string): Buffer | null;
```
**`electron/main/adblock/engine.ts`**
```ts
import { ElectronBlocker } from '@ghostery/adblocker-electron';
export function buildEngine(listTexts: string[], resources: string | null): ElectronBlocker; // parse + (resources? updateResources)
export function loadCachedEngine(cachePath: string): ElectronBlocker | null;     // readBytesSafe → deserialize, null on miss/mismatch
export function loadSnapshotEngine(snapshotPath: string): ElectronBlocker | null; // same, for bundled blob
export function serializeEngine(blocker: ElectronBlocker, cachePath: string): void; // writeFileAtomicBytes(serialize())
export const DEFAULT_LIST_URLS: { listId: string; url: string }[];               // derived from adsAndTrackingLists
export const RESOURCES_URL: string;
```
**`electron/main/adblock/listManager.ts`**
```ts
export interface FetchedSource { listId: string; url: string; ok: boolean; text: string; etag: string | null; hash: string; error?: string; }
export interface FetchAllResult { sources: FetchedSource[]; resources: string | null; }
export async function fetchSource(url: string, opts: { timeoutMs: number; maxBytes: number; fetchImpl?: typeof fetch }): Promise<{ text: string; etag: string | null }>; // throws on timeout / >maxBytes / non-2xx
export async function fetchAll(subs: { listId: string; url: string }[], opts: { cacheDir: string; timeoutMs: number; maxBytes: number; resourcesUrl: string; fetchImpl?: typeof fetch }): Promise<FetchAllResult>; // per-source try fetch→cache-fallback; resources best-effort
export class RefreshScheduler {
  constructor(deps: { intervalMs: number; onTick: () => Promise<void>; setTimer?: (fn, ms)=>any; clearTimer?: (h)=>void });
  start(): void;          // schedules repeated ticks; no immediate tick
  stop(): void;
  triggerNow(): Promise<void>;  // runs onTick once now WITHOUT disturbing the schedule (manual update path; no double-fire)
}
```
**`electron/main/adblock/blockedCounter.ts`**
```ts
import { ElectronBlocker } from '@ghostery/adblocker-electron';
export class BlockedCounter {
  constructor(viewId: ViewId);
  attach(blocker: ElectronBlocker): void;   // add request-blocked + request-redirected listeners
  detach(blocker: ElectronBlocker): void;   // remove them (for engine swap)
  resetPage(): void;                         // page=0 (session untouched)
  snapshot(): BlockedCount;                  // { viewId, page, session }
}
```
**`electron/main/adblock/controller.ts`**
```ts
import type { Session, WebContents } from 'electron';
import { ElectronBlocker } from '@ghostery/adblocker-electron';
export class AdblockController {
  constructor(opts: {
    viewId: ViewId; session: Session; contentWc: WebContents;
    repo: AdblockRepo; blocker: ElectronBlocker;
    onBlockedCount: (c: BlockedCount) => void;
  });
  primeFor(firstUrl: string): void;       // reconcile session enable/disable for the first nav (call BEFORE vc.navigate)
  setEnabled(enabled: boolean): AdblockState;   // persist; applies next nav
  toggleAllowlist(host: string): AdblockState;  // persist; applies next nav
  getState(): AdblockState;
  setPendingBlocker(b: ElectronBlocker): void;  // refresh produced a new engine; swap on next nav
  // internal: did-start-navigation(main,non-same-doc) → swap pending? → reconcile(host) → counter.resetPage()
  //           did-stop-loading → onBlockedCount(counter.snapshot())
}
```
Reconcile rule (host = `new URL(url).hostname`): `shouldBlock = repo.getState().enabled && !repo.isAllowlisted(host)`; if `shouldBlock && !blocker.isBlockingEnabled(session)` → `enableBlockingInSession`; if `!shouldBlock && blocker.isBlockingEnabled(session)` → `disableBlockingInSession`. Swap: if pending, `if isBlockingEnabled→disable(old)`, `counter.detach(old); active=pending; counter.attach(active); pending=null` (then reconcile re-enables as needed).

**`electron/main/ipc/adblock.ts`**: `export function buildAdblockHandlers(c: AdblockController): Record<string, ...>` → keys `IPC.adblockSetEnabled` (→`c.setEnabled`), `IPC.adblockToggleAllowlist` (→`c.toggleAllowlist`), `IPC.adblockGetState` (→`c.getState`).
**`electron/main/ipc/lists.ts`**: `export function buildListsHandlers(updateNow: () => Promise<ListUpdateResult>): Record<string, ...>` → key `IPC.listsUpdateNow`.
**`src/hooks/useAdblock.ts`**: `export function useAdblock(viewId, currentUrl): { state: AdblockState; page: number; setEnabled(b): void; toggleAllowlist(): void; updateNow(): Promise<ListUpdateResult> }` (subscribes to `onBlockedCount`, seeds via `getState`).
**`src/components/AdblockShield.tsx`**: badge (per-page count) + popover (global toggle, allow-this-site checkbox, page/session counts). Wired into `Toolbar.tsx`.

## 5. Conventions
- **TDD**, bite-sized steps, one commit per task (`feat(adblock): …` / `test(adblock): …` / `chore(adblock): …`). Branch `phase-1`. **Local commits only — no `git push`, no `git remote`, no branch rename** (project standing rule).
- Unit/component test run: `npx vitest run <file>` (the `pretest`→`rebuild:node` only matters for the suite-wide `npm test`; DB-touching tests need the Node ABI). e2e: `npx playwright test <file>` (after `npm run build`).
- Electron-main unit tests must not require a live Electron runtime: pure modules (`engine`, `listManager`, `blockedCounter`, repos, `atomicFile`) take injected deps (`fetchImpl`, `setTimer`, a fake EventEmitter-shaped blocker, an in-memory better-sqlite3) so they run under the `node` Vitest project. Session/WebContents-bound behavior (`controller`, boot, real blocking) is covered by Playwright `_electron` e2e.
- Time/network/timers ALWAYS injectable. Fixtures pinned in-repo; no live network in tests.
- Engine config: pass none (defaults). Global `fetch` for runtime; the `generate-seed` dev script may use global `fetch` under Node 22.
- `did-start-navigation` reconcile/reset gated on `isMainFrame && !isSameDocument`.

## 6. Task skeleton (drafters expand; ~24 tasks in 5 blocks)
**Block A — deps, snapshot, types, persistence**
1. Add deps (`@ghostery/adblocker-electron`, `@ghostery/adblocker-electron-preload`) + electron-vite externalize/asarUnpack both + verify `npm run build`.
2. `generate-seed` dev script (`scripts/generate-seed.ts` or `.mjs`) → builds `fromLists(fetch, adsAndTrackingLists)` → writes bundled blob to `electron/main/adblock/seed/engine-seed.bin`; npm script `generate-seed`; **compat test** deserializes the committed blob (skips with a clear message if absent).
3. `shared/types.ts` additions (§3) + `shared/types.test.ts` shape assertions.
4. `adblockRepo.ts` + table in `runMigrations` + tests (in-memory db).
5. `subsRepo.ts` + table in `runMigrations` + `seedDefaults` + tests.

**Block B — engine, lists, counter, atomic bytes**
6. `atomicFile` byte helpers (`writeFileAtomicBytes`/`readBytesSafe`) + tests.
7. `engine.ts` `buildEngine` (parse + updateResources) + `DEFAULT_LIST_URLS`/`RESOURCES_URL` + tests (build from tiny inline list text, assert it blocks a known URL via `.match`).
8. `engine.ts` `loadCachedEngine`/`loadSnapshotEngine`/`serializeEngine` (round-trip serialize→deserialize; corrupt/missing → null) + tests.
9. `listManager.ts` `fetchSource` (injected `fetchImpl`; AbortController timeout; streaming `maxBytes` cap → throw; non-2xx → throw) + tests.
10. `listManager.ts` `fetchAll` (per-source fetch→cache-fallback via atomicFile; resources best-effort; returns metadata) + tests.
11. `listManager.ts` `RefreshScheduler` (injected timer; `start` schedules, `triggerNow` runs once without double-firing) + tests.
12. `blockedCounter.ts` (attach/detach to a fake EventEmitter blocker; page/session increments on `request-blocked`+`request-redirected`; `resetPage`; `snapshot` payload) + tests.

**Block C — controller, IPC, boot, preload**
13. `ViewController` getters `contentSession`/`contentWebContents` + test.
14. `AdblockController` (reconcile, swap, setEnabled/toggleAllowlist/getState/primeFor; uses injected blocker + repo + a fake WebContents/session exposing `isBlockingEnabled` via the blocker) + unit tests for state/persistence + reconcile decisions (pure-logic; session binding asserted in e2e).
15. `ipc/adblock.ts` `buildAdblockHandlers` + tests.
16. `ipc/lists.ts` `buildListsHandlers` + tests.
17. `chromePreload.ts` add `adblock`/`lists` namespaces + `onBlockedCount` + preload test.
18. Boot wiring in `index.ts`: construct repos/engine(load cache→snapshot)/counter/controller; `controller.primeFor(firstUrl)` before `vc.navigate`; register adblock+lists handlers; `fwd.onBlockedCount`; after navigate, define `runRefresh()` (fetchAll→buildEngine→`controller.setPendingBlocker`+`serializeEngine`), kick one background refresh, `new RefreshScheduler(...).start()`; `updateNow` wired to `scheduler.triggerNow()` returning `ListUpdateResult`. (Covered by Block-E e2e.)

**Block D — renderer**
19. `useAdblock.ts` + tests.
20. `AdblockShield.tsx` (badge + popover; a11y: button + focus) + tests.
21. Wire `AdblockShield` into `Toolbar.tsx` + tests.

**Block E — verification (Playwright `_electron`)**
22. e2e: block-on-local-ad-fixture (fixtureServer page with a sub-resource matching a seeded test filter) → `blockedCount > 0` pushed to chrome; badge updates.
23. e2e: toggle timing — global off → next nav has no new blocks → re-enable restores; allowlist a host → ads restored next nav; un-allowlist restores blocking. (Uses a test engine built from an inline filter, injected via `AEGIS_*` env hook.)
24. e2e: first-run-on-seed (no cache → snapshot blocks) + offline cache-fallback + `lists.updateNow` happy path; then **run the full Phase-0 suite (`npm test` + `npm run test:e2e`) and confirm green (regression gate).**

## 7. Known decisions folded in (so drafters don't re-litigate)
- Passive first-run "updating filters…" indicator is **deferred** (no new status channel in Phase 1); manual `lists.updateNow` gives feedback via its awaited result/spinner. (Spec §9 relaxed; not a success criterion.)
- `contentPreload.ts` stays a no-op (engine registers its own cosmetics preload).
- No `cross-fetch`; global `fetch`.
- Engine swap (not in-place `update`) on refresh, applied at the navigation boundary.
- Versioned DB migration runner remains a pre-Phase-3 follow-up; Phase 1 uses idempotent `CREATE TABLE IF NOT EXISTS`.

---

## 8. Review-driven corrections (AUTHORITATIVE — override §1–§7 wherever they conflict)
A first draft was adversarially reviewed; these corrections are mandatory and supersede earlier sections.

**8.1 — Bundled snapshot MUST be copied into the main build output.** At runtime `__dirname` for main = `out/main/`, but `generate-seed` writes the committed blob to the SOURCE path `electron/main/adblock/seed/engine-seed.bin`. Nothing bridges them → `loadSnapshotEngine` returns null in the built/e2e app and first-run-on-seed fails. **Fix (in Task 1):** add a tiny inline Vite plugin to the `main` config of `electron.vite.config.ts` that copies the blob on every main build (dev + build):
```ts
import { copyFileSync, mkdirSync } from 'node:fs'
function copySeedPlugin() {
  return {
    name: 'aegis-copy-seed',
    writeBundle() {
      try {
        const dir = resolve(__dirname, 'out/main/adblock/seed')
        mkdirSync(dir, { recursive: true })
        copyFileSync(
          resolve(__dirname, 'electron/main/adblock/seed/engine-seed.bin'),
          resolve(dir, 'engine-seed.bin'),
        )
      } catch { /* seed not generated yet; loadSnapshotEngine handles null */ }
    },
  }
}
```
Add `plugins: [copySeedPlugin()]` to the `main` config. Task 18 reads `join(__dirname, 'adblock/seed/engine-seed.bin')`. Packaged-app `extraResources` is a recorded **Phase-5** follow-up, not built now.

**8.2 — Import convention (keeps pure modules node-testable).** Import ALL adblocker symbols (value + type) from `@ghostery/adblocker-electron` ONLY — it re-exports the entire core (`export * from '@ghostery/adblocker'`), so `Request`, `FiltersEngine`, etc. are available there; do NOT import `@ghostery/adblocker` directly (undeclared transitive dep). The wrapper does `require('electron')` at module load (`index.js:48`), but in plain Node that returns a harmless path string — only `enable/disableBlockingInSession` touch real Electron APIs, and unit tests never call those.
- **VALUE** import of `ElectronBlocker` (for static `parse`/`deserialize`) ONLY in: `engine.ts`, `scripts/generate-seed.mjs`, boot `index.ts`.
- **TYPE-ONLY** import (`import type { ElectronBlocker }`) everywhere else (`controller.ts`, `blockedCounter.ts`) — erased at compile, so no module-load coupling. `blockedCounter` types its blocker param structurally for the methods it uses (`on`/`removeListener`).
- **Task 1 adds a verification step:** `node -e "const {ElectronBlocker}=require('@ghostery/adblocker-electron'); console.log(typeof ElectronBlocker, typeof ElectronBlocker.parse, typeof ElectronBlocker.deserialize)"` → expect `function function function` (proves engine.ts unit tests run under the Vitest `node` project). Do not assert testability without running this.

**8.3 — `buildEngine` resources checksum.** Replace the fabricated `${resources.length}` with a real content hash: `import { createHash } from 'node:crypto'`; `const checksum = createHash('sha1').update(resources).digest('hex')`; call `engine.updateResources(resources, checksum)`. `updateResources` returns boolean — the Task 7 test asserts it returns `true` (not merely no-throw). Skip `updateResources` when `resources === null`.

**8.4 — Refresh wiring (NO double-fire).** Boot defines ONE canonical `runRefresh(): Promise<ListUpdateResult>` (fetchAll → buildEngine when sources usable → `controller.setPendingBlocker` + `serializeEngine` → return `{ perSource, lastUpdated }`).
- Scheduler: `new RefreshScheduler({ intervalMs, onTick: () => runRefresh().then(() => {}) })`.
- Manual: `const updateNow = () => runRefresh()` (returns the result). `buildListsHandlers(updateNow)`.
- **NEVER** `triggerNow().then(runRefresh)`. `RefreshScheduler.triggerNow(): Promise<void>` stays, used ONLY by the Task 11 scheduler unit test, NOT by boot.

**8.5 — Add `AdblockController.snapshotCount(): BlockedCount`** (`return this.counter.snapshot()`), extending the §4 ledger. Used by e2e.

**8.6 — Test registry (`__aegisTest`) shape — single source of truth.** Task 18, when `process.env.AEGIS_E2E === '1'`:
```ts
(globalThis as any).__aegisTest = {
  primary: vc,                     // ViewController (has .contentWebContents getter, Task 13)
  chromeWcId: chromeWc.id,
  adblock: {
    controller,
    snapshotCount: () => controller.snapshotCount(),       // BlockedCount
    setEnabled:   (b: boolean) => controller.setEnabled(b),
    toggleAllowlist: (h: string) => controller.toggleAllowlist(h),
    getState:     () => controller.getState(),
    updateNow,                                              // () => Promise<ListUpdateResult>
  },
};
```
Block E (Tasks 22–24) reads counts via `electronApp.evaluate(() => (globalThis as any).__aegisTest.adblock.snapshotCount())` — **NOT** via `win.contentView.children[i]` indexing or chrome-page capture. Use these exact names.

**8.7 — E2E determinism env hooks — IMPLEMENTED in Task 18 boot:**
- `AEGIS_ADBLOCK_TEST_FILTER` (string): if set, the INITIAL engine = `buildEngine([value], null)` (deterministic), bypassing cache/snapshot.
- `AEGIS_ADBLOCK_OFFLINE` (`'1'`): boot uses `const refreshFetch = OFFLINE ? () => Promise.reject(new Error('offline')) : globalThis.fetch` and passes `fetchImpl: refreshFetch` to `fetchAll` inside `runRefresh` → offline `updateNow()` makes every source `ok:false` (cache-fallback) deterministically.
- `AEGIS_ADBLOCK_LIST_BASE` (string): if set, refresh sources = `DEFAULT_LIST_URLS.map(s => ({ listId: s.listId, url: \`${base}/${s.listId}.txt\` }))` and resources URL = `${base}/resources.json`; else `DEFAULT_LIST_URLS` + `RESOURCES_URL`.
- **Skip the automatic first-run refresh kick** when `AEGIS_ADBLOCK_OFFLINE==='1' || AEGIS_ADBLOCK_TEST_FILTER` is set (so deterministic engines/offline tests control timing); ALWAYS register handlers + the `updateNow` hook so explicit calls work. The 24h scheduler never fires within a test.

**8.8 — `App.test.tsx` mock — concrete UNCONDITIONAL edit in Task 21.** First READ the existing `src/App.test.tsx` `aegis`/ipcClient mock to match its shape, then add:
```ts
adblock: {
  getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
  setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
  toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
  onBlockedCount: vi.fn().mockReturnValue(() => {}),
},
lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
```
Not a maybe-step — `useAdblock` calls `getState`/`onBlockedCount` at mount.

**8.9 — Real engine-swap coverage (Task 24 adds an ONLINE-fixture refresh test).** Beyond the offline cache-fallback test, add an e2e: launch with `AEGIS_ADBLOCK_TEST_FILTER` (initial engine blocks fixture ad A) + `AEGIS_ADBLOCK_LIST_BASE` → fixtureServer (its served `<listId>.txt` blocks a DIFFERENT ad B); call `__aegisTest.adblock.updateNow()` (real fetch → real second `ElectronBlocker` built → `setPendingBlocker`), navigate, assert: (a) `updateNow` result `perSource` all `ok`; (b) after the swap-nav, ad B is now blocked (`snapshotCount().session` grows) and NO throw — exercising the real swap + re-enable + counter re-attach against a genuine second engine.

**8.10 — Task 2 is a scaffold task, NOT red-green.** Step 2 expectation = "PASS-with-skip (logs the 'run generate-seed' warning) because the blob is absent"; Step 4 (after `npm run generate-seed`) = the meaningful green (`deserialize` returns an `ElectronBlocker`). Do not claim a FAIL that won't occur.

**8.11 — Task 13 must extend the electron mock for `session`.** READ `electron/main/viewController.test.ts`'s electron mock; ensure the mocked `WebContentsView().webContents` exposes a STABLE `session` object and stable `webContents` identity; extend the mock explicitly if absent. Assert `vc.contentSession === <mockSession>` and `vc.contentWebContents === <mockWebContents>`.

**8.12 — Controller event wiring (exact).** `contentWc.on('did-start-navigation', d => { if (!d.isMainFrame || d.isSameDocument) return; this.swapPendingIfAny(); this.reconcile(d.url); this.counter.resetPage(); })` and `contentWc.on('did-stop-loading', () => this.opts.onBlockedCount(this.counter.snapshot()))`.

**8.13 — No placeholders/dead code.** Task 17: write only the real preload test (no "thin placeholder anchor blocks"). Task 18: refresh-failure handler is concrete — `runRefresh().catch(err => console.error('[adblock] background refresh failed', err))` (non-fatal); no `dialog.showErrorBox;` no-op, no "replace later" prose. Task 24: use only the `__aegisTest.adblock.updateNow()` hook (no nested redeclared `updateNow`).
