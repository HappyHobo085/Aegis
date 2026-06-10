# Aegis Phase 3 — Plan Contract (authoritative)

**Date:** 2026-06-10 · **Spec:** `docs/superpowers/specs/2026-06-10-aegis-phase3-design.md` · **Branch:** `phase-3` (off `main`; local-only, NOT pushed)
**Purpose:** locked reference for the Phase-3 TDD plan — as-built integration facts (verified by reading the code), the content-inset layout mechanism, the full `shared/types.ts` additions, the interface ledger, conventions, and the task skeleton. Drafters expand the skeleton using ONLY the names/signatures here.

## 0. Versions / stack
electron 42.4.0 · better-sqlite3 12.10.0 · React 19 + TS · Vitest 4 (`node` + `jsdom` projects) · Playwright `_electron`. No new runtime deps. ABI: DB unit tests need the **Node ABI** (`npm test` runs `pretest`→`rebuild:node`; for a single DB test run `npm run rebuild:node && npx vitest run <file>` since e2e builds leave better-sqlite3 on the Electron ABI). Pure-renderer/electron-logic tests have no ABI concern.

## 1. As-built integration facts (verified — match EXACTLY)
- **DB** (`electron/main/db/sqlite.ts`): `openDb(path): Database.Database`; `runMigrations(db)` runs ONE idempotent `db.exec(\`CREATE TABLE IF NOT EXISTS …\`)` block (tables `settings`, `adblock_config`, `filter_subscriptions`). Repos take `db: Database.Database`, pre-compile prepared statements as `private readonly` fields (see `AdblockRepo`/`SubsRepo`/`SettingsRepo`), JSON columns parse with a try/catch fallback to `[]`. Add 3 tables to the SAME `db.exec` block.
- **Nav events** (`electron/main/viewController.ts`): `wc.on('did-navigate', (_e, url) => { this.lastCommittedUrl = url; … })` (top-frame committed nav); `wc.on('did-navigate-in-page', (_e, url, isMainFrame) => { if (!isMainFrame) return; … })` (SPA); `wc.on('page-title-updated', (_e, title) => …)` (debounced 400 ms internally). Getters: `vc.contentWebContents` (Electron.WebContents), `vc.contentSession`, `vc.id` (=== PRIMARY_VIEW_ID === 1), public `vc.view` (WebContentsView). The history recorder subscribes to `vc.contentWebContents` directly (the adblock controller already does this).
- **Layout** (`electron/main/window.ts`): `layout(win: BaseWindow, chromeView: WebContentsView, contentView?: WebContentsView)` sets `chromeView` to `(0,0,width,height)` (full window) and `contentView` to `(0, CHROME_TOP_HEIGHT, width, height − CHROME_TOP_HEIGHT)`. `CHROME_TOP_HEIGHT = 56` (`constants.ts`). Content is added AFTER chrome (`index.ts`), so content is ON TOP in the lower region; chrome shows only where content doesn't cover. `index.ts` does `win.on('resize', () => layout(win, chromeView, vc.view))`.
- **IPC** (`electron/main/ipc/nav.ts`, `index.ts`): `registerGuardedHandlers(chromeWc.id, { ...buildNavHandlers(vc, settingsRepo), ...buildSettingsHandlers(settingsRepo), ...buildAdblockHandlers(controller), ...buildListsHandlers(updateNow) })` (sender-validated). Handler builders return `Record<string,(...a:any[])=>any>` (handlers receive invoke args WITHOUT the event). `buildViewEventForwarders(chromeWc)` returns `{onState,onFailed,onCrashed}` each doing `chromeWc.send(IPC.evt…, payload)`. `shared/types.ts` `IPC` map + `AegisApi` are the single source of truth.
- **Preload** (`electron/preload/chromePreload.ts`): a `subscribe<T>(channel, cb)` helper (`ipcRenderer.on` + returns unsubscriber); the `api: AegisApi` object exposes `nav/view/settings/adblock/lists`; `contextBridge.exposeInMainWorld('aegis', api)`. Add `favorites/history/saved` namespaces + `view.setContentInset` + `onHistoryChanged`.
- **Renderer** (`src/`): `App.tsx` renders `<Toolbar state … />` (NavControls + AddressBar + AdblockShield) over the content view; hooks in `src/hooks/` (`useNav`, `useAdblock`, `useDialog`); `src/lib/ipcClient.ts` wraps `window.aegis` (the renderer imports `aegis` from there); `theme`, `toast`/`Toaster` (aria-live), `useDialog` (focus-trap + Esc + restore — reuse for the manager modal). Component tests: `@testing-library/react` + `userEvent` under the `jsdom` Vitest project.
- **e2e** (`electron/test/e2e/`): Playwright `_electron`; the retry-tolerant `launchApp` poll (`try { await app.evaluate(()=>__aegisTest.primary.getState().url) } catch { return '' }` inside `expect.poll`); `__aegisTest = { primary: vc, chromeWcId, adblock: {…} }` (gated `AEGIS_E2E==='1'`); `AEGIS_USER_DATA` overrides the data dir (use a fresh mkdtemp per test; reuse the SAME dir across two launches to test persistence); `AEGIS_HOME_URL` avoids live network; `fixtureServer` serves `electron/test/fixtures/**` over `http://127.0.0.1`. Content read via `__aegisTest.primary.view.webContents.executeJavaScript(expr, true)`. Phase-0+1+2 gate: **277 unit/component + 31 e2e** — must stay green.

## 2. Content-inset layout mechanism (the key new piece)  **[decided]**
The renderer owns chrome layout and reports the content inset; main positions the content view.
- `window.ts`: change `layout` to accept an inset: `layout(win, chromeView, contentView?, inset: { top: number; left: number } = { top: CHROME_TOP_HEIGHT, left: 0 })` → content = `(inset.left, inset.top, width − inset.left, height − inset.top)`; chrome stays full-window.
- `index.ts`: hold `let contentInset = { top: CHROME_TOP_HEIGHT, left: 0 }`; define `const setContentInset = (top: number, left: number) => { contentInset = { top, left }; layout(win, chromeView, vc.view, contentInset); }`; change the resize handler to `win.on('resize', () => layout(win, chromeView, vc.view, contentInset))`. Register `...buildViewLayoutHandlers(setContentInset)`.
- New handler builder `electron/main/ipc/viewLayout.ts`: `buildViewLayoutHandlers(setContentInset: (top:number, left:number)=>void): Record<string,(...a:any[])=>any>` → `{ [IPC.viewSetContentInset]: (_viewId: ViewId, inset: { top: number; left: number }) => setContentInset(inset.top, inset.left) }`. (Unit-testable: assert it forwards top/left.)
- Renderer computes the inset from KNOWN layout constants (NOT DOM measurement — deterministic + testable): `top = TOOLBAR_H + (favBarVisible ? FAVBAR_H : 0)`, `left = sidebarOpen ? SIDEBAR_W : 0`, with `TOOLBAR_H = CHROME_TOP_HEIGHT = 56`, `FAVBAR_H = 40`, `SIDEBAR_W = 280` (shared with the CSS). `useContentInset(viewId, { favBarVisible, sidebarOpen })` calls `aegis.view.setContentInset(viewId, { top, left })` whenever those flags change (and once on mount). **[verify@plan]** the inset + resize round-trip (toggle sidebar → content narrows; close → restores; window resize keeps the inset).

## 3. `shared/types.ts` additions (EXACT)
```ts
export interface Favorite { id: number; name: string; url: string; tags: string[]; position: number; }
export interface HistoryEntry { id: number; url: string; title: string; visitedAt: number; }
export interface SavedItem { id: number; url: string; title: string; savedAt: number; }
export interface ContentInset { top: number; left: number; }

// IPC map additions:
//   favoritesList:'favorites.list', favoritesAdd:'favorites.add', favoritesUpdate:'favorites.update',
//   favoritesRemove:'favorites.remove', favoritesReorder:'favorites.reorder',
//   favoritesRenameTag:'favorites.renameTag', favoritesDeleteTag:'favorites.deleteTag', favoritesTagUnion:'favorites.tagUnion',
//   historyList:'history.list', historySearch:'history.search', historyRemove:'history.remove', historyClear:'history.clear',
//   savedList:'saved.list', savedAdd:'saved.add', savedRemove:'saved.remove', savedHas:'saved.has',
//   viewSetContentInset:'view.setContentInset',
//   evtHistoryChanged:'history.changed'

// AegisApi additions:
//   favorites: { list(): Promise<Favorite[]>; add(input:{name:string;url:string;tags:string[]}): Promise<Favorite[]>;
//     update(id:number, partial:{name?:string;url?:string;tags?:string[]}): Promise<Favorite[]>; remove(id:number): Promise<Favorite[]>;
//     reorder(ids:number[]): Promise<Favorite[]>; renameTag(oldT:string,newT:string): Promise<Favorite[]>;
//     deleteTag(tag:string): Promise<Favorite[]>; tagUnion(): Promise<string[]>; };
//   history: { list(opts?:{limit?:number;offset?:number}): Promise<HistoryEntry[]>; search(q:string): Promise<HistoryEntry[]>;
//     remove(id:number): Promise<void>; clear(): Promise<void>; onChanged(cb:()=>void):()=>void; };
//   saved: { list(): Promise<SavedItem[]>; add(input:{url:string;title:string}): Promise<SavedItem[]>;
//     remove(id:number): Promise<SavedItem[]>; has(url:string): Promise<boolean>; };
//   view: { …existing…; setContentInset(viewId:ViewId, inset:ContentInset): Promise<void>; };
```

## 4. Interface ledger (match EXACTLY)
**`electron/main/db/favoritesRepo.ts`** — `class FavoritesRepo { constructor(db); list(): Favorite[] (ORDER BY position, id); add(input:{name,url,tags:string[]}): Favorite[] (position = max+1); update(id, partial): Favorite[]; remove(id): Favorite[]; reorder(ids:number[]): Favorite[] (set position by index); tagUnion(): string[] (distinct sorted across all rows); renameTag(oldT,newT): Favorite[] (replace in every row, transaction); deleteTag(tag): Favorite[] (remove from every row, transaction); }` — tags stored as JSON, parsed with `[]` fallback.
**`electron/main/db/historyRepo.ts`** — `class HistoryRepo { constructor(db); record(input:{url,title}): void (dedup: if most-recent row.url===url → UPDATE its visitedAt=now (and title if non-empty); else INSERT visitedAt=now; then trim to newest 500); setMostRecentTitle(url,title): void (update the most-recent row's title iff its url===url and title non-empty); list(opts?:{limit?,offset?}): HistoryEntry[] (ORDER BY visitedAt DESC; default limit 200); search(q): HistoryEntry[] (url/title LIKE, DESC); remove(id): void; clear(): void; mostRecent(): HistoryEntry|undefined; }` — `record`/`setMostRecentTitle` take an injectable `now: () => number` (default `Date.now`) for testable timestamps.
**`electron/main/db/savedRepo.ts`** — `class SavedRepo { constructor(db); list(): SavedItem[] (ORDER BY savedAt DESC); add(input:{url,title}): SavedItem[] (INSERT savedAt=now; injectable now); remove(id): SavedItem[]; has(url): boolean; }`.
**`electron/main/historyRecorder.ts`** — `class HistoryRecorder { constructor(opts:{ wc: Pick<WebContents,'on'|'getTitle'|'getURL'>; repo: HistoryRepo; onChanged:()=>void; isRecordable?:(url:string)=>boolean }); }` wires `wc.on('did-navigate', (_e,url)=>this.onNav(url))`, `wc.on('did-navigate-in-page',(_e,url,isMainFrame)=>{ if(isMainFrame) this.onNav(url); })`, `wc.on('page-title-updated',(_e,title)=>{ if(this.lastUrl) { repo.setMostRecentTitle(this.lastUrl,title); onChanged(); } })`. `onNav(url)`: if `!isRecordable(url)` return; `this.lastUrl=url`; `repo.record({url, title: wc.getTitle()})`; `onChanged()`. Default `isRecordable = (u)=> u.startsWith('http://')||u.startsWith('https://')` (excludes about:blank + app/file urls). Type-only `WebContents` import (node-testable with a fake wc).
**`electron/main/ipc/{favorites,history,saved}.ts`** — `buildFavoritesHandlers(repo): Record<…>` (keys = the favorites.* IPC channels → repo methods, returning the updated list/union); `buildHistoryHandlers(repo): Record<…>` (history.list/search/remove/clear); `buildSavedHandlers(repo): Record<…>`. `electron/main/ipc/viewLayout.ts` — `buildViewLayoutHandlers(setContentInset)` (see §2).
**`electron/main/ipc/nav.ts`** — extend `buildViewEventForwarders` to also return `onHistoryChanged: () => chromeWc.send(IPC.evtHistoryChanged)` (no payload) — OR add a sibling forwarder; the recorder's `onChanged` is wired to it in boot.
**Renderer hooks** (`src/hooks/`): `useFavorites(currentUrl)` → `{ favorites, tagUnion, activeTags, setActiveTags, add, update, remove, reorder, renameTag, deleteTag }` (seeds via list/tagUnion; filters by activeTags); `useHistory()` → `{ entries, query, setQuery, search, remove, clear }` (seeds via list; re-fetches on `onChanged`); `useSaved(currentUrl)` → `{ items, isCurrentSaved, addCurrent, add, remove }` (tracks `has(currentUrl)` on url change); `useContentInset(viewId, {favBarVisible, sidebarOpen})` → effect calling `view.setContentInset`.
**Renderer components** (`src/components/`): `FavoritesBar`, `TagFilter`, `FavoritesManager` (modal, `useDialog`), `TagInput` (autocomplete), `HistoryPanel`, `SavedPanel`, `Sidebar` (toggle + History/Saved tabs), `BookmarkButton`. Per-spec-local test helpers; follow existing component patterns + a11y (button names, aria-live, focus-trap).

## 5. Conventions
- TDD, bite-sized steps, one commit/task (`feat(favorites|history|saved|sidebar): …` / `test(...)`). Branch `phase-3`. **LOCAL commits only — no push/remote/branch-rename.**
- Unit/component: `npx vitest run <file>` (DB repos need Node ABI → `npm run rebuild:node && npx vitest run <file>`). e2e: `npm run build && npx playwright test <file>`. Gate: `npm test` + `npm run test:e2e`.
- DB repos node-testable with `openDb(':memory:')` + `runMigrations`. `historyRecorder` node-testable with a fake wc (object capturing `.on` handlers) + a real in-memory `HistoryRepo` (or fake). Hooks/components under `jsdom` with a mocked `aegis`/ipcClient. Injectable `now()` for timestamp determinism. Inset/sidebar/persistence behavior asserted in e2e.
- Migrations ADDITIVE (`CREATE TABLE IF NOT EXISTS`); no versioned runner. History dedup vs most-recent + trim to 500. Record only http(s) urls. No drag-reorder UI beyond minimal (position column provided).
- App.test.tsx + Toolbar.test.tsx mocks MUST gain the new `favorites`/`history`/`saved` namespaces + `view.setContentInset` if `App`/`Toolbar` call them at mount (unconditional edit, like Phase-1 §8.8).

## 6. Task skeleton (~26 tasks, 5 blocks; drafters expand)
**Block A — types + persistence (Node ABI)**
1. `shared/types.ts` additions (§3) + `shared/types.test.ts`.
2. `favoritesRepo.ts` + `favorites` table + tests (CRUD, reorder, tagUnion, renameTag/deleteTag across rows).
3. `historyRepo.ts` + `history` table + tests (record dedup-most-recent, trim-to-500, search, remove, clear, setMostRecentTitle; injectable now).
4. `savedRepo.ts` + `saved_list` table + tests (add/remove/has/list).

**Block B — main wiring (recorder + IPC + inset layout)**
5. `historyRecorder.ts` + tests (did-navigate/in-page/title → repo; dedup via repo; skips non-http(s); fake wc).
6. `ipc/favorites.ts` `buildFavoritesHandlers` + tests.
7. `ipc/history.ts` `buildHistoryHandlers` + tests.
8. `ipc/saved.ts` `buildSavedHandlers` + tests.
9. `window.ts` inset-driven `layout` + `ipc/viewLayout.ts` `buildViewLayoutHandlers` + tests; update existing `window.test.ts`/`viewController` callers as needed.
10. Boot wiring in `index.ts` (construct 3 repos + recorder + register all new handlers + `onHistoryChanged` forwarder + `setContentInset`/inset state + resize) — `npm run build` verifies; runtime by Block E e2e.
11. `chromePreload.ts` additions (favorites/history/saved + view.setContentInset + onHistoryChanged) + preload test; extend `ipcClient.ts` if it re-types `aegis`.

**Block C — renderer hooks + favorites UI**
12. `useFavorites` hook + test.
13. `useSaved` hook + test.
14. `useContentInset` hook + test.
15. `FavoritesBar` + `TagFilter` + tests.
16. `FavoritesManager` (modal) + `TagInput` (autocomplete) + tests.
17. `BookmarkButton` + tests.

**Block D — renderer history/saved/sidebar + app wiring**
18. `useHistory` hook + test.
19. `HistoryPanel` + tests.
20. `SavedPanel` + tests.
21. `Sidebar` (toggle + History/Saved tabs) + tests.
22. `App.tsx` wiring (mount favorites bar + sidebar + bookmark button; `useContentInset`; favBar/sidebar toggle state) + `App.test.tsx` mock additions + `Toolbar` bookmark-button slot + tests.

**Block E — e2e + regression gate**
23. e2e `favorites.spec.ts` (add via manager → bar chip → navigate; tag filter).
24. e2e `history.spec.ts` (real nav auto-records; search; revisit; remove; clear).
25. e2e `saved.spec.ts` (bookmark fills-in after add; toggle remove; saved panel).
26. e2e `sidebar.spec.ts` (toggle insets the content view — content bounds shrink by SIDEBAR_W, restore on close) + `persistence.spec.ts` (add favorite + saved item, relaunch same AEGIS_USER_DATA, assert persisted) — the Phase-3 exit; then run the FULL gate (`npm test` + `npm run test:e2e`) green.

## 7. Known decisions folded in (don't re-litigate)
- Inset sidebar via `view.setContentInset` (renderer computes from constants; main repositions content; default top=56,left=0).
- History recording main-side on did-navigate(+in-page); dedup vs most-recent; trim 500; title via page-title-updated→setMostRecentTitle; record only http(s).
- Tags denormalized JSON on the favorite; global rename/delete iterate rows in a transaction.
- Additive migrations (no versioned runner). Bookmark button fill-in via `saved.has(currentUrl)`.
- No drag-reorder UI beyond a minimal/optional control; `position` column + `reorder(ids)` provided.

---

## 8. Review-driven corrections (AUTHORITATIVE — override §1–§7 wherever they conflict)
A first draft was adversarially reviewed; these corrections are mandatory.

**8.1 — Task 10 MUST extend the `__aegisTest` registry with `places` (Block-E e2e depend on it).** In `index.ts`, inside the existing `if (process.env.AEGIS_E2E === '1')` block, add a `places` key to the `__aegisTest` object. EXACT shape (Block-E e2e Tasks 23–26 use exactly these names):
```ts
(globalThis as any).__aegisTest = {
  primary: vc,
  chromeWcId: chromeWc.id,
  adblock: { /* …existing… */ },
  places: { favoritesRepo, historyRepo, savedRepo, setContentInset },
};
```
`favoritesRepo`/`historyRepo`/`savedRepo` are the constructed repo instances; `setContentInset` is the `(top:number,left:number)=>void` closure from §2. Block-E specs drive Phase-3 features and assert content bounds via `app.evaluate(() => (globalThis as any).__aegisTest.places.*)`.

**8.2 — HistoryRepo `now` is PER-METHOD; the recorder test uses a FAKE repo (no real timestamps).** Lock one model:
- `HistoryRepo.record(input: {url:string; title:string}, now: () => number = Date.now): void` and `setMostRecentTitle(url: string, title: string, now: () => number = Date.now): void`. NO constructor-injected clock (`constructor(db)` only). Task 3's tests pass `() => 1000` etc. as the per-call arg.
- `HistoryRecorder` calls `repo.record({url, title})` / `repo.setMostRecentTitle(url, title)` (production uses the default `Date.now`). Task 5's recorder test uses a **FAKE repo** (an object with `record`/`setMostRecentTitle`/`mostRecent` spies) + a fake wc, and asserts the recorder WIRES the events correctly (did-navigate → `record({url,title})`; did-navigate-in-page main-frame → `record`; page-title-updated → `setMostRecentTitle`; non-http(s) urls skipped; `onChanged` fired). It does NOT assert timestamps or dedup/trim (those are HistoryRepo's concern, covered in Task 3). Do NOT construct `new HistoryRepo(db, () => now)`.

**8.3 — Component prop contracts are PINNED; Task 22's App wiring MUST match them exactly (fixes the type errors + the missing unsave path).**
- `BookmarkButtonProps = { saved: boolean; canSave: boolean; onSave: () => void; onUnsave: () => void }` (Task 17). App: `<BookmarkButton saved={saved.isCurrentSaved} canSave={hostOf(nav.state.url) !== null} onSave={() => void saved.addCurrent(nav.state.title)} onUnsave={() => void saved.removeCurrent()} />`.
- `useSaved(currentUrl)` (Task 13) returns `{ items, isCurrentSaved, add(input), addCurrent(title: string), removeCurrent(), remove(id) }` — **add `removeCurrent()`** (finds the SavedItem whose url === currentUrl and removes it; the toolbar unsave path — fixes the spec-§11.3 toggle). `addCurrent(title: string)` takes the title (App passes `nav.state.title`).
- `FavoritesBarProps = { favorites, tagUnion, activeTags, setActiveTags, onOpenFavorite: (url:string)=>void, onOpenManager: ()=>void }` (Task 15); FavoritesBar renders `TagFilter` INTERNALLY. App passes all six (favorites/tagUnion/activeTags/setActiveTags from `useFavorites`; `onOpenFavorite={(url)=>void nav.navigate(url)}`, `onOpenManager={()=>setManagerOpen(true)}`) and does NOT render a standalone `<TagFilter>` (no double render).
- `FavoritesManagerProps = { favorites, tagUnion, onClose, add, update, remove, renameTag, deleteTag }` (Task 16) — **NO `reorder` prop**. App must not pass `reorder`.
- Task 22 Step-5 verify is `npx tsc --noEmit` ONLY (delete the bogus `npm run typecheck` fallback — no such script). With the above, it passes.

**8.4 — `src/lib/layout.ts` is created ONCE (Task 14).** It exports `TOOLBAR_H = 56`, `FAVBAR_H = 40`, `SIDEBAR_W = 280`. Task 22 only IMPORTS it — remove `src/lib/layout.ts` from Task 22's Files/Step-1/git-add.

**8.5 — Favorites bar is ALWAYS-ON in Phase 3 (no toggle UI); top inset is constant `TOOLBAR_H + FAVBAR_H`.** `useContentInset(viewId, { sidebarOpen })` computes `top = TOOLBAR_H + FAVBAR_H` (favbar always shown) and `left = sidebarOpen ? SIDEBAR_W : 0` — **drop the `favBarVisible` param**. (A show/hide-favbar toggle is a Phase-4 settings item.) Spec §11 criterion 4 is met as: the favorites-bar height is included in the content top inset, and the sidebar toggles the left inset. **Task 26 `sidebar.spec.ts` asserts: initially the content view's top bound === `TOOLBAR_H + FAVBAR_H` (= 96, favbar contributes); toggling the sidebar changes the content `left` bound by `SIDEBAR_W` and restores on close.** (Reads bounds via `__aegisTest.primary.view.getBounds()` and/or drives `__aegisTest.places.setContentInset`.)

**8.6 — Minor.** Task 2: insert the favorites-migration `it` immediately before the final `});` that closes `describe('runMigrations', …)` (ignore the stale line-99 label). Task 9: `electron/main/window.test.ts` is a CREATE (no such file exists) — correct as drafted.

---

## 9. Second review-driven corrections (Block E e2e — AUTHORITATIVE)
A second review APPROVED Blocks A–D and the §8 fixes, but flagged the Block-E e2e. Apply these:

**9.1 — Block-E e2e MUST drive via `__aegisTest`, NOT the chrome React DOM.** Do NOT use `app.firstWindow()`, `chromeWindow.getByRole(...)`, or `chromeWindow.reload()` in any Phase-3 e2e spec. Playwright `_electron` cannot reliably resolve which page target is the chrome `WebContentsView` (chrome + content are both targets), and NONE of the 12 existing specs drive the chrome DOM — they all drive main via `app.evaluate(()=>(globalThis as any).__aegisTest.…)` and read content via `__aegisTest.primary.view.webContents.executeJavaScript`. Follow that pattern. The chrome-DOM interactions (chip click, bookmark toggle, sidebar tab/toggle, tag-filter chips) are ALREADY covered by the Block-C/D component + hook tests. Concretely:
- **`favorites.spec.ts` (Task 23):** exercise the favorites store end-to-end in the booted app via `__aegisTest.places.favoritesRepo.add({name,url,tags})` / `.list()` / `.tagUnion()` / `.renameTag()` / `.deleteTag()`; assert via the returned arrays. Prove "a favorite navigates" via `__aegisTest.primary.navigate(favUrl)` then assert `__aegisTest.primary.getState().url` (chip→navigate wiring is FavoritesBar-component-tested). NO chrome-DOM, NO firstWindow.
- **`saved.spec.ts` (Task 25):** drive `__aegisTest.places.savedRepo.add({url,title})` / `.has(url)` / `.remove(id)` / `.list()`; assert via returns. Bookmark fill-in is BookmarkButton-component-tested. NO chrome-DOM.
- **`sidebar.spec.ts` (Task 26):** drive `__aegisTest.places.setContentInset(top,left)` and assert the content bounds via `__aegisTest.primary.view.getBounds()` (VERIFIED to exist in Electron 42 — `View.getBounds(): Rectangle`, the base class of WebContentsView). Assert: initial `getBounds().y === TOOLBAR_H + FAVBAR_H` (=96, favbar always-on); after `setContentInset(96, 280)` → `getBounds().x === 280` and width shrinks by 280; after `setContentInset(96, 0)` → `x === 0`/restored. Sidebar-toggle→setContentInset + tab switching are Sidebar/useContentInset-tested. NO chrome-DOM.

**9.2 — Same-URL revisit/dedup must gate on a POSITIVE re-navigation signal.** In `history.spec.ts` (Task 24) the dedup case (revisit a URL the view is already on) and any same-URL reload must NOT rely on `navigateAndSettle`'s url+isLoading poll (which resolves instantly when already on the URL → racy). Instead poll `__aegisTest.places.historyRepo.mostRecent()` / list length for the expected change (e.g. wait until the most-recent `visitedAt` advances or the A-count reaches the expected value) before asserting. History auto-recording itself is driven by a REAL nav (`__aegisTest.primary.navigate(url)`) against the fixture server.

**9.3 — `persistence.spec.ts` (Task 26):** seed a favorite + a saved item via `__aegisTest.places.{favoritesRepo,savedRepo}.add(...)` in app1; `await app1.close()`; launch app2 with the SAME `AEGIS_USER_DATA` dir; assert via `__aegisTest.places.{favoritesRepo.list(),savedRepo.list()}` they persisted. (better-sqlite3 writes are synchronous + WAL-durable; the `await app1.close()` before app2 launch ensures the first process released the DB.)

**9.4 — Minor (contract consistency):** §4's `useSaved` ledger line should read `{ items, isCurrentSaved, add, addCurrent(title:string), removeCurrent(), remove(id) }` — `removeCurrent()` per §8.3 is authoritative (the §4 line omitting it is stale; the draft correctly includes it).
