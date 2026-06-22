# src/ — React renderer (the browser "chrome")

The React 19 + TypeScript UI that Tauri renders in the **chrome webview**: toolbar,
address bar, favorites bar, right-side sidebar, settings, modals, overlays. Built by
Vite into `../dist`, which Tauri serves. This folder reaches the Rust core through
exactly one module — see `lib/ipcClient.ts`.

## Layout

```
src/
├── index.html        # <div id="root">; loads main.tsx; viewport-fit=cover (mobile notches)
├── main.tsx          # mounts <App/> inside <ErrorBoundary> + StrictMode; imports index.css
├── App.tsx           # root shell: orchestrates chrome, overlays, sidebar, fullscreen z-order
├── index.css         # global dark theme + chrome layout (desktop chrome + .aegis-mobile shell)
├── components/       # presentational components + Settings tabs (+ co-located *.test.tsx)
├── hooks/            # one hook per feature domain (useNav, useAdblock, …) (+ tests)
└── lib/              # IPC client, address parsing, theme, toast, layout consts (+ tests)
```

## The backend boundary (read this first)

- **`lib/ipcClient.ts`** exposes the `aegis` object (typed by `AegisApi` in
  `shared/types.ts`) — every feature the UI can call. Each method is a Tauri
  `invoke('ipc', {channel, payload})`; each `onX(cb)` subscribes to an event.
- **`lib/tauriInvoke.ts`** is the low-level transport: `call(channel, payload)` and
  `on(event, cb)`. `on()` translates the event name `.` → `:` because **Tauri 2
  forbids `.` in event names** (the Rust side emits with `:`). Don't bypass this.
- **Android path:** when `window.AegisAndroid` is present (native Kotlin bridge,
  no Tauri), `ipcClient` routes nav + content-visibility calls to the bridge
  instead of `invoke`, and sets the `.aegis-mobile` class. On mobile `App` renders
  **`MobileApp`** (a dedicated touch shell) instead of the desktop chrome — see the
  Mobile shell section below.

Channel and event names, and all payload/return types, are defined once in
`shared/types.ts` (`IPC` const + interfaces). Treat it as the contract.

## Conventions & gotchas (verified in code)

- **Chrome overlay z-order (centralized compositor).** The content webview is opaque
  and on top, so full-window chrome must lower it. The decision is single-sourced:
  every content-hiding surface calls `useChromeSurface('<id>', active)`
  (`src/hooks/useChromeSurfaces.tsx`) to register itself while open; `App.tsx` derives
  `fullOverlayActive` from the registry and computes the content layout via
  `computeContentLayout` (`src/lib/contentLayout.ts`), mirrored on the Rust side by
  `view::content_visible`. **To add a new full-window overlay, call `useChromeSurface`
  in its component — there is no central union to update.** The sidebar (insets) and
  shield popover (dropdown) are NOT registry surfaces; they stay as direct `App` state.
  The `src/autopilot/compositor.test.tsx` drift guard fails the build if an overlay
  reachable via the autopilot control does not lower the content.
  `useChromeSurface` is a **no-op** outside a `ChromeSurfaceProvider` (so surfaces
  also rendered by the mobile shell, which has no provider, are safe); by contrast
  `useChromeSurfaceRegistry` throws outside a provider — do not call it from a
  component that may render in the mobile shell.
- **Sidebar is a right panel,** not an overlay: it calls `view.setSidebar(active,
  width)` so the page insets from the right and stays visible. Width is remembered
  in localStorage.
- **Content inset** is set deterministically from layout constants in `lib/layout.ts`
  (toolbar + favbar height), via `hooks/useContentInset.ts` — no DOM measurement.
- **One hook per domain** in `hooks/` (nav, adblock, history, saved, favorites,
  settings, subscriptions, customFilters, downloads, permissions, update, safety,
  **tabs**). Components stay presentational; state + IPC wiring lives in the hook.
- **`hooks/useTabs`** — owns `TabsState` (the ordered tab list), the active tab
  id, and per-tab nav-state + page titles. All chrome features (nav bar, adblock
  shield, overlays, inset sidebar) key on the active tab id.
- **`components/TabStrip`** — the top row of the chrome, rendered above the
  toolbar on desktop only (hidden on mobile via `.aegis-mobile`). Shows the tab
  list and drives `tabs.create`/`tabs.activate`/`tabs.close` etc.
- **`lib/layout.ts`** gained `TABSTRIP_H` (the pixel height reserved for the
  tab strip), used by `useContentInset` to keep the content webview positioned
  below it.

## Mobile shell (`components/mobile/`, Android)

On Android (`isMobile`, read from the `.aegis-mobile` class) `App` renders **`MobileApp`**
instead of the desktop chrome; the desktop body is unchanged (just renamed `DesktopApp`).
`MobileApp` reuses the existing hooks + presentational panels inside a touch shell:

- **`MobileTopBar`** — slim address bar (reused `AddressBar`) + reload/stop + a 24dp
  favourites strip (`MobileFavourites`), plus a **bottom-bar toggle** (chevron) and an
  **Enter fullscreen** (Maximize) button.
- **`MobileBottomBar`** — Saved / History / **Tabs (live count)** / shield / menu
  (thumb-reachable). Saved + History open their sheets directly; Tabs opens the switcher.
- **`MobileMenuSheet` / `MobileSheet`** — the ☰ drawer (now Back / Forward / Home /
  Bookmark / Downloads / Settings — Back/Forward moved here off the bottom bar) and a
  generic full-screen sheet hosting History/Saved; Settings/Downloads reuse their modals.
- **`MobileTabSwitcher`** — a vertical-list tab switcher sheet (`'tabs'`): one row per
  tab (page title, or host fallback), tap to switch, X to close, **+ New tab**.
- **Multi-tab wiring.** `MobileApp` uses `useTabs()` + `useNav(tabs.activeId)` (active-id
  keyed); **`useMobileTabSync`** diffs the registry's tabs state and drives the native
  per-tab bridge (`activateTab`/`closeTab`/`discardTab`) — it tracks the last-activated id
  (not an activeId diff) so the first tab still activates when `useTabs` resolves its
  EMPTY `{activeId:1}` seed into a real `activeId:1`. `window.__aegisOpenTab(url)` opens a
  **background** tab (`tabs.create(url, true)`) for native `target=_blank`/`window.open`.
  On Android the Rust core can't see the WebView title, so MobileApp relays the active
  tab's title into the registry via **`tabs.setTitle`** (guarded on the nav state's viewId)
  to keep the switcher labels accurate.
- **Sheets** (incl. the tab switcher) route through `view.setChromeOverlay` so the native
  content webview lowers. The native **Back** button precedence is: close an open sheet →
  exit fullscreen → page-back (`setBackInterceptActive` + `window.__aegisMobileBack`).
- **Chrome heights** live in `lib/layout.ts` (`MOBILE_ADDRESS_H` 48 / `MOBILE_FAV_H` 24 /
  `MOBILE_BOTTOMBAR_H` 56) and **must stay in sync with the content-WebView margins in
  `MainActivity.kt`**.
- **Bottom-bar toggle** and **fullscreen** (hide all chrome — desktop parity) call
  `setBottomBarHidden` / `setFullscreen` on the bridge; the native side shrinks the
  content webview's margins so the page reclaims the space.
- **Safe-area insets:** `env(safe-area-inset-*)` on Android WebView is only the display
  cutout, not the system bars, so `MainActivity` pushes the real status/nav insets as
  `--aegis-inset-top/bottom` CSS vars; the mobile bars use `var(--aegis-inset-*, env(...))`.
  `.mobile-bottombar` is `box-sizing: content-box` so the nav-inset padding extends it
  upward (the global reset is `border-box`).

## Tests

`*.test.tsx` / `*.test.ts` are co-located. They run in the vitest **jsdom** project
(`include: src/**/*.test.{ts,tsx}`). Tests mock the `aegis` object — no real IPC.
Run the whole suite with `npm test` from the repo root.

## Autopilot harness (`src/autopilot/`)

A dev-only test harness that drives the entire feature surface — IPC layer and UI
screens — through the real Rust core (live) or through mocks (vitest). **Never
compiled into production**: every public entry is gated behind
`import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT` in `main.tsx`, and
Vite dead-code-eliminates it on `build:renderer`.

### Files

- **`catalog.ts`** — `CATALOG: FeatureCheck[]`. Every IPC feature (nav, tabs, view,
  favorites, history, saved, settings, adblock, subs, customFilters, downloads,
  permissions, data, picker, update, safety, sync) has one entry with `id`, `domain`,
  `title`, `channels[]` (the `IPC.*` constants it exercises), and `exercise(api)` (an
  async function that calls the real or mocked `AegisApi`). An entry may also carry an
  optional **`verify(api)`** — a real **functional round-trip** that performs a user
  action, asserts the effect, and restores state (favorites add/update/reorder/remove,
  saved add + **tag** update/rename/delete, **history** navigate→remove→clear, ad-block
  enable + allowlist add/remove/clear, settings/customFilters get→set→restore, tabs
  create→close, nav navigate→poll, subs toggle, data export). `verify` runs **only in the
  live run** (`run.ts` gates it on `RunDeps.live`) on the disposable profile — so deletes/
  clears are safe — and is skipped under the vitest mock (which returns empty shapes).
  Also exports
  `UNTESTED_CHANNELS` — channels that exist in catalog entries but whose `exercise`
  bodies intentionally skip calling them live (destructive, OS-bound, or
  fire-and-forget). This set is enforcement documentation, not an escape hatch: the
  drift guard asserts every member also appears in some catalog entry's `channels`.
- **`screens.ts`** — `SCREENS: ScreenSpec[]`. Every reachable UI state: `home`,
  `sidebar:history`, `sidebar:saved`, `downloads`, `favoritesManager`,
  `settings:<tab>` (one entry per `SettingsTab` from `TAB_ORDER`), `shieldPopover`,
  `fullscreen`, `errorOverlay`, `crashOverlay`, `safetyInterstitial`,
  `permissionPrompt`, `confirmDialog`. Each entry declares how the live harness
  reaches it (`via: 'overlay' | 'settingsTab' | 'sidebarTab' | 'event' | 'state'`),
  consumed by `reach.ts`.
- **`control.ts`** — `AutopilotControl` interface + `installAutopilotControl` /
  `getAutopilotControl`. `DesktopApp` calls `installAutopilotControl` in a `useEffect`
  when running in dev, exposing `window.__aegisAutopilot` so the runner can reach every
  overlay without selector brittleness. The same `setState` handlers the real buttons
  use. The global is never written in production.
- **`reach.ts`** — `reachScreen(control, screen, opts)` / `leaveScreen(control, screen)`.
  Drives `control` (and emits dev events for `'event'`-type screens) to reach a given
  `ScreenSpec`, then tears it down after the screenshot. Adapts to the `via` field.
- **`run.ts`** — `runAutopilot(partial?)`. The orchestrator: walks every `SCREEN`
  (reach → screenshot → leave), exercises every `CATALOG` entry against the real core,
  runs each entry's optional `verify(api)` functional round-trip, then the ad-block
  induction — an A/B navigation of the fixture (ad-block OFF then ON) that records the
  live shield count (an honest *skip* when it doesn't rise: well-known hosts are blocked
  by the WebKit content filter before the counter signal fires; blocking itself is proven
  by the launcher's A/B trace check — `summarize.mjs`). Finally calls
  `devEmit.writeReport` + `devEmit.done`. Dependency-injected
  via `RunDeps` so vitest can pass mocks; `liveDeps()` wires the real `aegis` API and
  `devEmit.*` calls. `hasDisplay` (from `VITE_AEGIS_AUTOPILOT_DISPLAY`) controls
  whether screenshots are attempted.
- **`devEmit.ts`** — thin wrappers over the four dev-only Rust commands:
  `screenshot(name)` → `invoke('autopilot_screenshot', …)`,
  `writeReport(report, html)` → `invoke('autopilot_write_report', …)`,
  `done()` → `invoke('autopilot_done')`,
  `emitEvent(channel, payload)` → `invoke('autopilot_emit_event', …)`.
  These commands are NOT in the production `ipc` dispatcher; see `src-tauri/CLAUDE.md`.
- **`report.ts`** — `Report` / `StepResult` types, `summarize`, `renderReportHtml`.
  Produces the JSON report and the standalone HTML screenshot gallery.

### Interaction catalog (`interactions/` + `interactionCtx.ts`)

A third catalog — complementing `catalog.ts` (IPC) and `screens.ts` (UI states) — that
focuses on **user interaction gestures**: what a user taps or types to trigger a feature,
and what the resulting DOM / call state should be.

- **`interactions/`** — the catalog, split **per domain** (was one ~3700-line file). A
  barrel `index.ts` concatenates the per-domain spec arrays into `INTERACTIONS:
  InteractionSpec[]` and re-exports `INTERACTIVE_CONTROLS` + the public types, so
  importers of `./interactions` resolve unchanged. Layout:
  - `index.ts` — combines the domain arrays into `INTERACTIONS`; re-exports types +
    `INTERACTIVE_CONTROLS`. **The single entry point** — keep importing `./interactions`.
  - `types.ts` — `InteractionLayer`, `CallLog`, `InteractionCtx`, `InteractionSpec`.
  - `helpers.ts` — shared `emitNavState`, `fireInputChange`, `BASE_NAV`.
  - `controls.ts` — `INTERACTIVE_CONTROLS` (the canonical control-id registry).
  - one file per domain group, each exporting a `*_INTERACTIONS: InteractionSpec[]`:
    `toolbar.ts` (toolbar + shieldPopover), `tabs.ts` (tabs + keyboard),
    `favorites.ts` (favbar + favManager), `sidebar.ts` (history + saved),
    `settings.ts` (every settings tab), `overlays.ts` (downloads/confirm/error/
    crash/safety/permission/redirect), `edge.ts`, `combo.ts`, `mobile.ts`.
  - **Add a spec to its domain file.** A brand-new domain gets a new file + a one-line
    spread in `index.ts`. A new control id still goes in `controls.ts` (see below).

  Each `InteractionSpec` has:
  - `id` — unique dot-namespaced string (e.g. `toolbar.addressBar.navigate`,
    `mobile.bottomBar.saved`)
  - `domain` — grouping key (e.g. `toolbar`, `mobile.bottomBar`)
  - `description` — human-readable label
  - `screen: ScreenId` — the desktop screen the spec starts from
  - `layers: InteractionLayer[]` — `'vitest'` | `'live'` | both. All mobile-only
    specs are `['vitest']` since the live harness drives only the desktop shell.
  - `mobile?: boolean` — `true` means the spec can (or must) run in the mobile
    shell. Cross-platform specs (e.g. address-bar, reload) carry `mobile: true` and
    appear in both tours. Mobile-only specs (domain `mobile.*`) carry `mobile: true`
    and are EXCLUDED from the desktop tour.
  - `run(ctx)` — async gesture: fires the interaction (click, type, etc.)
  - `assert(ctx)` — async assertion: returns a truthy string on success, throws on failure
  `INTERACTIVE_CONTROLS` is the canonical string array of every interactive control id.
  The drift-guard test asserts every entry has at least one `InteractionSpec`.
  **Add a new control to `INTERACTIVE_CONTROLS` in the same commit as its spec.**

- **`interactionCtx.ts`** — `InteractionCtx` interface + `makeVitestCtx(container,
  aegis, reachFn)`. Provides:
  - `byRole(role, name)` — `container.querySelector([role="…"][aria-label~="…"])` helper
  - `click(el)` — `userEvent.click(el)` wrapped in `act()`
  - `reach(screen)` — calls `reachFn` (desktop: `reachScreen`; mobile: no-op)
  - `calls` — `CallLog` facade over the mocked `aegis` (checked via `.called(channel)`,
    reset via `.reset()`)
  - `emitNavState(state)` — fires `flushSync(() => navStateCallback(state))`; the
    callback is captured from `aegis.nav.onState.mock.calls[0][0]` at creation time
  - `emitTabsState(state)` — same pattern via `aegis.tabs.onState.mock.calls[0][0]`

  **React 18 Strict Mode + async-mock ordering gotcha** (discovered during Task 10):
  `useNav` calls `aegis.nav.getState(viewId).then(setState)` on mount. Under Strict
  Mode this fires twice. The second async `getState().then()` resolves in the microtask
  queue AFTER the `useEffect` from the second mount runs, which means calling
  `emitNavState` alone may be immediately overwritten by the pending `getState()`
  promise. The safe pattern for state-seeding in mobile interaction specs is:
  - For tab-count state: call `emitNavState` FIRST (flushes pending microtasks), then
    `emitTabsState` in the same async `act()` body.
  - For nav-property state (canGoBack/canGoForward): open the interactive sheet FIRST
    (so it is already mounted), THEN call `emitNavState` to re-render with the new state.
  This ordering is enforced in all mobile specs that need non-default state.

### Tests in this folder

- **`tour.test.tsx`** — exhaustive vitest desktop tour. Renders the real `<App/>`
  with the mocked `aegis` API, walks every SCREEN via `reachScreen()` (asserting
  no crash), and exercises every CATALOG entry. `runAutopilot()`'s end-to-end
  orchestration (reach → screenshot → leave) is covered by `run.test.ts`.
- **`tour.mobile.test.tsx`** — same tour for the mobile shell (`MobileApp`).
- **`interactions.test.tsx`** — **desktop interaction tour**. Renders `<App/>` (desktop
  shell), reaches each spec's declared screen via `reachScreen()`, runs `spec.run()`, and
  asserts via `spec.assert()`. Filters `INTERACTIONS` to vitest-layer specs whose domain
  does NOT start with `mobile.` (mobile-only specs are excluded; cross-platform specs
  with `mobile: true` on a non-mobile domain ARE included).
- **`interactions.mobile.test.tsx`** — **mobile interaction tour**. Sets `.aegis-mobile`
  on `<html>` BEFORE importing `App` so `isMobile=true` and `MobileApp` renders. Runs
  every spec where `mobile === true && layers.includes('vitest')`. No `reachScreen` call
  is needed; every mobile spec reaches its sheet via DOM clicks in its `run()` body
  (MobileApp has no `AutopilotControl` surface).
- **`interactions.coverage.test.ts`** — **interaction drift guard** (3 assertions):
  1. All spec ids in `INTERACTIONS` are unique.
  2. Every spec has a valid `screen` (from `SCREENS`) and at least one `layer`.
  3. Every string in `INTERACTIVE_CONTROLS` has at least one `InteractionSpec` whose
     `id` starts with that control string.
  Fails the build when you add a control to `INTERACTIVE_CONTROLS` without a spec.
- **`coverage.test.ts`** — **IPC drift guard**. Asserts every `IPC.*` channel exported
  from `shared/types.ts` appears in `CATALOG[*].channels` (failing the build when a new
  feature is added without a catalog entry). Also asserts every `UNTESTED_CHANNELS`
  member appears in some catalog entry's `channels`.
- **`control.test.ts`**, **`reach.test.ts`**, **`devEmit.test.ts`**,
  **`run.test.ts`**, **`report.test.ts`**, **`screens.test.ts`**,
  **`registration.test.tsx`** — unit tests for each individual module.

### Bootstrap (main.tsx)

```ts
if (import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT) {
  // Give the app a moment to mount + register its control surface, then run.
  setTimeout(() => {
    void import('./autopilot/run').then((m) => m.runAutopilot());
  }, 1500);
}
```

The 1 500 ms delay lets `App` mount and register `window.__aegisAutopilot` before the
runner tries to use it.
