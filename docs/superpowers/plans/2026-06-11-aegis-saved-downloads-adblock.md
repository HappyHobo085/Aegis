# Aegis — Saved edit/search + Downloads relocation + Ad-blocking coverage — Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`.
> Branch: `saved-downloads-adblock` (LOCAL commits only — never push/remote/branch-rename).

**Goal (5 user requests):**
1. **Edit a saved item's name/title** (persisted).
2. **Search within the saved list.**
3. **Remove the Downloads tab from the sidebar.**
4. **Make the toolbar download icon open a Downloads page** (a full-window Downloads modal) instead of the sidebar.
5. **Improve ad-blocking** (ads leak through on streaming sites like streamex.sh) — expand the default filter lists.

**Evidence for #5 (already measured):** the current default `adsAndTrackingLists` snapshot blocked only ~4 requests on streamex.sh and let rotating ad domains (`*.cfd`/`*.cyou`, `bp.lagunesgujerat.com`) through. Adding uBlock filters (+ badware/resource-abuse/privacy) + AdGuard Base + Peter Lowe's at runtime eliminated the rotating ad domains and cut streamex's own resource count 112→74. So the fix is expanding the default lists (with the caveat that first-party/in-player/rotating ads on piracy sites can't be fully blocked — uBlock has the same limit).

**Tech:** Electron 42 · React 19 + TS · electron-vite · Vitest 4 · Playwright. Dual-ABI. tsc bar: production files absent from `npx tsc --noEmit 2>&1 | grep -E '^(src|electron|shared)/' | grep -vE '\.test\.'`.

---

## Block A — Saved list: edit title + search

### Task 1: SavedRepo.update + IPC + hook

**Files:** `electron/main/db/savedRepo.ts` (+ test), `shared/types.ts`, `electron/main/ipc/saved.ts` (+ test), `electron/preload/chromePreload.ts`, `src/hooks/useSaved.ts` (+ test if present).

- [ ] **SavedRepo.update:** add `update(id: number, partial: { title: string }): SavedItem[]` — `UPDATE saved SET title=@title WHERE id=@id`, return `this.list()`. (Mirror FavoritesRepo.update style.) Unit test: add → update title → list reflects new title; updating a missing id is a no-op.
- [ ] **IPC:** `shared/types.ts` → `IPC.savedUpdate: 'saved.update'`; `AegisApi.saved.update(id: number, partial: { title: string }): Promise<SavedItem[]>`.
- [ ] **Handler:** `buildSavedHandlers` → add `[IPC.savedUpdate]: (id, partial) => savedRepo.update(id, partial)`. Update saved ipc test.
- [ ] **Preload:** `chromePreload.ts` saved namespace → `update: (id, partial) => ipcRenderer.invoke(IPC.savedUpdate, id, partial)`.
- [ ] **useSaved:** add `update(id: number, title: string): Promise<void>` → `setItems(await aegis.saved.update(id, { title }))`. Add to the returned object + the `UseSaved` interface. Update useSaved test if present.
- [ ] Verify: `npm run rebuild:node && npx vitest run electron/main/db/savedRepo.test.ts electron/main/ipc/saved.test.ts` (+ useSaved test) → paste counts. tsc may transiently flag `useSaved.ts` using `aegis.saved.update` until preload lands — ensure all wired so production tsc is clean at task end.
- [ ] Commit `feat(saved): SavedRepo.update + saved.update IPC + useSaved.update` (+ trailer).

### Task 2: SavedPanel inline edit + search

**Files:** `src/components/SavedPanel.tsx` (+ test), `src/App.tsx`, `src/index.css`.

- [ ] **Props:** extend `SavedPanelProps` with `update(id: number, title: string): void`. App passes `update={(id, title) => void saved.update(id, title)}`.
- [ ] **Search (client-side):** add a search input at the top of the panel (`.saved-panel__search`, like HistoryPanel's). Local `query` state; filter `items` by title OR url (case-insensitive substring). Render the filtered list. When the filtered list is empty but `items` non-empty, show a "No matches" message (distinct from the existing empty state).
- [ ] **Inline edit:** each row gets an edit (`Pencil`) button (lucide) → toggles the row into edit mode: replace the title display with an `<input>` prefilled with the current title; Enter or a Save (`Check`) button calls `update(item.id, newTitle)` and exits edit mode; Esc or blur cancels. Keep the existing Open + Remove (`X`) buttons. Maintain a11y (input has an aria-label like "Edit title"; the edit button has aria-label "Edit title").
- [ ] **CSS:** style `.saved-panel__search` (pill input, like history search) and the edit input/button to match the existing list-row styling.
- [ ] Tests (`SavedPanel.test.tsx`): search filters by title + url; clicking edit shows an input prefilled with the title; submitting calls `update(id, newTitle)`; Esc cancels without calling update; existing open/remove still work. Run `npx vitest run src/components/SavedPanel.test.tsx src/App.test.tsx` → paste counts.
- [ ] Build clean; tsc production clean.
- [ ] Commit `feat(saved): inline title editing + search in the saved panel` (+ trailer).

---

## Block B — Downloads: out of the sidebar, into a Downloads modal

### Task 3: Remove Downloads sidebar tab + Downloads modal opened by the toolbar icon

**Files:** `src/components/Sidebar.tsx` (+ test), new `src/components/DownloadsModal.tsx` (+ test), `src/App.tsx` (+ test), `src/index.css`.

- [ ] **Sidebar:** change `type Tab = 'history' | 'saved'` (drop `'downloads'`); remove the `downloads` prop from `SidebarProps`, the downloads tab/panel from the tab list + panels map + the `order` array + the useId for downloads. Keep History + Saved. Update `Sidebar.test.tsx` (now two tabs, no Downloads tab; remove the downloads prop from the test harness).
- [ ] **DownloadsModal.tsx (new):** a full-window modal (reuse the modal scrim + card pattern from SettingsModal — outer `.downloads-modal__scrim` wrapper + inner `.downloads-modal` card with `role="dialog" aria-modal aria-labelledby`, a header `h2` "Downloads" + a close `X` button using `useDialog(onClose)` for focus-trap/Esc) that renders `<DownloadsPanel ...>` (same props App already passes: downloads, remove, clear, openFile, showInFolder, cancel). Props: `{ onClose, ...DownloadsPanelProps }` (or accept a `downloads` ReactNode — but a typed pass-through of the DownloadsPanel props is cleaner). Make the card sizeable (max-width ~640, max-height 80vh, internal scroll) so it reads as a page.
- [ ] **App:** add `const [downloadsOpen, setDownloadsOpen] = useState(false)`. Change `DownloadsIndicator onOpen` from `() => setSidebarOpen(true)` to `() => setDownloadsOpen(true)`. Remove the `downloads={<DownloadsPanel .../>}` prop from `<Sidebar>`. Render `{downloadsOpen && <DownloadsModal onClose={() => setDownloadsOpen(false)} downloads={downloads.downloads} remove=... clear=... openFile=... showInFolder=... cancel=... />}`. **Add `downloadsOpen` to the `chromeOverlayActive` union** (so the modal paints over content via the chrome z-swap, like Settings).
- [ ] **CSS:** `.downloads-modal__scrim` + `.downloads-modal` (reuse the settings-modal scrim/card values; or share a class). Header/title/close styled like settings.
- [ ] Tests: `DownloadsModal.test.tsx` (renders dialog with the panel + close calls onClose); `App.test.tsx` (clicking the downloads indicator opens the Downloads modal — NOT the sidebar; the sidebar no longer has a Downloads tab; `setChromeOverlay` fires true when downloadsOpen). Update the App `aegis` mock as needed. Run `npx vitest run src/components/Sidebar.test.tsx src/components/DownloadsModal.test.tsx src/App.test.tsx` → paste counts.
- [ ] Build clean; tsc production clean.
- [ ] **Note:** the existing downloads e2e (`electron/test/e2e/downloads.spec.ts`) drives repos directly, not the sidebar UI — confirm it still passes (it should). If any e2e asserted the downloads sidebar tab, update it.
- [ ] Commit `feat(downloads): move downloads from the sidebar into a Downloads modal opened from the toolbar` (+ trailer).

---

## Block C — Ad-blocking coverage

### Task 4: Expand default filter lists + regenerate the bundled seed

**Files:** `electron/main/adblock/engine.ts` (DEFAULT_LIST_URLS), `scripts/generate-seed.mjs`, the seed `electron/main/adblock/seed/engine-seed.bin`, tests asserting the default list set.

- [ ] **engine.ts:** keep `adsAndTrackingLists` and ADD an `EXTRA_LIST_URLS` array of `{ listId, url }` (stable listIds), then `export const DEFAULT_LIST_URLS = [...adsAndTrackingLists.map(...), ...EXTRA_LIST_URLS];`. The extra lists (proven to help on streamex.sh):
  - `ublock-filters` → `https://ublockorigin.github.io/uAssets/filters/filters.txt`
  - `ublock-badware` → `https://ublockorigin.github.io/uAssets/filters/badware.txt`
  - `ublock-resource-abuse` → `https://ublockorigin.github.io/uAssets/filters/resource-abuse.txt`
  - `ublock-privacy` → `https://ublockorigin.github.io/uAssets/filters/privacy.txt`
  - `adguard-base` → `https://filters.adtidy.org/extension/ublock/filters/2.txt`
  - `peter-lowe` → `https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext`
  (Export `EXTRA_LIST_URLS` so generate-seed can import the SAME source of truth.)
- [ ] **generate-seed.mjs:** build the seed from the FULL URL set, not just `adsAndTrackingLists`. Since it's a .mjs and engine.ts is TS, define the extra URLs as a shared plain-JS/JSON module imported by BOTH (e.g. `electron/main/adblock/extraLists.mjs` exporting the `{listId,url}[]`, imported by generate-seed.mjs directly and by engine.ts via a JSON/ESM import) — OR, if importing TS into the mjs is impractical, keep the extra-URL list in the shared `.mjs`/`.json` and have engine.ts import it. The seed must be built from `adsAndTrackingLists` URLs + the extra URLs. Use `ElectronBlocker.fromLists(fetch, [...adsAndTrackingLists, ...extraUrls])`.
- [ ] **Regenerate the seed:** `npm run generate-seed` (needs network — confirmed reachable). It fetches all lists + `$redirect` resources, serializes `electron/main/adblock/seed/engine-seed.bin`. Confirm the file regenerated (size grows). Paste the script's success output.
- [ ] **Tests:** update any test asserting the default list count/contents (grep for `adsAndTrackingLists`/`DEFAULT_LIST_URLS` in `*.test.*` — e.g. `engine.test.ts`, a subsRepo seedDefaults test). `seedDefaults` is additive (INSERT OR IGNORE), so existing profiles get the new lists on next boot — no migration code needed; if a test asserts an exact seeded count, update it.
- [ ] **Verify on streamex.sh** (throwaway `_verify.mjs`, deleted after): launch with the rebuilt seed (no updateNow — test the SEED itself), navigate `https://streamex.sh/`, wait ~9s, report blocked count + the leaked resource hosts. Compare to the baseline (rotating `.cfd`/`.cyou` domains should be gone; streamex resource count lower). Run 2× (ads are dynamic). Paste the numbers. (Accept that `bp.lagunesgujerat.com`/analytics/first-party may still leak — note it.)
- [ ] Verify: `npm run rebuild:node && npx vitest run electron/main/adblock/engine.test.ts` (+ any updated test). tsc production clean.
- [ ] Commit `feat(adblock): expand default filter lists (uBlock + AdGuard + Peter Lowe) + regenerate seed for stronger coverage` (+ trailer). (The regenerated `engine-seed.bin` is a large binary diff — expected.)

---

## Block D — Gate + visual

### Task 5: Full gate + visual + (controller offers merge)

- [ ] Full dual-ABI gate: `npm test` then `npm run build && npm run test:e2e` → paste both summaries. Fix any failure in the owning task.
- [ ] tsc production clean.
- [ ] Visual (controller, throwaway capture, deleted): the Saved tab with a search box + an item in edit mode; the Downloads modal (opened from the toolbar icon); confirm the sidebar has only History + Saved.
- [ ] Re-confirm the streamex.sh improvement number from Task 4.

---

## Notes
- Local commits only on `saved-downloads-adblock`; never push/remote/branch-rename. Trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
- #5 honest scope: this improves third-party ad coverage measurably; first-party-served ads, the video player's own ads (VAST), and rotating throwaway domains on piracy sites can't be fully eliminated. Report the measured before/after, not "ads gone".
- The expanded lists are the standard uBlock/AdGuard default sets (low breakage risk); the runtime 24h refresh + additive `seedDefaults` keep them current and migrate existing profiles.
