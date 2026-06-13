# Aegis Tauri Phase 0 — Verification & Findings

**Date:** 2026-06-13
**Branch:** `feat/tauri-migration`

## Verified (with evidence)

| Exit criterion | Result | Evidence |
|---|---|---|
| Toolchain installed | ✅ | cargo 1.96.0, webkit2gtk 2.52.3, Tauri CLI 2.11.2 |
| `src-tauri` scaffold + Rust core compiles | ✅ | `cargo build` exit 0 (full dep tree + `unstable` feature) |
| Renderer reused via Tauri seam | ✅ | `npm run build:renderer` (1654 modules); **the full React chrome renders in Tauri** (screenshot) driven through the `ipc` dispatcher |
| No regression to Electron app/tests | ✅ | `npm test` 952/952; Electron untouched (Vite alias swaps only the Tauri build) |
| Content webview navigates to an arbitrary URL | ✅ (functionally) | `nav.navigate` dispatch loaded `https://example.com`; address bar updated via `nav.state` events |
| `cargo build` clean | ✅ | exit 0 |

The architectural bet is **proven**: the reused React UI runs on Tauri at runtime, the `AegisApi`-over-`invoke`/`listen` seam works, and a real content webview navigates external pages driven by the actual command path.

## BLOCKER FOUND — Tauri multiwebview positioning is broken on Linux

**Symptom:** the content webview does not honor its `set_bounds(0,96,1280,704)`. Diagnosed with a
full-viewport marker page: the content webview's `(0,0)` renders at screen `y≈408`, height `≈392`
(≈ the bottom half), with the chrome taking the top half — a **vertical stack**, not an overlay.

**Root cause (verified in `wry-0.55.1/src/webkitgtk/mod.rs`):** the window's webview container is a
vertical `gtk::Box` (line 239). Child webviews added via `Window::add_child` are packed into that
box and stack vertically; the requested bounds are ignored. wry *does* position correctly when the
container is a `GtkFixed` (`.put(webview, x, y)`, lines 602–620), but the default window does not
use one. This is the **open, unfixed** upstream bug
[tauri#10420](https://github.com/tauri-apps/tauri/issues/10420) /
[#13071](https://github.com/tauri-apps/tauri/issues/13071), reproduced on Wayland/KDE.

**Scope:** Linux/webkit2gtk only. Windows (WebView2) and macOS (WKWebView) multiwebview position
correctly. **Our Rust code is correct** — the logged bounds are right at every stage; the defect is
in Tauri's GTK layer.

**Impact:** the chrome-over-content composition is the core browser-shell mechanic. On Linux it is
currently broken without a workaround. The user's primary dev platform is Linux, so this can't be
deferred.

## Options (decision needed)

- **A. GTK workaround** — `with_webview` to access the webkit2gtk widget and force absolute
  positioning (reparent into a `GtkFixed`, or drive the X11 child window). Keeps the one-codebase
  multiwebview architecture; fragile, version-specific, uncertain effort.
- **B. Single content webview + separate overlay chrome window** — avoid multiwebview; content is
  the main window, chrome a frameless transparent window docked on top. Wayland restricts
  app-driven window positioning, so risky on the user's compositor.
- **C. Full-window mode-switch on Linux** — show chrome OR content full-window and toggle, until
  upstream fixes #10420. Robust + simple, but no persistent toolbar over content (degraded browser UX).

`nav.rs`/`view.rs`/`lib.rs` set bounds correctly and are committed as-is; whichever option is chosen
adapts the Linux presentation layer on top of them.
