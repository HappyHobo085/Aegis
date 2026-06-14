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
├── index.css         # global dark theme + chrome layout (incl. .aegis-mobile two-row toolbar)
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
  instead of `invoke`, and sets the `.aegis-mobile` class for the two-row toolbar.

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
  settings, subscriptions, customFilters, downloads, permissions, update, safety).
  Components stay presentational; state + IPC wiring lives in the hook.

## Tests

`*.test.tsx` / `*.test.ts` are co-located. They run in the vitest **jsdom** project
(`include: src/**/*.test.{ts,tsx}`). Tests mock the `aegis` object — no real IPC.
Run the whole suite with `npm test` from the repo root.
