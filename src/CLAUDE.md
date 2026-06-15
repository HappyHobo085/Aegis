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

- **Chrome overlay z-order.** The content webview is opaque and on top, so
  full-window chrome (Settings, Downloads, error/crash, safety interstitial,
  confirm dialog, permission prompt, ad-block shield popover) renders *behind* the
  page unless raised. `App.tsx` tracks the union of active overlays and calls
  `aegis.view.setChromeOverlay(viewId, active)`. **If you add a new full-window
  overlay, add it to that union in `App.tsx` or it will render behind the page.**
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
