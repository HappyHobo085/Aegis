# src-tauri/ — Rust core + native platform code

The Tauri 2 backend: window/webview management, the IPC dispatcher, data
persistence (JSON stores), the multi-platform ad-block + malware engines, and
native code for Linux (GTK/WebKit), Windows (WebView2 COM), and Android (JNI/Kotlin).

Crate: binary `app` (`src/main.rs` → `app_lib::run()`); library `app_lib` (`src/lib.rs`).

## Layout

```
src-tauri/
├── src/                # Rust source (modules below)
├── capabilities/       # Tauri permission grants (default.json)
├── gen/android/        # generated Android project + hand-written Kotlin bridge
├── icons/              # app icons (png/ico/icns)
├── resources/          # bundled filter lists (easylist.txt, malware-hosts.txt)
├── target/             # cargo build output (gitignored)
├── Cargo.toml          # deps, incl. platform-gated blocks
├── tauri.conf.json     # app config, CSP, bundle targets, updater endpoint+pubkey
└── build.rs            # delegates to tauri_build::build()
```

## IPC dispatcher pattern

All renderer calls land in **one** `#[tauri::command] ipc(channel, payload)` in
`lib.rs`, which matches `channel` (names from `shared/types.ts`) and routes to the
owning module. Events go out via `emit_event()`, which **translates `.` → `:`**
(Tauri 2 forbids dots in event names; the JS side reverses it). Never emit a raw
dotted event name.

## Module map (`src/*.rs`)

- **`lib.rs`** — app setup + `ipc()` dispatcher + `emit_event()`. Installs the
  rustls aws-lc-rs crypto provider once; sets Linux env workarounds (see gotchas).
- **`main.rs`** — thin entry; calls `app_lib::run()`.
- **`tab_registry.rs`** — pure (Tauri-free, fully unit-tested) tab state machine:
  lifecycle (`create`/`activate`/`close`/`reopen_closed`), pinned/reorder,
  per-tab back/forward history (`record_nav`/`go_back`/`go_forward`),
  time-based idle sweep (`sweep_idle`), session (de)serialization
  (`to_persisted`/`restore`). 24 unit tests.
- **`tabs.rs`** — Tauri layer over the registry: `tabs.*` IPC dispatch, applies
  spawn/close decisions to child webviews, the idle-sweep background thread
  (`start_idle_sweep`), `tabs.json` session persistence, `open_background`
  (called from `on_new_window` to open target=\_blank links as background tabs).
- **`nav.rs`** — content webview creation (`spawn_tab(id, url)`, replaces the
  old `spawn_content`), navigation callbacks (malware guard, HTTPS-Only upgrade),
  emits `nav.state`/`nav.failed`. Active webview now accessed via
  `active_content_label()`/`active_webview()` (refactored from the old single
  `CONTENT_LABEL` constant).
- **`view.rs`** — content webview geometry: insets, sidebar, fullscreen, overlay.
- **`data.rs`** — `data.export` / `data.import` (bundles all stores + settings).
- **Data stores** — `jsonstore.rs` (tiny JSON-array helper) backs `places.rs`
  (favorites + saved), `history.rs`, `downloads.rs`, `subs.rs` (filter
  subscriptions + fetch), `customfilters.rs`, `settings.rs`.
- **Ad-block (layered, platform-gated):**
  - `adblock.rs` — state machine (enabled + allowlist), `adblock.*` IPC.
  - `adblock_engine.rs` — Brave `adblock::Engine`. **`Engine` is `!Send`**, so it
    lives on one dedicated thread (OnceLock); queries cross via mpsc. Android JNI
    entry `should_block(...)`.
  - `adblock_webkit.rs` (Linux) — declarative WebKit content filters via
    `adblock_convert.rs` (Brave → Safari content-blocker JSON), chunked ~25k
    rules/filter (WebKit caps ~50k), disk-cached by hash.
  - `adblock_inject.rs` (Windows + macOS) — document-start JS blocking
    fetch/XHR/sendBeacon + cosmetic hiding. Returns empty on Linux.
  - `adblock_win.rs` (Windows) — hooks WebView2 `WebResourceRequested` on
    `ICoreWebView2` via unsafe COM for full network interception.
- **Security** — `safety.rs` (URLhaus malware host set from `resources/`, JNI
  `isMalwareHost`), `permissions.rs` (site permission prompts).
- **Linux** — `linux_layout.rs`: works around **tauri#10420** by reparenting
  webkit2gtk widgets GtkBox → GtkFixed; title-changed signal feeds history +
  routes the element-picker sentinel; Esc-exits-fullscreen; GTK key hook
  handles Ctrl+T/W/Shift+T tab shortcuts (accelerator menus used on Win/macOS).
- **Misc** — `picker.rs` (element picker), `update.rs` (tauri-plugin-updater state).

## Key dependencies (`Cargo.toml`)

`tauri` (feature `unstable` for multi-webview), `adblock` (feature
`content-blocking`), `tauri-plugin-updater`, `tauri-plugin-dialog`,
`tauri-plugin-log`, `reqwest` (blocking), `rustls`. Platform-gated blocks:
Linux → `gtk`/`webkit2gtk`/`glib`/`gio`; Android → `jni`; Windows →
`webview2-com` (pinned) + `windows`.

## Android (`gen/android/`)

Hand-written Kotlin under `app/src/main/java/com/aegis/browser/`:
`MainActivity.kt` (native content WebView; `shouldInterceptRequest` → ad-block +
malware; `window.AegisAndroid` JS bridge), `NativeAdblock.kt` + `NativeSafety.kt`
(JNI into the Rust `libapp_lib.so`). `AndroidManifest.xml` grants only `INTERNET`.

**Mobile chrome (`MainActivity.kt`), kept in sync with the `MobileApp` shell in `src/`:**
- The content WebView is inset by the chrome heights: `topMargin = 72dp`
  (`MOBILE_ADDRESS_H` 48 + `MOBILE_FAV_H` 24) + status inset, `bottomMargin = 56dp`
  (`MOBILE_BOTTOMBAR_H`) + nav inset. **`applyContentMargins()`** is the single place
  that computes them from the `fullscreen` / `bottomBarHidden` flags + cached chrome
  heights + captured system insets; the insets listener and the bridges all call it.
- The `AegisAndroid` bridge adds `setBackInterceptActive` (Back closes an open sheet),
  `setBottomBarHidden` (the top-bar chevron — content reclaims the bar's gap), and
  `setFullscreen` (desktop-parity hide-all-chrome — content fills the safe area, Back
  exits). The chrome installs `window.__aegisMobileBack` for native Back to call.
- **Safe-area insets:** `env(safe-area-inset-*)` in an Android WebView reports the
  display cutout, NOT the system bars, so the insets listener pushes the real status/nav
  insets to the chrome as `--aegis-inset-top/bottom` CSS vars (px ÷ density).
- A **`WebChromeClient`** (`onShowCustomView`/`onHideCustomView` + immersive bars) gives
  pages HTML5 fullscreen (video, etc.) — distinct from the chrome-hiding `setFullscreen`.

## Build

```bash
npm run tauri:dev                              # dev
npm run tauri:build                            # desktop installers
cargo check                                    # quick type-check
cargo check --target x86_64-pc-windows-gnu     # cross-check Windows from Linux (needs mingw)
npm run android:build                          # debug APK (NEEDS JDK 21 — see gotcha 8)
npm run android:build -- --target aarch64      # arm64-only APK (smaller; for a phone)
```

## Gotchas

1. **tauri#10420** — Linux multi-webview won't position; fixed by GtkFixed
   reparenting in `linux_layout.rs`.
2. **DMABUF white-screen** — `lib.rs` sets `WEBKIT_DISABLE_DMABUF_RENDERER=1`.
3. **NVIDIA + Wayland** — force XWayland (`GDK_BACKEND=x11`) in `lib.rs`.
4. **`Engine` is `!Send`** — keep it on its one thread; only `String`/`bool` cross.
5. **Event names** — always go through `emit_event()` (`.`→`:`).
6. **WebView2 COM** in `adblock_win.rs` is unsafe + needs a real Windows desktop to
   runtime-verify (CI compiles/links but doesn't launch the GUI).
7. **TLS** — a crypto provider must be installed once (done in `lib.rs`) or every
   reqwest/updater HTTPS call panics.
8. **Android needs JDK 21.** Gradle 8.14.3 / AGP 8.11.0 can't run under JDK 25 (the
   `:buildSrc` configuration fails with a bare `> 25.0.3`). Build with the Android
   Studio JBR: `JAVA_HOME=~/development/android-studio/jbr npm run android:build`.
9. **16 KB page alignment (Android 15+).** `build.rs` passes
   `-Wl,-z,max-page-size=16384` for android targets so `libapp_lib.so`'s LOAD segments
   are 16 KB-aligned; without it the lib fails to load ("LOAD segment not aligned").
10. **Desktop-only Tauri APIs must be `#[cfg(desktop)]`-gated** — the Rust lib has to
    compile for android too. `Webview::close()`, `Builder::on_menu_event`, etc. are
    desktop-only (see `tabs.rs::close_webview`, the `lib.rs` builder). Only an android
    build / `cargo check --target aarch64-linux-android` catches these; desktop and the
    Windows cross-check do not.

### Multi-webview Linux layout (hard-won facts)

These apply when there is more than one content webview (i.e. multiple tabs):

a. **One canonical GtkFixed.** Every content webview must live in the same
   `GtkFixed` container. New `add_child`-ed tabs land in the `GtkBox` and must
   be re-parented into the `GtkFixed` each layout pass; leaving them in a nested
   `GtkFixed` breaks the hide-others logic.

b. **Classify by GTK widget name, not pointer.** Content webviews are identified
   in `layout()` by a GTK widget name set via `mark_content_label`
   (constant `CONTENT_WIDGET_NAME`). Do NOT collect pointers via `with_webview`
   — that closure runs off the main thread and races with layout.

c. **Active tab visibility follows the overlay state.** The active content
   webview's visibility must be set to `content_visible = fullscreen || sidebar
   || !overlay` (and hidden when the URL is about:blank), NOT forced to always
   visible. Forcing it visible causes chrome overlays to render behind the page.

d. **Fullscreen exit button must be the topmost GtkFixed child.** In fullscreen
   mode the exit button must be re-added as the last (topmost z-order) child of
   the `GtkFixed` each layout pass — `raise()` alone is not enough to lift a GTK
   widget above native WebKit windows.
