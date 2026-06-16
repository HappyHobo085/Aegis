# Aegis — project guide

Aegis is a cross-platform, ad-blocking browser shell built on **Tauri 2** (a Rust
core) with a **React 19 + TypeScript** UI. Targets: Linux, Windows, macOS, and
Android (iOS is a future, macOS/Xcode-gated tier).

## Architecture in one picture

```
┌──────────────────────────── Tauri window ────────────────────────────┐
│  CHROME webview  = the React UI in src/  (toolbar, sidebar, modals)    │
│  CONTENT webview = the page the user is browsing (second webview)      │
└───────────────────────────────────────────────────────────────────────┘
        ▲  invoke('ipc', {channel, payload})   │  events (nav.state, …)
        │  ───────────────────────────────────▶ │ ◀───────────────────────
   src/lib/ipcClient.ts                      src-tauri/src/lib.rs  ipc()
```

- The **Rust core is NOT standalone** — Tauri serves the built React UI. From
  `src-tauri/tauri.conf.json`: `frontendDist: "../dist"` and
  `beforeBuildCommand: "npm run build:renderer"`. Deleting the frontend breaks
  the build. The frontend *is* part of the Rust implementation.
- Desktop runs **one chrome webview + one content webview per tab** via Tauri's
  unstable `Window::add_child`. The active tab's webview is visible; background
  tabs are hidden; idle tabs are discarded and reloaded on next activation.
  Android runs a **single** webview with a native Kotlin content `WebView`
  bridged as `window.AegisAndroid`.

## Folder map

| Folder       | What it is                          | Has its own CLAUDE.md |
|--------------|-------------------------------------|-----------------------|
| `src/`       | React renderer (the UI / "chrome")  | yes                   |
| `src-tauri/` | Rust core + native platform code    | yes                   |
| `shared/`    | `types.ts` — the IPC contract       | yes                   |
| `scripts/`   | npm-audit CI gate (Node ESM)        | yes                   |
| `.github/`   | CI workflows + Dependabot           | yes                   |
| `dist/`      | Vite build output (gitignored)      | generated, no docs    |
| `node_modules/` | npm deps (gitignored)            | generated, no docs    |

> **The `CLAUDE.md` files are living docs.** Every folder's `CLAUDE.md` (this one
> included) documents *current* behavior — when a change makes one stale, update it
> in the same commit. Treat them as part of the code, not a one-time snapshot.

## Commands

```bash
npm install            # install JS deps (Rust deps resolve on first build)
npm run tauri:dev      # run the app (Vite renderer + Tauri, hot reload)
npm test               # vitest: node project (shared/ + scripts/) + jsdom (src/)
npm run tauri:build    # build installers (AppImage/deb/nsis/app/dmg)
npm run android:dev    # Android emulator/device
npm run android:build  # release APK (signed with the debug key unless keystore.properties exists)
```

Native build deps: a Rust toolchain; on Linux, webkit2gtk/gtk dev packages.

## Conventions that matter everywhere

- **One IPC chokepoint.** All renderer→core calls go through `src/lib/ipcClient.ts`
  → `invoke('ipc', {channel, payload})` → the single `ipc()` command in
  `src-tauri/src/lib.rs`, which dispatches by `channel`. Channel names live in
  `shared/types.ts` (`IPC` const). Add a channel in three places: `shared/types.ts`,
  the Rust dispatcher, and `ipcClient.ts`.
- **Event names can't contain `.`** — Tauri 2 forbids dots in event names. The Rust
  side translates `.` → `:` when emitting (`emit_event` in `lib.rs`); the JS side
  translates back in `src/lib/tauriInvoke.ts`. Keep the logical names dotted in
  `shared/types.ts`; never emit a raw dotted name.
- **Don't guess — verify.** Per the repo owner's standing instruction, read the
  actual file/config/code before claiming behavior; run commands and report real
  output rather than assuming.
- **Always finish with all platforms being on the same version/level.** A feature or
  fix isn't done when it works on one platform — bring Linux, Windows, macOS, and
  Android to parity (iOS when it exists) before calling it complete. Don't leave a
  capability working on Linux with "Win/Android is a follow-up"; close the gap.

## Status (as of the Tauri migration branch)

Linux desktop is verified on real hardware. Windows desktop is verified on real
hardware (Windows 11): browses and ad-blocks — both the WebView2 network tier
(`adblock_win`) and the injected tier — with no crash, and the CI-built portable
exe behaves identically to a local build. (The shield block-*counter* is still
Linux-only; ad-block works on Windows, it just isn't counted on the badge — see the
adblock note in `src-tauri/CLAUDE.md`.) Android browses + ad-blocks + is secure
(verified on emulator). macOS compiles + bundles green in CI but is not yet
GUI-runtime-verified. iOS is unstarted (needs macOS + Xcode).
