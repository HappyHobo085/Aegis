# Phone safe-zone insets + fullscreen fixes — design

**Date:** 2026-06-24
**Status:** Approved (design); ready for implementation planning.
**Scope:** Android phone chrome safe-area handling on all four edges; truly
immersive mobile fullscreen; real OS-window fullscreen on desktop.

---

## 1. Problem

On the phone, Aegis chrome and the browsed page are not reliably confined to the
device **safe area** when **not** in fullscreen, and "fullscreen" is half-implemented
on both phone and desktop. Four concrete, code-verified defects:

1. **Reused desktop modals go edge-to-edge on mobile.** `SettingsModal` and the
   Downloads modal reuse the desktop markup; on `.aegis-mobile` the CSS forces
   `.settings-modal__content` / `.downloads-modal` to `width/height: 100%` with **no
   safe-area padding** (`src/index.css:4341-4361`). The header draws up under the status
   bar (too high) and the body down under the navigation bar (too low). This is the
   originally reported symptom ("opening settings goes too high and too low on screen").
   The purpose-built `.mobile-sheet` (`src/index.css:4248-4257`) *does* pad top/bottom —
   the reused modals were simply never given the same treatment.

2. **Left/right insets are never captured.** `MainActivity.kt`'s insets listener reads
   only `WindowInsetsCompat.Type.systemBars()` and stores `bars.top` / `bars.bottom`,
   pushing only `--aegis-inset-top` / `--aegis-inset-bottom`
   (`MainActivity.kt:465-475`). Nothing handles a side navigation bar (landscape),
   punch-holes, or curved edges, and no `windowLayoutInDisplayCutoutMode` is set, so
   side cutouts are not reported as insets.

3. **Mobile "fullscreen" is not immersive.** The chrome-hide fullscreen
   (`MainActivity.kt setFullscreen`, `:814-817`) only zeros the content margins — it does
   **not** hide the Android status/navigation bars. The HTML5-video path
   (`onShowCustomView`, `:277-281`) *does* hide them via
   `WindowInsetsControllerCompat.hide(systemBars())`; the chrome-hide fullscreen never
   adopted that. The user wants fullscreen to hide the phone's nav + status bars.

4. **Desktop fullscreen never touches the OS window.** `view.setFullscreen`
   (`src-tauri/src/view.rs:281-285`) only relayouts the content webview; there is no
   `Window::set_fullscreen` call anywhere in `src-tauri/`. The app window keeps its
   titlebar and stays windowed (the reported desktop symptom: "OS window not fullscreen").

## 2. Core principle

> **Not fullscreen → all phone UI (Aegis chrome *and* the browsed page) stays inside the
> safe area on all four edges. Fullscreen → the system bars are hidden, so the page
> legitimately owns the entire screen.**

This single rule ties the four parts together. The "full-bleed" size is *only* correct
in fullscreen, where there are no system bars to overlap.

## 3. Decisions (locked during brainstorming)

- **Mechanism:** extend the existing per-surface CSS-inset pattern (push
  `--aegis-inset-*` vars from native; each surface pads itself). *Not* the alternative of
  insetting the whole chrome webview natively — that is a larger retrofit of the established
  inset contract with higher regression risk.
- **Page edges:** inset the browsed page too (all four edges), so in landscape / on
  side-cutout / curved devices the page never sits under a side bar or notch — consistent
  with how top/bottom already inset the page.
- **Edges covered:** all four (top, bottom, left, right).

## 4. Design

### Part 1 — Native inset capture (Android, `src-tauri/gen/android/.../MainActivity.kt`)

- **Cutout mode.** In `onCreate`, after `enableEdgeToEdge()`, set
  `window.attributes.layoutInDisplayCutoutMode`. The app's `minSdk = 24`, so gate by
  `Build.VERSION.SDK_INT`: API ≥ 30 → `LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS` (covers every
  edge incl. landscape); API 28–29 → `LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES` (the
  cutout API floor); below 28 there are no display cutouts, so no action. This makes the
  cutout be reported as an inset rather than letterboxed.
- **Capture all four insets.** In the `setOnApplyWindowInsetsListener` callback
  (`:465-475`), read the **union** of system bars and the display cutout:
  `insets.getInsets(WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout())`.
  Store four fields — `statusTop`, `navBottom`, plus new `sideLeft`, `sideRight` (mirroring
  the existing `@Volatile var statusTop/navBottom` at `:92-93`).
- **Push four CSS vars.** Extend the `evaluateJavascript` payload to also set
  `--aegis-inset-left` and `--aegis-inset-right` (px ÷ density), alongside the existing
  top/bottom.
- **Inset the page horizontally.** In `applyContentMargins()` (`:118-125`) add
  `p.leftMargin = if (fullscreen) 0 else sideLeft` and
  `p.rightMargin = if (fullscreen) 0 else sideRight`. Top/bottom keep their existing
  `(if fullscreen 0 else chrome) + inset` form; because the inset is now the
  systemBars∪displayCutout union, a top/bottom cutout is also covered.

  *Note on the side slivers:* the content WebView sits above the chrome webview in the
  content region. Adding left/right margins exposes a thin strip of the chrome webview on
  each side — but that strip is exactly where the side system bar / cutout sits, which the
  OS paints over anyway, so it is not visible chrome. No additional masking needed.

### Part 2 — CSS consumption (`src/index.css`, all `.aegis-mobile`-scoped)

Apply the four `--aegis-inset-*` vars (each with an `env(safe-area-inset-*)` fallback, to
preserve the desktop-browser/iOS-WebKit path) to every full-window mobile surface:

- **`.mobile-topbar`** (`:4158-4168`) — replace the hardcoded
  `calc(8px + env(safe-area-inset-right/left))` with
  `calc(8px + var(--aegis-inset-right, env(safe-area-inset-right)))` (and left). Top padding
  already uses the var.
- **`.mobile-bottombar`** (`:4214-4228`) — add `padding-left`/`padding-right` from the
  side vars. `box-sizing: content-box` with `left:0; right:0` keeps the bar pinned to the
  viewport width and pushes the buttons inward — correct.
- **`.mobile-sheet`** (`:4248-4257`) — add `padding-left`/`padding-right` (already has
  top/bottom). Covers History / Saved / Tabs switcher / Menu sheets.
- **`.aegis-mobile .settings-modal__content`** (`:4344-4350`) and
  **`.aegis-mobile .downloads-modal`** (`:4355-4361`) — add four-edge padding
  (`padding: var(--aegis-inset-top) var(--aegis-inset-right) var(--aegis-inset-bottom)
  var(--aegis-inset-left)`, each with `env()` fallback). The dim scrim (`.settings-modal`
  / `.downloads-modal__scrim`, `inset:0`) stays full-bleed behind the bars; only the
  interactive card content is confined to the safe area. **This fixes the reported bug.**
- **Other full-window surfaces reachable on mobile** — audit and pad the same way where
  they render edge-to-edge: **SafetyInterstitial**, **error overlay**, **crash overlay**,
  **Onboarding**, and the **FindBar** as it renders in the mobile shell. Centered dialogs
  (**confirm**, **permission prompt**) render as constrained cards already inside the
  viewport; verify and only pad if a card can reach an edge. The implementation plan will
  enumerate the exact selectors after reading each component's CSS.

### Part 3 — Mobile fullscreen becomes truly immersive (`MainActivity.kt setFullscreen`)

Mirror the HTML5-video path inside `setFullscreen(on)` (`:814-817`):

```kotlin
@JavascriptInterface
fun setFullscreen(on: Boolean) = runOnUiThread {
  fullscreen = on
  WindowInsetsControllerCompat(window, window.decorView).apply {
    systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
    if (on) hide(WindowInsetsCompat.Type.systemBars())
    else    show(WindowInsetsCompat.Type.systemBars())
  }
  applyContentMargins()
}
```

When the bars hide, the insets listener fires with zero insets, so `applyContentMargins`
zeros every margin and the page fills the whole display; a swipe reveals the bars
transiently. On exit the bars return and the insets are restored. This is independent of
the video `onShowCustomView` path (which continues to work for HTML5 fullscreen).

### Part 4 — Desktop fullscreen drives the real OS window (`view.rs` + `linux_layout.rs`)

- In the `view.setFullscreen` handler (`view.rs:281-285`), after the existing
  `update(app, |l| l.fullscreen = on)`, add a desktop-gated OS-window call:

  ```rust
  #[cfg(desktop)]
  if let Some(window) = app.get_window("main") {
      let _ = window.set_fullscreen(on);
  }
  ```

  `Window::set_fullscreen` is a backend call, so **no Tauri capability change** is needed
  (`capabilities/default.json` stays as-is). This hides the titlebar and fills the monitor
  on Linux / Windows / macOS.
- In `linux_layout::exit_fullscreen` (Esc / floating exit button, `linux_layout.rs:257`)
  also call `window.set_fullscreen(false)` directly. The existing `view.fullscreen`
  event → React `setFullscreen(false)` → `aegis.view.setFullscreen` round-trip would also
  clear it, but the direct call removes the dependency on the round-trip and is idempotent.
- **Geometry:** `apply_inset` reads `window.inner_size()`; the OS fullscreen resize is
  async, so the final content geometry settles via the existing resize → relayout path
  (Linux `size-allocate`; Windows/macOS resize). Verify live on Linux that entering and
  exiting fullscreen leaves the content correctly sized.

## 5. Cross-platform parity

Per the repo's "all platforms on the same level" rule:

- **Fullscreen genuinely takes over the screen everywhere:** Android via immersive bar
  hiding (Part 3); Linux/Windows/macOS via OS-window `set_fullscreen` (Part 4) — Windows
  and macOS compile/CI-verified, Linux live-verified.
- **All non-fullscreen phone UI sits in the safe area** (Parts 1–2). Desktop has no system
  bars or cutouts, so the inset work is correctly mobile-only (the CSS is `.aegis-mobile`-
  scoped; desktop rendering is unchanged).
- **iOS:** not started (no macOS/Xcode); inherits the CSS `env()` fallbacks when it exists.

## 6. Testing

Per the autopilot gate (`CLAUDE.md` "update the autopilot tests BEFORE pushing to main"):

- **vitest**
  - Source-level drift guard: assert each listed mobile selector in `src/index.css`
    references the `--aegis-inset-*` vars (a regex/string check over the stylesheet), so a
    future edit that drops the inset on a surface fails the build.
  - Mobile interaction tour: open Settings and Downloads in the mobile shell and assert
    they render (extends the existing `tour.mobile` / `interactions.mobile` coverage).
- **Compile gates**
  - `cargo check --target aarch64-linux-android` and Kotlin `compileUniversalDebugKotlin`
    for the `MainActivity.kt` changes (both runnable on this Linux host).
  - `cargo check --target x86_64-pc-windows-gnu` + CI MSVC/macOS for the `set_fullscreen`
    addition.
- **Live autopilot (Linux)** — `bash scripts/autopilot/run-autopilot.sh`: expect
  `RESULT: … 0 failed` and `ad-block blocking (trace): PASS`. The `fullscreen` screen now
  genuinely fullscreens the dev window — confirm the screenshot step and exit still work;
  if OS-fullscreen disrupts the run, gate the autopilot's fullscreen step.
- **Device / GUI verifies (PENDING user):**
  - Android phone: Settings/Downloads confined to the safe area; immersive fullscreen
    hides the status + nav bars and a swipe reveals them; landscape and a side-cutout
    device respect the left/right insets.
  - Desktop: entering fullscreen makes the OS window take over the monitor (no titlebar),
    and exit restores the windowed state with correct content geometry.

## 7. Living-docs updates (same commit as the change)

- `src/CLAUDE.md` — the "Safe-area insets" note (mobile shell section) extends to four
  edges and the immersive-fullscreen behavior; note the reused desktop modals now carry
  insets on mobile.
- `src-tauri/CLAUDE.md` — the Android "Mobile chrome" + `applyContentMargins` notes gain
  the left/right + displayCutout capture and the immersive `setFullscreen`; add a note that
  desktop `view.setFullscreen` now drives `Window::set_fullscreen`.

## 8. Out of scope / non-goals

- No change to the desktop chrome layout or the `--aegis-inset-*` contract semantics
  (still "real OS inset in px, env() fallback").
- No new fullscreen keyboard shortcut (F11) — the existing toolbar button + Esc-exit are
  retained; an F11 binding is a possible later nice-to-have, not part of this work.
- No iOS implementation (hardware-gated).
- Android first-party-cookie / other documented private-mode limits are unrelated and
  untouched.
