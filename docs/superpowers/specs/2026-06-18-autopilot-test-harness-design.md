# Autopilot test harness — design

**Date:** 2026-06-18
**Status:** Approved (brainstorm) — pending implementation plan

## Goal

A way to "launch the app and autonomously test everything — every feature, every
UI combination." Delivered as **two complementary layers** that share a single
feature catalog so coverage stays current:

1. **Live in-app autopilot** — a test-only mode built into the renderer that, when
   launched, self-drives every feature through the **real `aegis` IPC client → real
   Rust core** (real adblock engine, real JSON stores, real nav), screenshots each UI
   state, and writes a pass/fail report. Driven by a Linux launcher script.
2. **Exhaustive in-process vitest suite** — mounts the full React app with a mock
   `aegis` and walks every screen / overlay / Settings tab / sidebar tab and the
   meaningful state combinations, asserting each renders and fires the right IPC call.
   Deterministic, CI-friendly, runs under `npm test`.

A **drift-guard test** mechanically enforces that the catalog stays current: adding a
feature (new IPC channel, new Settings tab, new overlay) without a catalog entry fails
the build.

## Non-goals

- External GUI automation (tauri-driver / WebdriverIO / synthetic clicks) — rejected
  as flaky on Aegis's dual-webview setup.
- Windows / macOS / Android **launchers** — out of scope for the first cut. The
  autopilot **core** (catalog + `run.ts` + control surface) is platform-agnostic and
  runs in the same renderer everywhere; only the launcher + screenshot capture are
  per-platform. Those launchers are thin follow-ons (documented, not built now).
- Literal full-Cartesian coverage of all reachable UI states (thousands). See
  "Coverage scope" below for what is actually covered.

## Constraints / context (verified against the code)

- The renderer reaches the backend through exactly one module, `src/lib/ipcClient.ts`
  (`aegis`, typed by `AegisApi`); channels live in `shared/types.ts` (`IPC` const).
- The renderer currently reads **no** startup config — `import.meta.env` is unused, so
  `import.meta.env.VITE_AEGIS_AUTOPILOT` is a clean, unused flag channel.
- `npm run tauri:dev` launches the **real** app (real Rust core, real webviews, real
  adblock) with a Vite-served renderer and a debug Rust build. This is the launch
  vehicle. (Approved.)
- Headless runs render black on this machine; `spectacle` works on KWin, `grim` does
  not. Functional/core assertions do **not** need a display; screenshots do.
- The app writes JSON stores under its Tauri data/config dir. The launcher runs the
  app against a **disposable profile** so the autopilot's real-core CRUD never touches
  real user data. (Approved.)

## Surface to cover (from the code inventory)

- **Desktop overlay-state flags** (`App.tsx`): `settingsOpen`, `sidebarOpen`,
  `downloadsOpen`, `fullscreen`, `shieldOpen`, `managerOpen`, `confirmOpen`,
  `failed` (nav-fail overlay), `crashed` (crash overlay), plus event-driven
  `permissions.prompt`, `safety.interstitial`.
- **Settings modal — 12 tabs** (`TAB_ORDER` in `SettingsModal.tsx`): appearance,
  search, home, tabs, filterLists, myFilters, allowlist, downloads, sitePermissions,
  security, sync, data.
- **Sidebar — 2 tabs**: history, saved.
- **Other screens/overlays**: TabStrip, Toolbar (nav controls, address bar, adblock
  shield, bookmark, update indicator, picker, downloads indicator, settings gear,
  fullscreen, sidebar toggle), FavoritesBar, FavoritesManager, DownloadsModal,
  ErrorOverlay, SafetyInterstitial, PermissionPromptDialog, ConfirmDialog,
  AdblockShield popover, Toaster, WelcomeHint.
- **Mobile (`MobileApp`)**: `sheet` ∈ {menu, history, saved, downloads, settings,
  tabs, null}, `bottomBarHidden`, `fullscreen`, `shieldOpen`.
- **IPC feature-domains (24)**: nav, tabs, view, favorites, history, saved, settings,
  adblock, lists, subs, customFilters, downloads, permissions, data, picker, update,
  safety, sync (+ their events).

## Architecture

```
                 ┌───────────────────────── src/autopilot/ ─────────────────────────┐
                 │  catalog.ts   — SINGLE source of truth: every feature + every     │
                 │                 SCREEN (overlay/tab/state vector)                  │
                 │     │                                  │                           │
                 │     │ consumed by                      │ consumed by               │
                 │     ▼                                  ▼                           │
                 │  run.ts (LIVE)                    tour.test.tsx (VITEST)           │
                 │  control.ts → window.__aegisAutopilot   coverage.test.ts (GUARD)   │
                 └───────────┬───────────────────────────────────────────────────────┘
                             │ real aegis IPC  +  dev-only Rust cmds
                             ▼
   scripts/autopilot/run-autopilot.sh ──launches──► npm run tauri:dev (real core)
        │  disposable profile, fixture server, VITE_AEGIS_AUTOPILOT=1
        │  polls report ◄── src-tauri/src/autopilot.rs (#[cfg(debug_assertions)]):
        │                      write report, screenshot (spectacle), signal done
        ▼
   prints summary + HTML gallery path; exit code = pass/fail
```

### A. `src/autopilot/catalog.ts` — single source of truth

A typed list plus a `SCREENS` enumeration.

```ts
type ScreenId = 'home' | 'settings:appearance' | … | 'settings:data'
              | 'sidebar:history' | 'sidebar:saved' | 'downloads' | 'favoritesManager'
              | 'errorOverlay' | 'safetyInterstitial' | 'permissionPrompt'
              | 'confirmDialog' | 'shieldPopover' | … ;

interface FeatureCheck {
  id: string;            // stable, e.g. 'adblock.toggle'
  domain: keyof AegisApi | 'ui';
  title: string;
  screen?: ScreenId;     // where it's shown, for the UI walk + screenshot grouping
  exercise(api: AegisApi): Promise<CheckObservation>;  // calls real IPC, returns observed result
}

export const CATALOG: FeatureCheck[];
export const SCREENS: ScreenSpec[];   // each: { id, show(control), combos? }
```

`exercise(api)` is written to be **backend-agnostic**: it performs calls and returns
what it observed. The live runner passes the **real** `aegis`; the vitest suite passes
a mock. Assertions that hold regardless of backend live in the runner; backend-specific
assertions (e.g. "real block count rose") are tagged live-only.

### B. `src/autopilot/run.ts` — the live autopilot

Activated **only** from `src/main.tsx`:

```ts
if (import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT) {
  import('./autopilot/run').then((m) => m.runAutopilot());
}
```

In a production `tauri build`, `import.meta.env.DEV` is the literal `false`, so Rollup
dead-code-eliminates the branch **and** the dynamic import — the autopilot never ships.

The runner:

1. **Screen walk** — for each `SCREENS` entry, drive the control surface to show it,
   call the dev-only screenshot command, record.
2. **Feature exercise** — run each `CATALOG.exercise(aegis)` against the real core;
   record pass/fail + observation.
3. **End-to-end inductions** — navigate the local ad-laden fixture page (http) and
   assert the real adblock block-count rose; navigate a guaranteed-bad URL and assert
   the real ErrorOverlay; etc. Where a real event is infeasible/flaky (malware
   interstitial, permission prompt), drive the overlay via the control surface for the
   screenshot and tag the step `visual` (not a core assertion).
4. **Emit** — write `report.json` + `report.html` (screenshot gallery) via the
   dev-only Rust command, then signal completion.

Each result is tagged `core` (asserted against the real backend) or `visual` (UI state
shown for a screenshot only) so the report never overstates what was verified.

### C. `src/autopilot/control.ts` — the control surface

`App` (in dev only) registers `window.__aegisAutopilot` with imperative setters that
call the **same** setState handlers the real buttons use — e.g. `openSettings(tab)`,
`closeSettings`, `openDownloads`, `openManager`, `toggleSidebar(open, tab)`,
`setShield(open)`, `enterFullscreen` / `exitFullscreen`, `setTheme(light|dark)`,
`showError(payload)`, `showInterstitial(payload)`, `showPermissionPrompt(payload)`,
`showConfirm(msg)`. This reaches every screen deterministically without selector
brittleness, while still exercising the real React handlers.

### D. `src-tauri/src/autopilot.rs` — dev-only Rust support

Gated `#[cfg(debug_assertions)]`; the IPC dispatcher registers its channels only under
that cfg, so release builds don't even compile it. Commands:

- `autopilot_screenshot(name)` — `spectacle -a -b -n -o <out>/shots/<name>.png` (active
  window). Best-effort: failure logs a warning, doesn't fail the step.
- `autopilot_write_report(json)` — write `report.json` / `report.html` to the output dir.
- `autopilot_done(exitOk)` — write a sentinel the launcher polls.

### E. `scripts/autopilot/run-autopilot.sh` — the Linux launcher

1. Detect `$DISPLAY` / `$WAYLAND_DISPLAY`. If absent: proceed with the functional tour
   but record `screenshots: skipped (no display)` (no silent cap).
2. Create a disposable profile dir; set `XDG_DATA_HOME` / `XDG_CONFIG_HOME` (and any
   other vars the store path needs — to be confirmed in implementation) to it.
3. Start the local fixture server (tiny static http server serving an ad-laden page,
   since the adblock probe must be http not file://).
4. Export `VITE_AEGIS_AUTOPILOT=1` + `AEGIS_AUTOPILOT_OUT=<rundir>`; launch
   `npm run tauri:dev` in the background, teeing logs.
5. Poll for the sentinel/report with a watchdog timeout (kill + fail on timeout).
6. Read `report.json`; print colored summary (pass/fail/skip counts, failure detail,
   gallery path).
7. Tear down app + fixture server + temp profile. Exit nonzero on any failure.

A companion `scripts/autopilot/fixture-server` (or reuse an existing fixture) serves the
ad page. Windows/macOS/Android launchers are documented as thin follow-ons.

### F. `src/autopilot/tour.test.tsx` — exhaustive vitest suite

Mounts the real `<DesktopApp/>` and `<MobileApp/>` with a mock `aegis`. For each
`SCREENS` entry and each `CATALOG.exercise(mock)`:

- asserts the screen renders without crashing,
- asserts the expected IPC method fired with the right shape,
- walks the meaningful state **combinations** (see Coverage scope) the per-component
  tests can't reach.
  Runs in the vitest `dom` project under `npm test`. Complements, not duplicates, the
  existing ~50 per-component tests (this is the integration/combination layer).

### G. `src/autopilot/coverage.test.ts` — the drift guard

Imports `IPC` (channel list), `TAB_ORDER` (Settings tabs), and the `SCREENS` list, and
asserts every channel / tab / overlay has a catalog or screen entry — minus a small,
explicitly-commented allowlist for intentionally-untested internals. **Fails the build**
when a feature is added without coverage. This is the enforcement mechanism behind "keep
the scripts current."

### H. CLAUDE.md updates

- **Root `CLAUDE.md`**: a living-docs convention — "The autopilot feature catalog
  (`src/autopilot/catalog.ts`) and its test scripts are kept current with every feature;
  the drift-guard test (`src/autopilot/coverage.test.ts`) enforces it. When you add a
  feature (IPC channel, Settings tab, overlay), add its catalog entry in the same
  commit." Plus a short "Autopilot" subsection under Commands with how to run it.
- **`src/CLAUDE.md`**: document `src/autopilot/` (catalog, run, control, tests) and the
  `window.__aegisAutopilot` dev-only control surface.
- **`src-tauri/CLAUDE.md`**: document the `#[cfg(debug_assertions)]` autopilot commands.
- **`scripts/CLAUDE.md`**: document `run-autopilot.sh` + the fixture server.

## Data flow

```
launcher.sh
  → sets XDG_* (disposable profile) + VITE_AEGIS_AUTOPILOT=1 + AEGIS_AUTOPILOT_OUT
  → npm run tauri:dev  (real Rust core boots; renderer served by Vite)
       main.tsx: import.meta.env.DEV && VITE_AEGIS_AUTOPILOT  → import run.ts
       App mounts → registers window.__aegisAutopilot (dev only)
       run.ts:
         for each SCREEN:   control.show()  → autopilot_screenshot(name)
         for each FEATURE:  exercise(aegis) → real Rust core → record
         inductions:        navigate fixture/bad URL → assert real outcome
         autopilot_write_report(json)  → autopilot_done(ok)
  → launcher polls sentinel → reads report.json → prints summary → teardown → exit code
```

## Two safety properties

- **Disposable profile** — autopilot CRUD hits a throwaway data dir, never real user
  data. Exact store-path resolution to be confirmed in implementation (Linux `XDG_*`).
- **Never in production** — belt-and-suspenders: Vite DCE on `import.meta.env.DEV`
  (renderer) **and** `#[cfg(debug_assertions)]` (Rust commands).

## Coverage scope ("every combination", honestly)

Full Cartesian is thousands of states. Covered:

- **Every** screen / overlay / Settings tab (12) / sidebar tab (2) individually.
- **Meaningful pairwise combos**: theme (light/dark) × each modal; sidebar-open ×
  settings-open; fullscreen; adblock on/off × shield popover; the four event-driven
  overlays (error, crash, safety interstitial, permission prompt).
- **Every** IPC feature-domain exercised against the real core (live) and asserted
  against the mock (vitest).
  The report states this scope explicitly; it does not claim exhaustive Cartesian coverage.

## Testing / verification of the harness itself

- `npm test` includes `tour.test.tsx` + `coverage.test.ts` (both must pass).
- The live autopilot is verified by running `scripts/autopilot/run-autopilot.sh` on this
  Linux machine with a display: report shows all `core` checks passing and a populated
  screenshot gallery. (This is the on-hardware proof, per the project's verify-don't-
  guess rule.)
- Production-exclusion verified by grepping a `tauri build` bundle for autopilot symbols
  (must be absent).

## Open items to resolve during implementation

- Exact disposable-profile mechanism: confirm where the JSON stores resolve their path
  and that `XDG_DATA_HOME` / `XDG_CONFIG_HOME` relocates them on Linux.
- The fixture ad page: reuse the existing live-testing probe page if one exists, else a
  minimal new static page referencing a known-blocked ad domain.
- Confirm the exact `TAB_ORDER` / `SettingsTab` export names and the `SCREENS` ↔
  component mapping when wiring the control surface.
