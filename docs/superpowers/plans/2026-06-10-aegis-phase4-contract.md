# Aegis Phase 4 — Plan Contract (source-verified)

**AUTHORITATIVE** integration facts, mechanisms, interface ledger, conventions, and task skeleton for the
Phase-4 implementation plan. Every fact below was read from the actual code / installed packages (file:line).
Drafters: use ONLY the names/signatures here for anything cross-module. Spec:
`docs/superpowers/specs/2026-06-10-aegis-phase4-design.md`.

---

## §1 As-built facts (VERIFIED — do not re-guess)

### 1.1 Settings (data + IPC already exist; UI is the gap)
- `shared/types.ts:119-132`:
  ```ts
  export interface SearchEngine { id: string; name: string; template: string; } // template contains %s
  export interface Settings {
    siteName: string; homeUrl: string; primaryColor: string;
    defaultSearchTemplate: string; searchEngines: SearchEngine[]; hideChromeByDefault: boolean;
  }
  ```
- `SettingsRepo.get(): Settings` (merges `{ ...DEFAULT_SETTINGS, ...stored }`), `set(partial: Partial<Settings>): Settings`
  (writes each key as a JSON row in a txn, then `return this.get()`). `DEFAULT_SETTINGS` seeds 3 engines
  (`ddg`/`google`/`bing`), `primaryColor '#7c5cff'`, `homeUrl 'https://duckduckgo.com/'`.
- IPC already wired: `IPC.settingsGet='settings.get'`, `IPC.settingsSet='settings.set'`;
  `buildSettingsHandlers(settingsRepo)`; preload `aegis.settings.get()/set(partial)`; `AegisApi.settings` typed.
- `applyTheme(s: Pick<Settings,'primaryColor'>): void` sets `--accent-color` on `document.documentElement`
  (`src/lib/theme.ts:4-6`); called ONCE at mount (`src/App.tsx:52-54`). **A Settings edit of `primaryColor`
  must re-call `applyTheme`** (the shared `useSettings` hook does this).
- **`defaultSearchTemplate` IS consumed** by `useNav` (`useNav.ts:36-38` loads it into `searchTemplate`,
  fed to `addressParse`). **`searchEngines` is NOT consumed** anywhere.
- **`homeUrl` IS ALREADY functional** (spec §4.3 corrected): the main-side home handler
  `[IPC.navHome]: (_viewId) => vc.navigate(settingsRepo.get().homeUrl)` (`electron/main/ipc/nav.ts:21`) reads
  it live; boot also reads it (`index.ts:236`, after `AEGIS_HOME_URL` env + restored-session precedence). So the
  **Home tab only needs an editor** — NO consumer wiring. (e2e proves it by editing `homeUrl` then `nav.home`.)
- **`siteName` is NOT consumed** (no `document.title` anywhere in non-test src). Making it functional = a renderer
  effect `document.title = settings.siteName`.

### 1.2 Filter subscriptions + list refresh (the wiring gap)
- `electron/main/db/subsRepo.ts:4-11`: `Subscription { listId: string; url: string; enabled: boolean;
  lastUpdated: number|null; etag: string|null; hash: string|null; }`.
- `SubsRepo` TODAY has ONLY: `seedDefaults(defaults: {listId,url}[])`, `all(): Subscription[]`
  (maps `enabled === 1`), `updateMeta(listId, {lastUpdated, etag, hash})`. **No setEnabled / add / remove.**
- `filter_subscriptions` table: `listId TEXT PK, url TEXT NOT NULL, enabled INTEGER NOT NULL DEFAULT 1,
  lastUpdated INTEGER, etag TEXT, hash TEXT` (`sqlite.ts:34-41`). `enabled` is read by `all()` but only ever
  WRITTEN as `1` by `INSERT OR IGNORE` — no code reads it to decide refresh.
- **`runRefresh()` (`index.ts:178-201`) sources URLs from the hardcoded `DEFAULT_LIST_URLS` constant**
  (`refreshSubs`, `index.ts:172-176`), NOT from `subsRepo.all()`. It calls `fetchAll(refreshSubs, …)` →
  `usable = sources.filter(s.ok && s.text.length>0)` → `buildEngine(usable.map(s=>s.text), resources)` →
  `controller.setPendingBlocker(engine)` + `serializeEngine(engine, cachePath)` + `subsRepo.updateMeta(...)` per source.
- `DEFAULT_LIST_URLS = adsAndTrackingLists.map(url => ({ listId: listIdFromUrl(url), url }))`
  (`engine.ts:28-30`). e2e override: `LIST_BASE` rewrites each to `${LIST_BASE}/${listId}.txt`
  (`index.ts:173-175`); `RESOURCES_URL`/`${LIST_BASE}/resources.json` for scriptlet resources.
- `fetchAll(subs, {cacheDir,timeoutMs,maxBytes,resourcesUrl,fetchImpl})` (`listManager.ts:96-152`): per-sub
  `fetchSource` → `writeFileAtomic(cacheDir/<listId>.txt, text)`; on error falls back to the cached file
  (`readFileSafe`). Returns `{ sources: FetchedSource[], resources: string|null }`.
- HTTPS guard (`listManager.ts:28-37`, `fetchSource`): rejects non-`https:` unless `http:` + loopback host
  (`127.0.0.1`/`localhost`/`::1`/`[::1]`). **Reuse this for add-custom-URL validation.**
- Engine rebuild (`engine.ts:40-47`):
  ```ts
  export function buildEngine(listTexts: string[], resources: string | null): ElectronBlocker {
    const engine = ElectronBlocker.parse(listTexts.join('\n'));
    if (resources !== null) { const checksum = sha1hex(resources); engine.updateResources(resources, checksum); }
    return engine;
  }
  ```
  The rebuilt engine swaps in on the NEXT main-frame nav via `controller.swapPendingIfAny()`
  (`controller.ts`, wired on `did-start-navigation`).

### 1.3 My-filters merge mechanism (VERIFIED against @ghostery 2.18.0)
- `ElectronBlocker.parse(filters: string, options?: Partial<Config>)` parses ONE text blob; `parseFilters`
  splits on `\n` and classifies EACH line independently (network → `NetworkFilter.parse`, cosmetic →
  `CosmeticFilter.parse`, scriptlet via resources). Default `Config` loads network + cosmetic + scriptlet.
- **DEFINITIVE:** user network + cosmetic + scriptlet rules merge by **concatenation** — pass the user's
  custom-filter text as one more element to `buildEngine`:
  `buildEngine([...enabledListTexts, customFiltersText], resources)`. **No special cosmetic handling** (Phase-2
  verified cosmetic/scriptlet injection works via this exact path). Caveats to design around (not code):
  generic bare `##.ad` rules depend on `loadGenericCosmeticsFilters` default (domain-scoped `x.com##.ad`
  unaffected); scriptlet user rules need `resources` loaded (buildEngine already handles); the rebuilt engine
  applies on the next navigation (so a my-filters save takes effect on reload/next-nav).

### 1.4 Adblock controls + allowlist reconcile (for remove/clear)
- `AdblockController` (`controller.ts`): `setEnabled(enabled): AdblockState`, `toggleAllowlist(host): AdblockState`,
  `getState(): AdblockState`, `isBlockingActive(): boolean`, `primeFor(url)`, `setPendingBlocker(b)`,
  `swapPendingIfAny()`, `snapshotCount()`. `toggleAllowlist`/`setEnabled` delegate to the repo then
  `return this.getState()` — **DB-only; they do NOT reconcile the live session.**
- Re-application is deferred to `reconcile(url)` on every main-frame `did-start-navigation`
  (`controller.ts:36-41,94-104`): `shouldBlock = enabled && !repo.isAllowlisted(hostOf(url))` → enables/disables
  blocking in the session. **So removing a host from the allowlist → next nav to it re-enables blocking. No extra
  wiring needed beyond the DB mutation.** `hostOf('')`→`''`, never allowlisted.
- `AdblockRepo` (`adblockRepo.ts`): `getState(): {enabled, allowlistedHosts}`, `setEnabled(enabled): void`,
  `isAllowlisted(host): boolean`, `toggleAllowlist(host): string[]` (returns the new array). Allowlist persisted
  as a JSON `string[]` in `adblock_config.allowlist` (singleton id=1, default `'[]'`).
- IPC: `IPC.adblockSetEnabled/adblockToggleAllowlist/adblockGetState` (return `AdblockState`); preload
  `aegis.adblock.setEnabled/toggleAllowlist/getState/onBlockedCount`; `useAdblock` returns
  `{ state, page, setEnabled, toggleAllowlist (no-arg, derives current host), updateNow }`. `AdblockShield`
  calls the no-arg `toggleAllowlist()`.

### 1.5 IPC recipe + UI patterns + migrations + ABI
- `registerGuardedHandlers(chromeWc.id, { ...buildXHandlers(...) })` (`index.ts:203-212`); guard validates
  `event.sender.id === chromeWebContentsId`, strips the event, calls `handler(...args)` (`ipc/guard.ts`).
- `buildXHandlers(repo): Record<string,(...a:any[])=>any>` returning `[IPC.channel]: (args…) => repo.method(args…)`
  (example: `ipc/favorites.ts`). Preload: thin `ipcRenderer.invoke(IPC.channel, …args)` wrappers in a namespace;
  push events via `subscribe<T>(channel, cb): () => void` (`chromePreload.ts:11-15`) + a main-side
  `chromeWc.send(IPC.evt…, payload)` forwarder (`buildViewEventForwarders`, `nav.ts:33-44`; `fwd` built at
  `index.ts:80`).
- `useDialog<T extends HTMLElement>(onClose: () => void): RefObject<T|null>` — first-focus, Tab/Shift+Tab focus
  trap, Escape→onClose, focus restore on unmount. (`FavoritesManager` is the reference consumer.)
- Toolbar slot: `ToolbarProps.bookmark?: ReactNode` rendered last (`Toolbar.tsx:55`); add `gear?: ReactNode` the
  same way. App modal mount: `const [managerOpen,setManagerOpen]=useState(false)` + `{managerOpen && <…/>}`
  (`App.tsx:46,154-165`). Mirror with `settingsOpen` + `{settingsOpen && <SettingsModal/>}`.
- Tablist a11y (`Sidebar.tsx`): `useState<Tab>` + per-tab `useId()` pairs; `role="tablist"` →
  `role="tab"` (`id`, `aria-controls`, `aria-selected`, onClick setTab) → `role="tabpanel"` (`id`,
  `aria-labelledby`). Reuse for Settings tabs.
- Migrations: ONE idempotent `db.exec(\`CREATE TABLE IF NOT EXISTS …\`)` block in `runMigrations`
  (`sqlite.ts:20-65`). Append a new `custom_filters` table additively (no versioned runner; that follow-up
  remains deferred).
- ABI: DB unit tests → `npm run rebuild:node && npx vitest run <file>` (Node ABI). Pure renderer/logic tests →
  `npx vitest run <file>` (jsdom/node, no rebuild). e2e → Electron ABI + build: `npm run rebuild:electron &&
  npm run build` then `npx playwright test <file>`. Full gate: `npm test` (rebuild:node + all unit) then
  `npm run build && npm run test:e2e` (rebuild:electron + all e2e). LOCAL commits only on branch `phase-4`
  (NEVER push/remote/branch-rename).

---

## §2 Phase-4 mechanisms (how the new pieces work)

### 2.1 Two engine-rebuild paths
- **`runRefresh()` (fetch-rebuild)** — rewrite so it sources enabled rows from `subsRepo.all()` (not the
  constant) and folds in custom filters:
  - URL list = `subsRepo.all().filter(s => s.enabled)` mapped to `{listId, url}`; apply the `LIST_BASE`
    per-row override (rewrite each `url` to `${LIST_BASE}/${listId}.txt`) when `LIST_BASE` is set (e2e).
  - texts for the engine = `[...usable.map(s=>s.text), customFiltersRepo.get()]` (append custom filters).
  - Extract the URL-resolution + the texts-assembly into **pure helpers** for unit-testability (see §4):
    `resolveRefreshSubs(rows, listBase)` and the texts list. Keep the fetch/serialize/setPendingBlocker shell.
  - Used by: `lists.updateNow`, the 24h scheduler, the boot kick, AND `subs.add` (a new list must be fetched).
- **`rebuildEngineFromCache()` (cache-rebuild, NO network)** — new helper: read cached text for each enabled sub
  (`readFileSafe(listsCacheDir/<listId>.txt)`, skip empties), append `customFiltersRepo.get()`, `buildEngine(...)`,
  `controller.setPendingBlocker(engine)`, `serializeEngine(...)`. Used by: `subs.setEnabled`, `subs.remove`,
  `customFilters.set` (these don't need re-fetch — toggling/removing/editing rules rebuilds from cache).
  - Caveat (documented, acceptable): on a fresh profile with no caches yet, cache-rebuild yields an engine with
    only whatever cache exists + custom filters; the bundled seed engine remains active until a successful
    `runRefresh`. e2e exercises this AFTER an `updateNow` against the `LIST_BASE` fixture so caches exist.

### 2.2 My-filters store
- New `custom_filters` table (singleton, like `adblock_config`): `id INTEGER PRIMARY KEY CHECK (id=1),
  text TEXT NOT NULL DEFAULT ''` + `INSERT OR IGNORE … (1, '')`. `CustomFiltersRepo.get(): string` /
  `set(text: string): void`. `customFilters.set` persists then `rebuildEngineFromCache()`.
- The My-Filters tab reports a simple **non-empty, non-`!comment` line count** as "rules" (client-computed).
  We do NOT promise engine-verified parsed-vs-ignored counts (no such API surfaced); the engine silently
  tolerates malformed lines. (Spec §4.5/§8 "parsed/ignored" → this line count.)

### 2.3 Allowlist remove/clear (deferred-reconcile, consistent with toggle)
- `AdblockRepo.removeAllowlist(host): string[]` (unconditional remove half of toggle) /
  `clearAllowlist(): string[]` (write `'[]'`). `AdblockController.removeAllowlist(host): AdblockState` /
  `clearAllowlist(): AdblockState` = delegate to repo, `return this.getState()` — **do NOT reconcile directly**
  (re-blocking happens on the next nav via the existing `reconcile`, matching "Applies on reload").

### 2.4 Settings modal
- `SettingsModal({ onClose, … })` uses `useDialog<HTMLDivElement>(onClose)`; `role="dialog" aria-modal="true"`
  labelled "Settings"; internal tablist with tabs **Appearance / Search / Home / Filter Lists / My Filters /
  Allowlist** (the Sidebar tablist pattern). Opened from a new Toolbar **gear** slot (`gear?: ReactNode`) +
  `settingsOpen` state in App. `AdblockShield` is unchanged.

---

## §3 shared/types additions (the ONLY new cross-module types/channels)

New `IPC` channel constants (string values namespaced like existing):
- Subscriptions: `subsList:'subs.list'`, `subsSetEnabled:'subs.setEnabled'`, `subsAdd:'subs.add'`,
  `subsRemove:'subs.remove'`.
- Custom filters: `customFiltersGet:'customFilters.get'`, `customFiltersSet:'customFilters.set'`.
- Allowlist: `adblockRemoveAllowlist:'adblock.removeAllowlist'`, `adblockClearAllowlist:'adblock.clearAllowlist'`.

New `AegisApi` members:
- `subs: { list(): Promise<Subscription[]>; setEnabled(listId: string, enabled: boolean): Promise<Subscription[]>;
  add(url: string): Promise<Subscription[]>; remove(listId: string): Promise<Subscription[]>; }`
- `customFilters: { get(): Promise<string>; set(text: string): Promise<string>; }` (set returns the stored text)
- `adblock` gains: `removeAllowlist(host: string): Promise<AdblockState>; clearAllowlist(): Promise<AdblockState>;`

`Subscription` already exists in `subsRepo.ts` — **re-export it from `shared/types.ts`** (or import its type into
shared) so the renderer/preload can type `subs.*`. No other new data types (custom filters = `string`).

---

## §4 Interface ledger (exact signatures — use verbatim)

**`electron/main/db/subsRepo.ts`** (add to existing class):
- `setEnabled(listId: string, enabled: boolean): void` (UPDATE … SET enabled=@e WHERE listId=@id)
- `add(url: string): Subscription[]` — derive `listId = listIdFromUrl(url)` (import/relocate from engine.ts),
  `INSERT OR IGNORE (listId,url,enabled=1)`; return `this.all()`. (URL HTTPS-validation happens in the IPC layer
  via the listManager guard, OR document that add stores any URL and refresh enforces the guard — see §6 T6.)
- `remove(listId: string): Subscription[]` — `DELETE WHERE listId=@id`; return `this.all()`.
- (Note: `setEnabled`/`remove` may return `void` or `Subscription[]`; the IPC builder returns `this.all()` either
  way. Prefer returning `void` from the repo mutators and `subsRepo.all()` from the handler, matching the
  HistoryRepo/SavedRepo split where the handler decides the returned shape — drafters: be consistent within the file.)

**`electron/main/db/customFiltersRepo.ts`** (new): `class CustomFiltersRepo { constructor(db); get(): string;
  set(text: string): void; }` + the `custom_filters` singleton table in `runMigrations`.

**`electron/main/db/adblockRepo.ts`** (add): `removeAllowlist(host: string): string[]`,
  `clearAllowlist(): string[]` (both via `setAllowlistStmt`).
**`electron/main/adblock/controller.ts`** (add): `removeAllowlist(host: string): AdblockState`,
  `clearAllowlist(): AdblockState` (delegate to repo, return `getState()`).

**`electron/main/ipc/subs.ts`** (new): `buildSubsHandlers(subsRepo, opts: { rebuildFromCache(): void;
  refresh(): Promise<unknown>; }): Record<string,(...a)=>any>` — `subsList→subsRepo.all()`;
  `subsSetEnabled→subsRepo.setEnabled(id,en); opts.rebuildFromCache(); return subsRepo.all()`;
  `subsAdd→subsRepo.add(url); void opts.refresh(); return subsRepo.all()`;
  `subsRemove→subsRepo.remove(id); opts.rebuildFromCache(); return subsRepo.all()`.
**`electron/main/ipc/customFilters.ts`** (new): `buildCustomFiltersHandlers(repo, opts: { rebuildFromCache():
  void }): …` — `customFiltersGet→repo.get()`; `customFiltersSet→repo.set(text); opts.rebuildFromCache();
  return repo.get()`.
**`electron/main/ipc/adblock.ts`** (extend `buildAdblockHandlers`): add
  `adblockRemoveAllowlist→c.removeAllowlist(host)`, `adblockClearAllowlist→c.clearAllowlist()` (return AdblockState).

**`electron/main/index.ts`** (boot): construct `customFiltersRepo`; define `rebuildEngineFromCache()` (§2.1);
  rewrite `runRefresh` per §2.1; merge `...buildSubsHandlers(subsRepo,{rebuildFromCache,refresh:updateNow})`,
  `...buildCustomFiltersHandlers(customFiltersRepo,{rebuildFromCache})` into `registerGuardedHandlers`; expose
  `subsRepo, customFiltersRepo` (and `rebuildFromCache`/`updateNow` already there) under the
  `AEGIS_E2E==='1'` `__aegisTest` registry (add a `phase4`/extend existing) for e2e.

**`electron/preload/chromePreload.ts`** (add namespaces): `subs.{list,setEnabled,add,remove}`,
  `customFilters.{get,set}`, and `adblock.{removeAllowlist,clearAllowlist}` — thin `invoke` wrappers.

**Renderer hooks (`src/hooks/`)**:
- `useSettings(): { settings: Settings; update(partial: Partial<Settings>): Promise<void> }` — loads on mount,
  `update` calls `aegis.settings.set` + `applyTheme` (when primaryColor present) + sets `document.title` from
  `siteName`. (Shared; App may also use it for the title effect.)
- `useSubscriptions(): { subs: Subscription[]; setEnabled(id,en): Promise<void>; add(url): Promise<void>;
  remove(id): Promise<void>; updateNow(): Promise<ListUpdateResult>; }` (updateNow reuses `aegis.lists.updateNow`).
- `useCustomFilters(): { text: string; save(text: string): Promise<void> }`.
- extend `useAdblock` return with `removeAllowlist(host: string): void`, `clearAllowlist(): void` (each calls the
  IPC then `setState` from the returned `AdblockState`).

**Renderer components (`src/components/`)**: `SettingsModal` + tabs `AppearanceTab`, `SearchTab`, `HomeTab`,
  `FilterListsTab`, `MyFiltersTab`, `AllowlistTab`; a gear button passed into `Toolbar`'s new `gear` slot.

---

## §5 Conventions (follow exactly)
- TDD: failing test → minimal impl → green → commit, one commit per task. COMPLETE runnable code in every step;
  no placeholders/"…"/"similar to Task N".
- Repos: constructor(db) + prepared statements (like `SubsRepo`/`AdblockRepo`); additive `CREATE TABLE IF NOT
  EXISTS` only.
- IPC builders: `Record<string,(...a:any[])=>any>`, args WITHOUT the event; merged into the single
  `registerGuardedHandlers` call.
- Preload: `invoke` wrappers in a namespace on the `aegis` object; `AegisApi` typed in shared/types.
- Renderer: hooks mock `../lib/ipcClient`; components use Testing Library + `userEvent`; modal uses `useDialog`;
  tabs use the tablist a11y pattern.
- Engine: rebuilds go through `buildEngine` + `controller.setPendingBlocker` + `serializeEngine`; never construct
  the engine ad-hoc; the swap is deferred to next-nav (tests/e2e must navigate to apply).
- Test commands per §1.5 (dual-ABI). Branch `phase-4`, LOCAL commits only.
- Each task ends with a single "New names introduced" list.

---

## §6 Task skeleton (blocks → tasks; drafters expand each into full TDD steps)

**Block A — data layer (Node-ABI DB tests)**
- T1: `shared/types.ts` — new IPC channels (subs.*, customFilters.*, adblock.removeAllowlist/clearAllowlist),
  `AegisApi` additions (`subs`, `customFilters`, adblock extensions), re-export `Subscription`. + type test.
- T2: `SubsRepo.setEnabled/add/remove` (+ relocate/export `listIdFromUrl`) + tests.
- T3: `CustomFiltersRepo` + `custom_filters` migration + tests.
- T4: `AdblockRepo.removeAllowlist/clearAllowlist` + `AdblockController.removeAllowlist/clearAllowlist` + tests.

**Block B — main wiring (node tests + build)**
- T5: extract pure refresh helpers (`resolveRefreshSubs(rows, listBase)`, the enabled-texts assembly) + unit
  tests; (keep `buildEngine` unchanged — merge is at the call site).
- T6: `electron/main/ipc/subs.ts` `buildSubsHandlers` + tests (fake repo + spy rebuild/refresh). Decide+document
  add-URL HTTPS validation: validate in the handler (reuse the listManager guard predicate) so a bad URL rejects
  before insert.
- T7: `electron/main/ipc/customFilters.ts` `buildCustomFiltersHandlers` + tests.
- T8: extend `buildAdblockHandlers` (removeAllowlist/clearAllowlist) + tests.
- T9: boot wiring in `index.ts` — construct `CustomFiltersRepo`; `rebuildEngineFromCache()`; rewrite `runRefresh`
  (subsRepo.all() enabled + custom filters, LIST_BASE per-row); register new handlers; `__aegisTest` exposure.
  Verify `npm run build` + `tsc --noEmit` shows no `index.ts` error.
- T10: `chromePreload.ts` additions (subs/customFilters/adblock allowlist) + preload test.

**Block C — renderer hooks (jsdom tests)**
- T11: `useSettings` (+ document.title from siteName, re-applyTheme) + tests.
- T12: `useSubscriptions` + tests.
- T13: `useCustomFilters` + tests.
- T14: extend `useAdblock` with removeAllowlist/clearAllowlist + tests (don't regress existing useAdblock tests).

**Block D — Settings UI (jsdom tests) + App wiring**
- T15: `SettingsModal` shell (useDialog + tablist tab-switching) + tests.
- T16: `AppearanceTab` (primaryColor color input + live theme; siteName text) + tests.
- T17: `SearchTab` (searchEngines CRUD by id; set default → writes searchEngines + defaultSearchTemplate) + tests.
- T18: `HomeTab` (homeUrl editor — already-functional consumer) + tests.
- T19: `FilterListsTab` (list + toggle + add-URL + remove + force-update-all) + tests.
- T20: `MyFiltersTab` (textarea + save + line-count) + tests.
- T21: `AllowlistTab` (list hosts + remove + clear-all) + tests.
- T22: App wiring — Toolbar `gear` slot + gear button; `settingsOpen` state; mount `SettingsModal` wired to the
  hooks; siteName→`document.title` effect; re-theme on change. + App.test/Toolbar.test additions. Verify
  `tsc --noEmit` introduces no new PRODUCTION-file error (the known test-file baseline is accepted).

**Block E — e2e + regression gate (Electron ABI)**
- T23: `settings.spec.ts` — settings round-trip + **persistence across relaunch** (accent color + a custom list +
  my-filters survive restart via SAME `AEGIS_USER_DATA`); editing `homeUrl` then `nav.home` navigates there.
  Drive via `__aegisTest` (settingsRepo/subsRepo/customFiltersRepo + `primary`), NO chrome-DOM.
- T24: `filterlists.spec.ts` — after an `updateNow` against the `LIST_BASE` fixture (caches populate), disabling a
  list rebuilds-from-cache without its rules; add/remove a custom list URL reflects in `subsRepo.all()`. Drive via
  `__aegisTest.places`/the phase-4 registry.
- T25: `myfilters.spec.ts` + allowlist — set a custom my-filter (network or cosmetic) via the registry → rebuild →
  navigate to a fixture → assert the rule takes effect (blocked-count or cosmetic-hide, reusing the Phase-2
  cosmetic/blocked-count e2e approach); allowlist removeAllowlist/clearAllowlist reflected in `AdblockState`.
- T26: FULL regression gate (`npm test` then `npm run build && npm run test:e2e`) — all prior + new green. Commit.

(~26 tasks, mirroring Phase 3's granularity. Drafters: expand each into the full TDD template with exact paths +
complete code; pin every cross-module name from §1/§3/§4.)
