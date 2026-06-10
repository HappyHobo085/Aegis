# Aegis Phase 4 — Settings · Filter-List Manager · My-Filters · Allowlist Management

**Date:** 2026-06-10
**Status:** Design approved; spec for review.
**Goal:** Make Aegis "fully configurable without code" (brief §4.5 exit) by exposing a Settings UI over the
already-built settings data layer, shipping a *functional* filter-list manager, a my-filters custom-rules box,
and allowlist management — all on the established modal/IPC/repo patterns.

---

## 1. Scope (locked with the user)

**Brief-faithful** (brief §3.7, §4.5). In scope:

1. **Settings UI** — a tabbed modal exposing the existing `Settings` fields, made *functional*.
2. **Filter-list manager** — enable/disable subscriptions **and** add/remove custom list URLs; **closes the
   known `runRefresh()`→`SubsRepo` wiring gap**.
3. **My-Filters** — a custom-rules textarea (uBlock syntax, **network + cosmetic**), merged into the engine.
4. **Allowlist management** — view all allowlisted hosts, remove individual entries, clear-all.

**Deferred to Phase 5** (explicit non-goals this phase): downloads-location setting; data export/import &
clear-history actions; ad-block stats/logs; element picker; the `hideChromeByDefault` chrome-hide **behavior**.

### Sub-decisions
- **(A) `hideChromeByDefault`: deferred.** Making it work is a chrome show/hide *feature* (reveal affordance +
  Phase-3 content-inset interaction). Not built this phase; **no dead toggle is shown** in Settings.
- **(B) My-filters = network + cosmetic.** Both are handled by the same `ElectronBlocker.parse` rebuild path.

---

## 2. As-built leverage (what already exists — do not rebuild)

- **Settings stack, zero UI:** `Settings { siteName, homeUrl, primaryColor, defaultSearchTemplate,
  searchEngines[], hideChromeByDefault }` (`shared/types.ts`); `SettingsRepo.get()/set(partial)`;
  `settings.get`/`settings.set` IPC + preload `aegis.settings.*`. Today only `primaryColor` (→ `applyTheme`,
  once at mount) and `defaultSearchTemplate` (→ `useNav`) are consumed.
- **Ad-block controls (most of §4.5 ships):** `AdblockShield` already renders the global toggle, per-site
  allowlist toggle, and per-page/session blocked counts via `useAdblock` + `adblock.setEnabled`/
  `toggleAllowlist`/`getState` + `onBlockedCount`. `AdblockController`/`AdblockRepo` persist
  `{ enabled, allowlistedHosts[] }` in `adblock_config`.
- **Subscriptions data layer:** `Subscription { listId, url, enabled, lastUpdated, etag, hash }` +
  `filter_subscriptions` table; `SubsRepo.seedDefaults/all()/updateMeta()`; `DEFAULT_LIST_URLS` (from
  `adsAndTrackingLists`) seeded at boot; force-update IPC `lists.updateNow` → `ListUpdateResult`; the
  HTTPS-only fetch guard in `listManager.ts`.
- **The wiring gap (to fix):** `runRefresh()` (`index.ts`) sources URLs from the hardcoded `DEFAULT_LIST_URLS`,
  never from `SubsRepo.all()`; the `filter_subscriptions.enabled` column is written-but-never-read.

---

## 3. Architecture

A **Settings modal** mounted in `App.tsx` via a new `settingsOpen` `useState` gate (sibling of
`FavoritesManager`), opened from a new toolbar **gear button**. Built on the existing `useDialog<T>(onClose)`
(first-focus, focus-trap, Escape, focus-restore) + the `Sidebar` **tablist** a11y pattern (`role="tablist"`/
`tab`/`tabpanel`). `AdblockShield` stays as the quick toolbar control (Settings = the full surface).

New main-side repo + `SubsRepo`/`AdblockController` methods, new sender-guarded IPC, and a **rewritten
`runRefresh()`** whose engine rebuild merges **[enabled-subscription list texts + user custom-filters text]**
so list toggles, custom URLs, and my-filters all take effect on update. New renderer hooks + tab components.

---

## 4. Settings modal — tabs

> Modal: `role="dialog" aria-modal="true"` labelled "Settings"; internal `role="tablist"`. Tabs below.

### 4.1 Appearance
- **Accent color** (`primaryColor`): color input → `settings.set({primaryColor})` → **re-apply theme live**
  (today `applyTheme` runs only at mount — a shared `useSettings` hook re-applies on change).
- **Site name** (`siteName`): text input → set the document/window title + a brand label in the chrome.
  *(Make-functional: today persisted-but-dead.)*

### 4.2 Search
- Manage **`searchEngines[]`** (a `SearchEngine` = display name + URL template; exact field names pinned from
  `shared/types.ts` in the plan's contract): add / edit / remove; mark one **default**.
- The chosen default engine's `template` is written to the existing **`defaultSearchTemplate`** field, so the
  address-bar search wiring (`useNav`, already reads `defaultSearchTemplate`) needs **no change**.
  *(Make-functional: `searchEngines` was persisted-but-dead.)*

### 4.3 Home
- Edit **`homeUrl`**; **wire the main-side home/navigation path to resolve `settingsRepo.get().homeUrl`**
  (today the persisted value is ignored in favor of the boot/env home). The renderer's home button
  (`useNav.home`) is unchanged — main resolves the target. *(Make-functional. Exact handler pinned in the
  plan's contract.)*

### 4.4 Filter Lists (the manager)
- List **all** subscriptions (default + custom): name/url, enabled toggle, last-updated.
- **Add a custom list URL** (HTTPS-guarded, reusing `listManager` guard) and **remove** custom lists.
- **Force-update-all** (reuse `lists.updateNow`), showing the per-source `ListUpdateResult`.
- **Closes the wiring gap:** `runRefresh()` sources enabled rows' URLs from `SubsRepo.all()`.

### 4.5 My Filters
- A **textarea** for user uBlock-syntax rules (**network + cosmetic**), persisted as a single text blob.
- Merged into the engine rebuild (`parse([enabled list texts + custom filters].join('\n'))`).
- On save: rebuild + report parsed-vs-ignored line count (engine tolerates bad lines).

### 4.6 Allowlist
- View **all** allowlisted hosts; **remove** individual entries; **clear-all**.
- The shield's toggle-current-host stays; this is the full browser/manager.

---

## 5. Data-layer changes

- **`SubsRepo`** (new methods): `setEnabled(listId, enabled)`, `add(url): Subscription` (derive `listId`,
  `enabled=true`, HTTPS-validated), `remove(listId)`. (Existing `all/seedDefaults/updateMeta` unchanged.)
- **`CustomFiltersRepo`** (new): single-row text store for the my-filters blob. New `custom_filters` table via
  the **additive `CREATE TABLE IF NOT EXISTS`** migration pattern (consistent with Phases 1–3).
- **`AdblockController`/`AdblockRepo`** (new methods): `removeAllowlist(host)`, `clearAllowlist()` (+ a
  reconcile so removing the current host's allowlist re-enables blocking on it).
- **`runRefresh()` rewrite:** enabled subscription URLs come from `SubsRepo.all()`; the rebuild parses
  `[fetched list texts + customFiltersRepo.get()].join('\n')` then `engine.updateResources(...)` (the
  **verified Phase-1 runtime-rebuild path** — `ElectronBlocker.parse` + `updateResources`).
- **Make-functional wiring:** `nav.home()` reads `settings.homeUrl`; `siteName` → title; `searchEngines`
  default → `defaultSearchTemplate`. No *new* `Settings` columns (deferred items were the only ones needing them).

---

## 6. IPC surface (all via the established sender-guarded recipe)

New channels (added to `IPC` in `shared/types.ts`, preload `aegis.*`, a `buildXHandlers(repo)` map merged into
`registerGuardedHandlers(chromeWc.id, {…})`):

- **Subscriptions:** `subs.list` → `Subscription[]`; `subs.setEnabled(listId, enabled)` → `Subscription[]`;
  `subs.add(url)` → `Subscription[]`; `subs.remove(listId)` → `Subscription[]`.
- **Custom filters:** `customFilters.get` → `string`; `customFilters.set(text)` → `{ parsed, ignored }`.
- **Allowlist:** `adblock.removeAllowlist(host)` → `AdblockState`; `adblock.clearAllowlist()` → `AdblockState`.
- **Existing reused:** `settings.get/set`, `lists.updateNow`, `adblock.getState/setEnabled/toggleAllowlist`,
  `onBlockedCount`.

Engine-affecting mutations (`subs.*`, `customFilters.set`) trigger a rebuild and reuse the existing adblock
state/count push so open UI refreshes. (A small `subs.changed`/reuse-of-state-push detail is settled in planning.)

---

## 7. Renderer

- **Hooks:** `useSettings` (shared get/set + re-applies theme on change), `useSubscriptions`
  (list/setEnabled/add/remove + force-update), `useCustomFilters` (get/set + parsed/ignored report); extend
  `useAdblock` with `removeAllowlist`/`clearAllowlist`.
- **Components:** `SettingsModal` (gear-button trigger + tablist) + tab panels `AppearanceTab`, `SearchTab`,
  `HomeTab`, `FilterListsTab`, `MyFiltersTab`, `AllowlistTab`. New toolbar **gear** button (`Toolbar` slot).

---

## 8. Error handling

- **My-filters:** `engine.parse` tolerates malformed lines (ignored); surface `{ parsed, ignored }` so the user
  sees how many rules took effect.
- **Add custom URL:** validate HTTPS (reuse guard); a fetch failure surfaces via the per-source
  `ListUpdateResult` on the next update (the row is added but flagged not-yet-fetched).
- **List update failures:** already reported per-source; the manager renders them.
- **Settings writes:** `settings.set` is partial-merge + persisted (existing); theme re-apply is idempotent.

---

## 9. Testing strategy (dual-ABI, as established)

- **Unit (Node ABI / jsdom):** `SubsRepo` new methods + `CustomFiltersRepo` + `custom_filters` migration;
  allowlist remove/clear on `AdblockRepo`/`Controller`; the `runRefresh` merge (enabled-only + custom-filters
  concatenation) with injected deps; the IPC builders; `useSettings`/`useSubscriptions`/`useCustomFilters`
  hooks; each tab component + `SettingsModal`; `Toolbar` gear slot.
- **e2e (Electron ABI):** Settings round-trip + **persistence across relaunch** (e.g. a changed accent color
  + a custom list + my-filters text survive restart); toggling a list changes what `runRefresh` fetches; a
  custom **my-filter blocks a fixture request** that is otherwise allowed (proving engine merge); allowlist
  remove/clear reflected in `AdblockState`; `nav.home()` navigates to the configured `homeUrl`.
- **Full regression gate** at the exit: `npm test` (all unit) then `npm run build && npm run test:e2e`
  (all e2e), green with no regression.

---

## 10. Out of scope / non-goals (Phase 5)

Downloads-location setting; data export/import & clear-history; ad-block stats/logs/top-domains; session-count
reset; element picker; `hideChromeByDefault` chrome-hide behavior; auto-update; packaging.

---

## 11. Success criteria (Phase-4 exit)

1. A Settings modal opens from a toolbar gear, is keyboard-accessible (focus-trap + Escape via `useDialog`),
   and has working Appearance / Search / Home / Filter Lists / My Filters / Allowlist tabs.
2. **Accent color** edits re-theme the app live and persist across restart.
3. **Search engines** are CRUD-manageable; the chosen default drives the address-bar search.
4. **Home URL** edits take effect: `nav.home()` navigates to the configured `homeUrl`.
5. **Site name** edits update the window/document title.
6. **Filter-list manager:** lists can be enabled/disabled and custom HTTPS URLs added/removed; `runRefresh()`
   fetches exactly the **enabled** rows' URLs (the wiring gap is closed; `enabled` is now read).
7. **My-filters:** user rules (network + cosmetic) persist and, after update, a custom rule blocks/hides a
   request/element that was otherwise allowed.
8. **Allowlist management:** all allowlisted hosts are viewable; individual remove + clear-all work and
   reconcile blocking.
9. **Persistence:** settings, subscriptions (enabled state + custom URLs), and my-filters all survive an app
   restart.
10. **No regression:** the full prior gate (Phases 0–3 unit + e2e) stays green.
