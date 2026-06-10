# Aegis — Design Spec, Phase 3 ("Favorites, history, saved-list, sidebar + persistence")

**Date:** 2026-06-10
**Status:** Design approved → awaiting spec self-review + user review
**Source:** `ad-blocking-browser-brief.md` §3.3–3.5 (favorites/history/saved), §6 (persistence), Phase-3 roadmap line; carries the Slice-1 spec's keystone decisions (rebuild UI fresh; UW is visual reference only; `better-sqlite3` local store; schema laid out so Phase 3 just adds tables).
**Builds on:** Phases 0–2 complete on `main` (Slice 1 = "full ad-free core"; 277 unit/component + 31 e2e green). Sandboxed `WebContentsView` browser with nav, ad-blocking (network + cosmetic + anti-adblock), settings/session DB, a11y chrome.

> **Markers:** **[decided]** = locked this brainstorm; **[verify@plan]** = confirm against the as-built code/Electron behavior before writing code (verify-don't-guess).

---

## 1. Purpose & scope
Add the local "places" features that make Aegis a usable daily browser: a favorites bar + manager with freeform tags, an auto-recorded history timeline, a manually curated saved-list, all surfaced in a toggleable inset **sidebar** + top-band favorites bar, and all persisted locally in SQLite. **Phase-3 exit (brief §8.7-style):** favorites (with tags), history (deduped, trimmed), saved-list, and settings all survive an app restart with no server.

### Two scope decisions locked this phase
1. **One cohesive Phase 3** — the foundation (3 stores + repos + IPC), the sidebar shell + dynamic content-layout, and all three features ship in one spec→plan→build (the features share the same plumbing).
2. **Inset sidebar** — a toggleable left sidebar that **insets the content `WebContentsView`** (repositioned narrower, side-by-side) rather than overlaying/hiding it. Real-browser feel; fits the WebContentsView model (chrome already spans the full window behind content, so insetting content exposes the sidebar region).

### In scope
- **Favorites:** top-band favorites bar (chips → navigate, respects tag filter, toggleable); full-CRUD manager modal (name, URL, freeform tag editor w/ autocomplete); tag-filter chip row; global tag rename/delete.
- **History:** auto-recorded timeline (url, title, visitedAt), dedup vs most-recent, trim to 500; sidebar panel with localized timestamps, click-to-revisit, per-row remove, clear-all, search.
- **Saved-list:** manual curated list (distinct from history); sidebar panel; toolbar bookmark button that fills-in when the current page is saved (toggle add/remove).
- **Sidebar shell** + the content-inset layout coordination.
- **Persistence:** 3 new tables + repos; survives restart.

### Out (named for traceability)
Full Settings surface, export/import favorites, broad data-clearing UI → **Phase 4** (clear-all *history* is in scope as part of the history panel). Downloads/PDF/media UX, packaging, security-audit sign-off → **Phase 5**. Account/sync → never (local-only, account-less). Reordering favorites by drag is a nice-to-have; a stable `position` column is provided but drag-reorder UI is optional/minimal.

---

## 2. As-built foundation (verified)
- **DB:** `openDb(path)` + `runMigrations(db)` (`electron/main/db/sqlite.ts`) — idempotent `CREATE TABLE IF NOT EXISTS`; existing tables `settings`, `adblock_config`, `filter_subscriptions`. Repos take the `db` handle, use prepared statements (`SettingsRepo`/`AdblockRepo`/`SubsRepo`), node-testable with in-memory better-sqlite3 (Node ABI via `pretest`).
- **Nav events:** `ViewController` (`electron/main/viewController.ts`) emits state on `did-navigate` (top-frame, sets `lastCommittedUrl`), `did-navigate-in-page` (SPA main-frame), `page-title-updated` (debounced 400ms). `did-start-navigation` is used by the adblock controller. The content `WebContents` + session are exposed via `vc.contentWebContents` / `vc.contentSession` (Phase-1 getters).
- **Layout:** `window.ts` `layout(win, chromeView, contentView)` sets `chromeView` to the full window `(0,0,w,h)` and `contentView` to `(0, CHROME_TOP_HEIGHT=56, w, h−56)`. Content is added **after** chrome → content is on top in the lower region; chrome is only visible where content doesn't cover (the top band). `win.on('resize', () => layout(...))`.
- **IPC:** `registerGuardedHandlers(chromeWcId, handlers)` (sender-validated); builder pattern (`buildNavHandlers`, `buildSettingsHandlers`, `buildAdblockHandlers`, `buildListsHandlers`); `buildViewEventForwarders(chromeWc)` maps main→chrome push events. `shared/types.ts` is the single IPC source of truth; `chromePreload.ts` exposes `window.aegis` via contextBridge.
- **Renderer:** `App.tsx` renders `Toolbar` (NavControls + AddressBar + AdblockShield) over the content view; hooks `useNav`/`useAdblock`; `useDialog` (focus-trap), `Toaster` (aria-live), `theme`, `ipcClient`. Vitest projects (`node` for electron/shared, `jsdom` for src); Playwright `_electron` e2e with the retry-tolerant `launchApp` poll.

---

## 3. Data model & persistence  **[decided]**
Three tables added to `runMigrations` via idempotent `CREATE TABLE IF NOT EXISTS` — purely **additive** (no change to existing tables), so the versioned-migration runner stays a deferred follow-up.

| Table | Columns | Notes |
|---|---|---|
| `favorites` | `id` INTEGER PK, `name` TEXT, `url` TEXT, `tags` TEXT (JSON string[]), `position` INTEGER | tags denormalized as a JSON array (brief §6 "tags: string list"); `position` orders the bar. |
| `history` | `id` INTEGER PK, `url` TEXT, `title` TEXT, `visitedAt` INTEGER (epoch ms) | auto-recorded; dedup vs most-recent; trim to newest 500. |
| `saved_list` | `id` INTEGER PK, `url` TEXT, `title` TEXT, `savedAt` INTEGER (epoch ms) | manual; distinct from history. |

Repos (`favoritesRepo`/`historyRepo`/`savedRepo`) mirror the existing prepared-statement repo pattern. `tags` (de)serialized as JSON with a parse-fallback to `[]` (like `adblockRepo`'s allowlist).

---

## 4. History recording (main-side, automatic)  **[decided]**
The main process owns nav events + the DB, so recording is main-side. A `historyRecorder` (`electron/main/historyRecorder.ts`) subscribes to the content WC `did-navigate` (top-frame full nav) and `did-navigate-in-page` (SPA main-frame), and records `{ url, title, visitedAt }` to `historyRepo`:
- **Dedup:** if `url` equals the most-recent entry's `url`, update that row's `visitedAt` (and title if newer) instead of inserting — no consecutive duplicates.
- **Trim:** after insert, delete rows beyond the newest 500.
- **Title:** use the WC's current (debounced) title; a late title update for the same most-recent url updates the row.
- Skip non-recordable schemes (`about:blank`, the app's own chrome url) **[verify@plan]** via the existing scheme helper.
The renderer history panel only reads/searches/revisits/removes/clears via IPC (§7). A `history.changed` push event lets an open panel refresh after a recording.

---

## 5. Tags  **[decided]**
Freeform per-favorite tags (JSON array). A **tag-filter** chip row, derived from the union of all favorites' tags, filters both the favorites bar and the manager. **Global ops** in `favoritesRepo` (a transaction over rows): `renameTag(old, new)` updates the tag in every favorite that has it; `deleteTag(tag)` removes it from every favorite. The manager's tag editor autocompletes from the current tag union. `tagUnion()` derives the distinct sorted tag set (fine at this scale).

---

## 6. Sidebar + content-inset architecture (the key new piece)  **[decided]**
The renderer owns chrome layout and reports the content view's insets to main, which positions the content `WebContentsView`:
- New IPC **`view.setContentInset(viewId, { top: number, left: number })`** — the renderer computes `top` (toolbar + favorites-bar height) and `left` (sidebar width when open, else 0) and calls it whenever the favorites bar or sidebar toggles (or the chrome resizes).
- `window.ts` `layout()` becomes inset-driven: it stores the latest `{top,left}` (default `{top: CHROME_TOP_HEIGHT, left: 0}` until the renderer reports — avoids a boot race) and positions content = `(left, top, width − left, height − top)`. The `resize` handler re-applies the stored inset. **[verify@plan]** inset + resize interaction round-trips cleanly.
- Because the chrome view spans the full window *behind* content, insetting content **exposes** the chrome's left strip (sidebar) + taller top band (favorites bar) — no new view required. The page reflows to the narrower width (normal side-panel behavior); closing the sidebar restores full width.

---

## 7. IPC contract additions (`shared/types.ts`)
All Chrome→Main handlers sender-validated via `registerGuardedHandlers`.
- **favorites:** `favorites.list() → Favorite[]`; `favorites.add({name,url,tags}) → Favorite[]`; `favorites.update(id, partial) → Favorite[]`; `favorites.remove(id) → Favorite[]`; `favorites.reorder(ids[]) → Favorite[]`; `favorites.renameTag(old,new) → Favorite[]`; `favorites.deleteTag(tag) → Favorite[]`; `favorites.tagUnion() → string[]`.
- **history:** `history.list({limit?,offset?}) → HistoryEntry[]`; `history.search(q) → HistoryEntry[]`; `history.remove(id) → void`; `history.clear() → void`. Push: `history.changed` (fired after a recording / mutation).
- **saved:** `saved.list() → SavedItem[]`; `saved.add({url,title}) → SavedItem[]`; `saved.remove(id) → SavedItem[]`; `saved.has(url) → boolean`.
- **view:** `view.setContentInset(viewId, {top,left}) → void`.
Types: `Favorite {id,name,url,tags:string[],position}`, `HistoryEntry {id,url,title,visitedAt}`, `SavedItem {id,url,title,savedAt}`.

---

## 8. Renderer components & hooks
- **Components:** `Sidebar` (toggle button + tab between History/Saved), `HistoryPanel` (list w/ localized timestamps + search box + revisit/remove/clear), `SavedPanel`, `FavoritesBar` (chips, tag-filtered), `FavoritesManager` (focus-trapped modal, CRUD + tags), `TagInput` (autocomplete from tag union), `TagFilter` (chip row), `BookmarkButton` (toolbar; fill-in state).
- **Hooks:** `useFavorites` (list + CRUD + tag ops + filter state), `useHistory` (list/search + subscribe to `history.changed`), `useSaved` (list + add/remove + `has(currentUrl)` fill-in), `useContentInset` (measures the chrome's top/left and calls `view.setContentInset` on toggle/resize).
- `App.tsx` mounts the favorites bar + sidebar around the existing Toolbar and wires `useContentInset`.

---

## 9. Module structure
```
electron/main/db/  favoritesRepo.ts  historyRepo.ts  savedRepo.ts  (+ tests)  ; sqlite.ts (+3 tables, +their migration tests)
electron/main/historyRecorder.ts (+ test)            did-navigate(-in-page) → historyRepo (dedup+trim)
electron/main/ipc/  favorites.ts  history.ts  saved.ts  (+ tests)  ; nav.ts (setContentInset handler + history.changed forwarder)
electron/main/window.ts        inset-driven layout()  ; index.ts (wire repos + recorder + handlers + inset)
shared/types.ts                Favorite/HistoryEntry/SavedItem + IPC channels + AegisApi (+ test)
src/components/  Sidebar  HistoryPanel  SavedPanel  FavoritesBar  FavoritesManager  TagInput  TagFilter  BookmarkButton  (+ tests)
src/hooks/  useFavorites  useHistory  useSaved  useContentInset  (+ tests)  ; App.tsx (mount + wire)
electron/test/e2e/  favorites.spec.ts  history.spec.ts  saved.spec.ts  sidebar.spec.ts  persistence.spec.ts
```

---

## 10. Testing strategy
- **Unit (Node ABI):** `favoritesRepo` (CRUD, reorder, tagUnion, renameTag/deleteTag across rows), `historyRepo` (insert, dedup-updates-most-recent, trim-to-500, search, remove, clear), `savedRepo` (add/remove/has/list), `historyRecorder` (dedup/trim logic via fake repo + fake WC events; skips non-recordable schemes).
- **Component (jsdom):** FavoritesBar (tag-filtered chips → navigate), FavoritesManager (CRUD + TagInput autocomplete + global ops), TagFilter, HistoryPanel (search/revisit/remove/clear + localized timestamps), SavedPanel, BookmarkButton (fill-in), the hooks.
- **e2e (`_electron`):** favorite add → bar chip → navigate; **history auto-records a real nav** + revisit; bookmark fills-in after save; **sidebar toggle insets the content view** (assert the content `WebContents` bounds shrink by the sidebar width, then restore on close); **persistence across relaunch** (add a favorite + a saved item, relaunch with the same `AEGIS_USER_DATA`, assert they're still there) — the Phase-3 exit.
- **Regression:** the full Phase-0+1+2 gate (277 unit + 31 e2e) stays green.

---

## 11. Success criteria (brief §8 / Phase-3 exit)
1. **Favorites:** add/edit/remove; bar chips navigate; freeform tags with autocomplete; tag-filter narrows bar + manager; global rename/delete a tag updates all favorites.
2. **History:** every top-frame nav auto-records (deduped vs most-recent, trimmed to 500); panel searches, revisits, removes a row, clears all, shows localized timestamps.
3. **Saved-list:** manual add/remove distinct from history; bookmark button fills-in for a saved page and toggles.
4. **Sidebar:** toggles and **insets the content view** (content bounds shrink/restore); favorites bar toggles and adjusts the top inset.
5. **Persistence:** favorites (w/ tags), history (deduped/trimmed), saved-list survive an app restart (no server).
6. **No regression:** Phases 0–2 gate green.

---

## 12. Open items for the plan
1. `view.setContentInset` round-trip + the existing `resize` handler interaction (store inset in main; re-apply on resize) **[verify@plan]**.
2. Recording on `did-navigate-in-page` (SPA) without flooding history — dedup-vs-most-recent should absorb it; confirm `did-navigate-in-page`'s args (url, isMainFrame) on Electron 42.
3. Which schemes are non-recordable (`about:blank`, the app chrome url) — reuse `isAllowedNavigationUrl` / `isAppUrl` **[verify@plan]**.
4. `history.changed` push vs. renderer re-query on panel open (push chosen; confirm it doesn't over-fire).
5. Favorites drag-reorder UI depth (stable `position` provided; minimal/optional reorder controls).
