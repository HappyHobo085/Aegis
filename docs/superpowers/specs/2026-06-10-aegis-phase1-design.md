# Aegis — Design Spec, Phase 1 ("Network ad/tracker blocking")

**Date:** 2026-06-10
**Status:** Design approved → awaiting spec self-review + user review
**Parent spec:** `docs/superpowers/specs/2026-06-09-aegis-slice1-design.md` (Slice 1 = Phases 0–2). This document carves **Phase 1** out of that spec, refines it against the *as-built* Phase 0 code, and records the two scope decisions made for this phase.
**Builds on:** Phase 0 (complete: sandboxed `WebContentsView` on `persist:content`, nav, IPC guard, scheme allowlist, settings/session, DB, a11y chrome). 177 tests green on `main`.

> **Markers used below:** **[decided]** = a choice locked in this brainstorm; **[verify@plan]** = the exact `@ghostery/adblocker` API/behavior must be confirmed against the installed package source *before* code is written (per the project's verify-don't-guess rule). The parent spec's §3 verified the core engine wiring; items here are the deltas that still need source confirmation.

---

## 1. Purpose & phase boundary

Turn always-on, uBlock-grade **network** ad/tracker blocking on in the Phase-0 browser shell, with the list-management lifecycle, escape-hatch controls, and blocked-count surface needed to use it safely — without regressing any Phase-0 behavior.

### Two scope decisions locked this phase
1. **Engine fully on; Phase 1 verifies the network layer.** `@ghostery/adblocker-electron`'s `enableBlockingInSession()` performs network blocking **and** cosmetic hiding **and** scriptlet injection in one call (cosmetics on by default). Phase 1 wires the **complete** engine (all three layers live — the library default; disabling cosmetics would be *extra* work) but its **acceptance criteria target the network layer only**. The cosmetic/scriptlet capability is live-but-unverified; its fixtures, no-flash measurement, anti-adblock M/N suite, and popup/redirect gesture-hardening are **Phase 2**.
2. **Never-zero-blocking via a bundled prebuilt engine snapshot.** A committed dev script serializes the default list set into a versioned blob shipped inside the app. First run loads it instantly at full strength, then background-refreshes to live sources and caches. (Chosen over a raw-text seed — stronger first-run coverage, no first-run parse cost — accepting a ~1–2 MB in-repo binary that must be regenerated on engine-version bumps, enforced by a test.)

### In scope (Phase 1)
- Filter engine lifecycle: load (cache → bundled snapshot → `fromLists`), `enableBlockingInSession` once, `serialize()` cache.
- List manager: HTTPS-only fetch (timeout + size-cap), scheduled 24 h refresh (injectable timer), manual "update now", atomic on-disk cache, cache-fallback on failure, per-source metadata.
- Bundled prebuilt engine snapshot + `generate-seed` dev script + a deserialize-compatibility test.
- **Engine-readiness gating:** no content navigation is processed with blocking inactive (satisfied synchronously by the seed before the first nav).
- Blocked-count: per-page badge + monotonic session total.
- Escape-hatch controls: global ad-block on/off + per-site allowlist (reversible, **applied on next navigation**).
- DB: `adblock_config` (singleton) + `filter_subscriptions` tables.
- IPC: `adblock.setEnabled` / `adblock.toggleAllowlist` / `adblock.getState` / `lists.updateNow` + `adblock.blockedCount` event.
- Renderer: shield control in the existing toolbar (count badge + popover with global toggle & per-site allowlist), `useAdblock` hook, non-blocking "updating filters…" indicator on first-run refresh.
- Build/packaging: add the two adblocker packages + `cross-fetch`; externalize + `asarUnpack` the adblocker packages.

### Live but NOT verified/hardened this phase (→ Phase 2)
- Cosmetic DOM hiding & scriptlet injection are *on* but unmeasured: sentinel-container hide, no-flash measurement, anti-adblock M/N fixture suite.
- `setWindowOpenHandler` gesture/disposition hardening (the deny-popunder / route-in-place **floor already exists** from Phase 0; refinement is Phase 2).

### Explicitly out of Phase 1 (named for traceability)
Full ad-block controls UI (list-manager subscribe/unsubscribe, my-filters editor, element picker), per-site enable/disable overrides beyond allowlist, data-clearing UI → **Phase 4**. Multi-tab, downloads UX, packaging/auto-update → **Phase 5**. The non-goals from the brief/parent spec (no proxy/MITM, no anti-bot bypass, etc.) carry over unchanged.

---

## 2. Integration into the as-built Phase 0 code

| Hook | As-built location | Phase-1 change |
|---|---|---|
| Content session | `viewController.ts:55` — `partition: 'persist:content'` | Engine binds to `vc.contentSession` (= `view.webContents.session`). Add getters `contentSession` / `contentWebContents` to `ViewController` **[decided]**; no change to its nav/security logic. |
| Boot order | `index.ts:45–72` — ViewController created, then final `vc.navigate(...)` | Insert engine setup **between** ViewController creation and `vc.navigate`. Seed path is synchronous (`readFileSync` → `deserialize` → `enableBlockingInSession`), so the **first navigation is already protected without making `boot()` async or showing a wait screen** **[decided]**. Live refresh + 24 h timer scheduled **after** navigate (non-blocking). |
| Content preload | `contentPreload.ts` — deliberate no-op | **Stays a no-op.** The engine registers its *own* cosmetics preload; the old "in-page `window.open` return-stub" idea is **dropped** as unnecessary (the main-process `setWindowOpenHandler` gate is authoritative) — YAGNI **[decided]**. |
| IPC registration | `index.ts:58` — `registerGuardedHandlers(chromeWc.id, {...})` | Add `adblock.*` + `lists.*` handlers into the same sender-validated registration. |
| Per-page reset / counting | content `WebContents` events | New adblock subsystem subscribes to the content WC (`did-start-navigation`) + blocker events; no ViewController nav-logic change. |

---

## 3. Engine lifecycle (`electron/main/adblock/engine.ts`)

**Load order**, each guarded by try/`deserialize`-catch so a version/format mismatch falls through to the next source (never a silent offline break):
1. **User cache** `engine.bin` (app data dir) — fast path on subsequent runs.
2. **Bundled snapshot** (shipped in-app) — first run / cache miss / cache-format-mismatch.
3. **`fromLists`** (network) — only if both above are unavailable/incompatible.

Then `enableBlockingInSession(contentSession)` **exactly once** (so the engine's cosmetics preload is registered once — re-registration is the hazard the allowlist mechanism in §5 is designed to avoid). `serialize()` writes the user cache via `lib/atomicFile`.

- **Bundled snapshot generation:** `npm run generate-seed` (committed dev script) builds the default set via `fromLists` and writes the serialized blob into the app's resources. A **unit test deserializes the bundled blob against the installed engine and fails on incompatibility** — this catches "engine bumped, snapshot not regenerated" **[decided]**.
- `$redirect` resources must load alongside `fromLists` so blocked requests get neutered stubs (reduces breakage) **[verify@plan]** — confirm `resources.json` is loaded with the list set.
- `fetch` for network sources = `cross-fetch` (parent-spec §3.1 choice).

---

## 4. List manager (`electron/main/adblock/listManager.ts`)

- **Sources:** the parent-spec §6.1 default set (EasyList, EasyPrivacy, uBO filters/privacy/badware/unbreak/quick-fixes, Peter Lowe). **HTTPS-only** (reject `http:`). No app-specific media/host allowlist.
- **Fetch hardening:** per-source timeout; **size cap enforced before buffering** (streaming / `maxContentLength`-style limit, not post-hoc).
- **Cache:** atomic temp-write + rename (`lib/atomicFile`); per-source `lastUpdated` / `etag` / `hash` recorded in `filter_subscriptions`.
- **Failure policy:** any source failure → keep last-known-good (cache-fallback); the app keeps blocking from cache/seed.
- **Scheduler:** 24 h refresh on an **injectable timer** (fake-timer testable); manual `lists.updateNow()` must **not** double-fire the schedule.
- **Post-refresh:** rebuild/update the matcher, re-serialize to the user cache; **the refreshed matcher takes effect on the next navigation, never mid-load.**

---

## 5. Global toggle + per-site allowlist

**Behavior [decided]:** both **take effect on the next navigation, not mid-load**, and persist in `adblock_config`. Allowlisting a host restores that host's ads on its next load; un-allowlisting restores blocking on next load. Global-off suppresses all blocking on the next navigation; global-on restores it.

**Mechanism [verify@plan]:** primary candidate is uBO-style **exception filters** (`@@||host^$document` for allowlisted hosts; a master switch for global-off) folded into the matcher and **applied at the `did-start-navigation` boundary** to honor "next navigation, not mid-load." This is chosen specifically to **avoid double-registering the cosmetics preload**, which naive per-navigation `enable/disableBlockingInSession` toggling would cause. The exact matcher-update call (e.g. `engine.update(...)` vs. rebuild-and-swap) and the dup-safe global-off path are confirmed against `@ghostery/adblocker` source before implementation.

---

## 6. Blocked counter (`electron/main/adblock/blockedCounter.ts`)

- Subscribe to the blocker's **`request-blocked` / `request-redirected`** events **[verify@plan]** (exact event names + payload shape from engine source).
- Single content view ⇒ attribute all blocks to `PRIMARY_VIEW_ID`. (Counter is keyed by `viewId` for tab-readiness.)
- **Per-page count resets on the content WC's `did-start-navigation`**; **session total is monotonic**.
- Push `adblock.blockedCount(viewId, { page, session })` to chrome on `did-stop-loading`.

---

## 7. IPC contract additions (`shared/types.ts` — single source of truth)

All Chrome→Main handlers are sender-validated via the existing `registerGuardedHandlers` (parent-spec §4.1).

**Chrome→Main (invoke/handle):**
- `adblock.setEnabled(enabled: boolean)` — global; re-applies on next navigation.
- `adblock.toggleAllowlist(host: string)` → returns new `AdblockState`; applies on next navigation.
- `adblock.getState()` → `{ enabled: boolean; allowlistedHosts: string[]; sessionBlocked: number }`.
- `lists.updateNow()` → `{ perSource: { listId: string; ok: boolean; error?: string }[]; lastUpdated: number }`.

**Main→Chrome (push event):**
- `adblock.blockedCount(viewId, { page: number; session: number })`.

New channel constants added to the `IPC` map and the typed `AegisApi` (`adblock` + `lists` namespaces, plus `onBlockedCount`).

---

## 8. Persistence (new tables)

Added via the **existing idempotent `runMigrations`** (`CREATE TABLE IF NOT EXISTS` + seed the singleton row + seed default subscriptions) **[decided]** — the versioned-migration runner remains the recorded **pre-Phase-3** follow-up (YAGNI now; Phase 1 only *adds* tables).

| Table | Columns | Notes |
|---|---|---|
| `adblock_config` | singleton row: `enabled` (bool), `allowlist` (JSON host[]) | `perSiteOverrides` / `customFilters` are **Phase-4 placeholders** — present for schema stability, not read/written/honored in Phase 1, no Phase-1 IPC. |
| `filter_subscriptions` | `listId` PK, `url`, `enabled`, `lastUpdated`, `etag`, `hash` | Drives fetch/refresh; bundled defaults seeded on first run. |

On-disk artifacts (via `lib/atomicFile`): user-cache `engine.bin` (owner `adblock/engine.ts`), raw list cache (owner `adblock/listManager.ts`). The bundled snapshot ships read-only in app resources.

---

## 9. Renderer UI

A **shield control** at the right of the existing `Toolbar`, plus a `useAdblock` hook (`src/hooks/useAdblock.ts`) over the new IPC. The shield shows the per-page blocked count; clicking opens a small popover with the global toggle, the per-site allowlist checkbox for the current host, and the per-page / session counts. **First-run refresh** shows a subtle, non-blocking "updating filters…" indicator (no wait screen — the seed is already active). Toggles reflect "applies on next navigation" (e.g. a brief "applies on reload" affordance).

```
┌──────────────────────────────────────────────────────────────┐
│ ◀ ▶ ⟳  [ https://example.com                 ]   🛡 12   ⌂ │
└──────────────────────────────────────────────────────────────┘
        click 🛡 ▾
        ┌─────────────────────────────┐
        │ Ad blocking         [On ●]  │  ← global toggle (next nav)
        │ ───────────────────────────  │
        │ ☐ Allow ads on example.com  │  ← per-site allowlist (next nav)
        │ Blocked here: 12            │
        │ Blocked this session: 487   │
        └─────────────────────────────┘
```

---

## 10. Module structure (additions to parent-spec §8)

```
electron/main/adblock/
  engine.ts          ElectronBlocker load(cache→snapshot→fromLists)/serialize/enable + allowlist & global-off application; engine.bin owner
  listManager.ts     fetch(HTTPS-only,timeout,size-cap)/refresh(injectable 24h)/atomic-cache/fallback + raw cache owner
  blockedCounter.ts  per-view counters (§6 semantics)
  seed/              bundled prebuilt snapshot (committed) + generate-seed script
electron/main/db/
  adblockRepo.ts     adblock_config singleton (enabled, allowlist[])
  subsRepo.ts        filter_subscriptions
electron/main/ipc/
  adblock.ts         adblock.setEnabled/toggleAllowlist/getState handlers
  lists.ts           lists.updateNow handler
src/hooks/useAdblock.ts
src/components/      shield control (count badge + popover) wired into Toolbar
shared/types.ts      + AdblockState / BlockedCount / ListUpdateResult + IPC channels + AegisApi.adblock/.lists
```

Unchanged Phase-0 files touched minimally: `viewController.ts` (add getters), `index.ts` (boot wiring), `shared/types.ts` (additions), `db/sqlite.ts` (two more `CREATE TABLE IF NOT EXISTS` + seeds), `Toolbar.tsx` (mount shield), `package.json` + electron-vite config (deps + externalize/asarUnpack).

---

## 11. Error handling & resilience

- Engine load fully fails (no cache, no usable snapshot, offline) → app still boots and navigates; blocked count is 0; "filters unavailable" surfaced non-fatally (no crash). This should be unreachable in practice (snapshot ships in-app) but is handled.
- Refresh failure → cache-fallback, surfaced via the `lists.updateNow` result / a toast; never throws into boot.
- All new IPC handlers go through the existing guard; malformed args rejected by the typed boundary.
- No regression to Phase-0 resilience (error overlay, crash recovery, session restore) — covered by re-running the Phase-0 suite.

---

## 12. Testing strategy (TDD; injectable clocks)

- **Unit:** `listManager` (fetch, size-cap before buffering, atomic cache, **offline cache-fallback**, **scheduler via fake timers** + no double-fire on manual update); `blockedCounter` (viewId keying, per-page reset on `did-start-navigation`, monotonic session, `{page,session}` payload); `engine` (load-order fallthrough cache→snapshot→fromLists; **bundled blob deserializes against installed engine**); `adblockRepo` / `subsRepo`.
- **Component:** shield control + `useAdblock` (global-toggle & allowlist UI state, count rendering, "applies next nav" affordance).
- **Integration (Electron `_electron`):** block-on-local-ad-fixture (`blockedCount > 0`, asserted against a pinned in-repo fixture); **toggle timing** (blocking on → count>0; `setEnabled(false)` → no new blocking on next nav; re-enable → blocking returns next nav; `toggleAllowlist` same pattern incl. ads restored on the allowlisted host); first-run-on-seed + offline-cache; `lists.updateNow` happy path.
- **Regression:** the full Phase-0 suite (160 unit/component + 17 e2e) must stay green.
- **Out of scope here (→ Phase 2):** cosmetic sentinel-hide, no-flash measurement, anti-adblock M/N suite.

---

## 13. Success criteria (Phase-1 subset of parent-spec §10)

1. **Ads gone by default — network half (§10.3 network):** on the pinned local ad fixture, network ad/tracker (sub)requests are blocked (`blockedCount > 0`, asserted). *(Cosmetic sentinel-hide and no-flash are Phase 2.)*
2. **Lists update (§10.5):** default lists fetch on first run; the auto-refresh tick fires on the injected timer (fake-timer test); manual update works; the app still functions from cache when offline / on fetch failure; **first run with no network still blocks via the bundled snapshot.**
3. **Escape-hatch controls (§10.6):** global toggle and per-site allowlist take effect on the **next navigation, not mid-load**; allowlisting a host **restores its ads** on that host's next load.
4. **Engine-readiness gating (§6.5):** no content navigation is ever processed with blocking inactive (seed enabled synchronously before the first `vc.navigate`).
5. **Blocked-count semantics (§6.3):** per-page resets on navigation start; session total monotonic; payload matches `{page, session}`.
6. **Build/packaging:** both adblocker packages externalized + `asarUnpacked`; the runtime `PRELOAD_PATH` resolves; no new native-ABI burden (adblocker is pure JS — only `better-sqlite3` still needs `electron-rebuild`).
7. **No regression:** Phase-0 suite stays green.

---

## 14. Open items to resolve during planning (verify against `@ghostery/adblocker` source)

1. Exact allowlist / global-off matcher-update API that does **not** re-register the cosmetics preload (§5).
2. Exact blocked/redirected **event names + payload shapes** for the counter (§6).
3. Confirm `$redirect` **resources** load alongside `fromLists` (§3).
4. `generate-seed` snapshot **size** and the runtime **`PRELOAD_PATH`** resolution check in dev + (eventually) packaged builds (§3, §6 of parent spec).
5. Exact electron-vite wiring to externalize + `asarUnpack` `@ghostery/adblocker-electron(-preload)` (parent-spec §12 carried forward).
