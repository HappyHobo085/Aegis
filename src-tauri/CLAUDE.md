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
├── resources/          # bundled filter lists (easylist.txt, easyprivacy.txt, peter-lowe.txt, abuse-tlds.txt, malware-hosts.txt)
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
  (called from `on_new_window` to open target=\_blank links as background tabs —
  but `on_new_window` first drops the request if the ad-block engine flags the
  destination as an ad pop-under; see Ad-block below).
- **`nav.rs`** — content webview creation (`spawn_tab(id, url)`, replaces the
  old `spawn_content`), navigation callbacks (malware guard, HTTPS-Only upgrade,
  **ad-block: `on_navigation` cancels loads of blocked ad/tracker destinations** via
  `should_block` — catches pop-under redirect chains whose final ad domain `on_new_window`
  never saw, and ad iframes, on every desktop; Android does the equivalent in
  `shouldInterceptRequest`), emits `nav.state`/`nav.failed`. Active webview now accessed via
  `active_content_label()`/`active_webview()` (refactored from the old single
  `CONTENT_LABEL` constant).
- **`view.rs`** — content webview geometry: insets, sidebar, fullscreen, overlay.
- **`data.rs`** — `data.export` / `data.import` (bundles all stores + settings).
- **Data stores** — `jsonstore.rs` (tiny JSON-array helper) backs `places.rs`
  (favorites + saved), `history.rs`, `downloads.rs`, `subs.rs` (filter
  subscriptions + fetch), `customfilters.rs`, `settings.rs`.
- **Ad-block (layered, platform-gated):**
  - `adblock_lists.rs` — **single source of truth for the bundled filter lists**:
    EasyList (ads) **+ EasyPrivacy (trackers/analytics)** **+ Peter Lowe's** (ad+tracking
    hosts) **+ a curated abuse-TLD block** (`abuse-tlds.txt`: `||cfd^` etc.), mirroring
    uBlock Origin's default set plus rotating-domain defense. EasyList alone blocks ad
    servers but *not* analytics (google-analytics, hotjar, scorecardresearch, …), so
    EasyPrivacy closes that gap; and piracy/streaming sites serve pop-under/banner ads
    from rotating random domains on throwaway TLDs (e.g. `limbycocking.cfd`) that no
    static domain list catches — `||tld^` blocks the whole abuse TLD (engine, converter,
    and the inject domain-set via suffix match all honor it). **Every tier below reads
    `adblock_lists::ALL`** (engine, the WebKit
    converter, the inject builder) so coverage is identical on Linux/Windows/macOS/Android
    — add a list here and all platforms widen at once. Custom rules + user subscriptions
    layer on top in the callers that support them.
  - `adblock.rs` — state machine (enabled + allowlist), `adblock.*` IPC.
    `sync_engine` mirrors the on/off + allowlist into `adblock_engine` on **all**
    targets (desktop + Android), so the pop-under check honors them everywhere.
    Also owns the **shield-badge counters**: `note_blocked`/`reset_page` keep a
    monotonic session total + per-tab page count and emit `adblock.blockedCount`;
    `getState` returns the active tab's `pageBlocked` so the chrome recovers the
    count on mount/tab-switch (live events emitted before the chrome subscribed —
    e.g. the restored boot page — are otherwise lost). Counting is wired on **Linux**
    only so far (`linux_layout::connect_block_counter`); Win/Android is a follow-up.
  - `adblock_engine.rs` — Brave `adblock::Engine`. **`Engine` is `!Send`**, so it
    lives on one dedicated thread (OnceLock); queries cross via mpsc. Android JNI
    entry `should_block(...)`. Compiled on **all desktop + Android** (not just
    Win/Android): every desktop calls `should_block` from `nav::on_new_window` to
    **drop ad/tracker pop-unders** (`window.open`/`target=_blank` to an ad domain)
    instead of opening them as tabs; warmed off-thread at boot (`lib.rs`) so the
    first check doesn't parse the lists on the UI thread. Loads every
    `adblock_lists::ALL` list into the `FilterSet`. Android does the same in
    `MainActivity.onCreateWindow` via `NativeAdblock.shouldBlock`.
  - `adblock_webkit.rs` (Linux) — declarative WebKit content filters via
    `adblock_convert.rs` (Brave → Safari content-blocker JSON), chunked ~25k
    rules/filter (WebKit caps ~50k), disk-cached by hash. **Filters are per-webview
    (per-tab), not global** — `apply_filters` covers every content webview + caches
    the chunks; `nav::spawn_tab` calls `apply_to_new_tab` so tabs opened *after*
    boot get filters too (not just the boot-active tab); `remove_all` clears all.
  - `adblock_inject.rs` (Windows + macOS) — document-start JS blocking
    fetch/XHR/sendBeacon + cosmetic hiding. On Linux it skips the heavy injection (native
    filters cover it) but STILL injects the **pop-under guard** (`POPUP_GUARD`, shipped on
    EVERY platform): overrides `window.open` to drop CROSS-ORIGIN scripted popups before any
    window/tab opens — the "prevent it loading" layer for on-click pop-under ads, which open
    a new window to a rotating ad domain no list can track. Same-origin / `about:blank` opens
    pass through (native `on_new_window` vets those). Trade-off: legit cross-origin scripted
    popups (e.g. OAuth) are blocked too; real `<a target=_blank>` links still open.
  - `adblock_win.rs` (Windows) — hooks WebView2 `WebResourceRequested` on
    `ICoreWebView2` via unsafe COM for full network interception.
- **Security** — `safety.rs` (URLhaus malware host set from `resources/`, JNI
  `isMalwareHost`), `permissions.rs` (site permission prompts).
- **WebRTC IP-leak defense** — `webrtc_shim.rs`: the `webrtcPolicy` setting
  (`default`/`public-only`(default)/`disable`) as a document-start JS shim that wraps
  `RTCPeerConnection` to filter local/private ICE candidates (the `icecandidate` event,
  `createOffer`/`Answer` SDP, `localDescription` getters, **and `getStats()`**) while
  keeping TURN/relay so calls survive. The shipped JS is single-sourced in
  `webrtc_shim.public-only.js` / `webrtc_shim.disable.js` (`include_str!`'d) and executed
  by the vitest runtime test `src/lib/webrtcShim.test.ts` (authoritative); the Rust
  `is_local_address`/`keep_candidate`/`filter_sdp` are a parallel unit-tested reference.
  Baked into the injection by `adblock_inject::script(app, host_allowlisted)`; the
  per-site escape hatch reuses the ad-block allowlist (`adblock::host_allowlisted`). Native
  backstops: Linux `set_enable_webrtc(false)` for `disable` only (`linux_layout`); Windows
  `--force-webrtc-ip-handling-policy` via `additional_browser_args` (which **replaces**
  wry's defaults, so it re-includes both `--disable-features=…` and
  `--autoplay-policy=no-user-gesture-required`). Android: the policy lives in a global
  (`note_policy`, seeded at boot + on `settings.set`), read by the `NativeWebrtc.shimScript`
  JNI getter and registered per-tab. **Residual matrix (honest):** the shim covers page +
  iframe frames but NOT Web Worker scopes. `disable` is worker-tight on Linux/Windows
  (native), shim-only (workers leak) on macOS/Android. `public-only` is native (worker-tight)
  on Windows, shim-only on Linux/macOS/Android. Per-site hatch is desktop-only in v1.
- **Linux** — `linux_layout.rs`: works around **tauri#10420** by reparenting
  webkit2gtk widgets GtkBox → GtkFixed; title-changed signal feeds history +
  routes the element-picker sentinel; Esc-exits-fullscreen; GTK key hook
  handles Ctrl+T/W/Shift+T tab shortcuts (accelerator menus used on Win/macOS).
  `connect_block_counter` counts blocked ads for the badge: the content filters
  block declaratively (no per-block callback), but `resource-load-started` **does**
  fire for blocked resources, so each subresource is run through the engine and
  matches call `adblock::note_blocked`. Caveat: WebKit negative-caches a blocked URL,
  so an identical URL won't re-fire on reload — real ad URLs are unique per request so
  this is mostly moot, but a page of *static* ad URLs under-counts on repeat loads.
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
- The content area is inset by the chrome heights: `topMargin = 72dp`
  (`MOBILE_ADDRESS_H` 48 + `MOBILE_FAV_H` 24) + status inset, `bottomMargin = 56dp`
  (`MOBILE_BOTTOMBAR_H`) + nav inset. **`applyContentMargins()`** is the single place
  that computes them from the `fullscreen` / `bottomBarHidden` flags + cached chrome
  heights + captured system insets; the insets listener and the bridges all call it.
  It sets the margins on the **`GestureContainer`** that wraps the tab WebViews (see
  Touch gestures below), which carries the insets so each tab WebView just fills it.
- The `AegisAndroid` bridge adds `setBackInterceptActive` (Back closes an open sheet),
  `setBottomBarHidden` (the top-bar chevron — content reclaims the bar's gap), and
  `setFullscreen` (desktop-parity hide-all-chrome — content fills the safe area, Back
  exits). The chrome installs `window.__aegisMobileBack` for native Back to call.
- **Safe-area insets:** `env(safe-area-inset-*)` in an Android WebView reports the
  display cutout, NOT the system bars, so the insets listener pushes the real status/nav
  insets to the chrome as `--aegis-inset-top/bottom` CSS vars (px ÷ density).
- A **`WebChromeClient`** (`onShowCustomView`/`onHideCustomView` + immersive bars) gives
  pages HTML5 fullscreen (video, etc.) — distinct from the chrome-hiding `setFullscreen`.
- **Multi-tab (live tabs).** `MainActivity` keeps a `tabId → WebView` map; the active
  tab's WebView is mirrored into `contentWebView` so all existing active-tab logic
  (margins/overlay/nav/back) is unchanged. The chrome drives it via
  `AegisAndroid.activateTab(id,url)` / `closeTab(id)` / `discardTab(id)` (Rust can't touch
  native Android views — the chrome coordinates). WebViews are created **lazily** by
  `activateTab` (not eagerly in `onWebViewCreate`). Each tab has its own `WebViewClient`
  (`makeContentClient(id)`) with a per-tab `pageUrls[id]` first-party context for ad-block,
  and `pushNavState(id,…)` carries the tab id as `viewId` so the chrome's
  `useNav(activeId)` tracks the active tab. **`activateTab` re-pushes the tab's nav state**
  (switching to an already-live tab fires no page-load event, so without this the address
  bar would blank). The tab title is NOT observed natively (no WebKit signal) — the chrome
  relays it via `tabs.setTitle`. `makeChromeClient().onCreateWindow` routes
  `target=_blank`/`window.open` to `window.__aegisOpenTab` → a background tab.
- **Touch gestures (`GestureContainer.kt`).** A custom `FrameLayout` wraps the tab
  WebViews (so the chrome-bar margins live on it, not per-tab). It uses the
  watch-then-steal model — `onInterceptTouchEvent` lets the active WebView handle
  touches until it positively recognizes one of two gestures, then steals the stream
  (the WebView gets `ACTION_CANCEL`): **edge-swipe back/forward** (a horizontal drag
  from a ~20dp left/right edge strip — left=back, right=forward, with a ◀/▶ arrow that
  follows the finger; navigates on release past ~¼-width) and **pull-to-refresh** (a
  downward drag while the active WebView is at `scrollY==0`, with a spinner; reloads on
  release past threshold). It acts on the active tab through a `GestureHost` interface
  the activity implements (`gestureBack/Forward/Reload/CanGoBack/CanGoForward/AtTop` →
  `contentWebView`). `setSystemGestureExclusionRects` (API 29+) claims the edge strips
  from Android's own back gesture; `stopRefresh()` is called from the active tab's
  `onPageFinished` to hide the spinner. The indicator is drawn in **`dispatchDraw()`
  after `super` (NOT `onDraw`)** so it paints over the opaque content WebView (gotcha
  11). Nav reuses the existing `pushNavState` pipeline, so the address bar +
  back/forward state update with **no renderer/IPC changes**. Tuning constants
  (`edgePx`, `hDistance()`, `pullThreshold()`, pull damping) are all in `GestureContainer`.

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
6. **WebView2 COM** in `adblock_win.rs` is unsafe; CI compiles/links but doesn't
   launch the GUI. **Runtime-verified on real Windows 11 (2026-06):** it installs
   without panicking and the network ad-block tier blocks (DoubleClick `gpt.js`
   served an empty 204; a non-ad control script still loaded). `nav_url_win.rs`'s
   `SourceChanged` handler installs cleanly too, though its same-document URL
   tracking wasn't exercised yet. The shield block-counter is still NOT wired on
   Windows (`note_blocked` is Linux-only) — blocking works, the badge just shows 0.
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
11. **Draw over a ViewGroup's children with `dispatchDraw`, not `onDraw`.** A
    `ViewGroup`'s `onDraw()` paints *behind* its children, so an indicator drawn there is
    occluded by an opaque `MATCH_PARENT` child (the content WebView). `GestureContainer`
    draws its swipe arrow / refresh spinner in `dispatchDraw()` after `super.dispatchDraw()`,
    which renders on top. (Same class of bug as the earlier "chrome overlay rendered behind
    the native content view.")
12. **AppImage HTML5 video — GStreamer plugin path.** WebKitGTK decodes `<video>`/`<audio>`
    via GStreamer, which `dlopen`s its plugins (incl. `appsink`, how WebKit pulls frames)
    from `GST_PLUGIN_SYSTEM_PATH_1_0`. linuxdeploy bundles `libgstreamer` (a *linked* dep)
    but NOT the `dlopen`-ed plugin modules, and `AppRun` points that env var at the bundled
    (empty) dir — so all media fails with "GStreamer element appsink not found": permanent
    spinner, no playback (the streamex.sh symptom). `lib.rs` appends the host's plugin
    dir(s) (`/usr/lib64/gstreamer-1.0`, …) to the path; the bundled libgstreamer is copied
    from the build host so it version-matches and loads them. Harmless for the `.deb`/dev
    (those dirs are already default). Fedora multilib note: `/usr/lib/gstreamer-1.0` is the
    *i686* dir, so it's only used as a fallback when no arch-specific dir exists.
13. **`on_navigation` fires for subframes; don't drive the URL bar from it.** wry wires
    Tauri's `on_navigation` to WebKitGTK `decide-policy` (NavigationAction) with NO
    main-frame filter, so cross-site iframe/embedded-player loads call it too — and it
    only hands you a `&Url` (no frame info), so you can't tell them apart. Emitting
    `nav.state` there made the address bar flicker to embedded ad/player URLs mid-load.
    Keep safety/HTTPS-Only checks in `on_navigation` (they should cover subframes), but
    drive the URL bar from two main-frame-only sources instead: `on_page_load` (wired to
    `load-changed`) for the loading state on full loads, and **`notify::uri`**
    (`linux_layout::connect_url_tracker`) for the URL — the latter also catches
    same-document History-API (`pushState`/`replaceState`) + hash navigations that
    `load-changed` does NOT fire for (SPAs like streamex switch `?server=` that way), so
    the bar stays correct without ever showing a subframe URL. (Android is unaffected — it
    reports via `onPageStarted`/`doUpdateVisitedHistory`, already main-frame-only. Set
    `AEGIS_NAV_DEBUG=1` to trace what reaches the bar.) The same-document URL tracking is
    wired on every desktop: **Windows** `nav_url_win.rs` (WebView2 `SourceChanged`,
    compile-verified via the gnu cross-check + CI) and **macOS** `nav_url_mac.rs`
    (WKWebView `URL` KVO, mirroring wry's own `DocumentTitleChangedObserver`). NOTE: the
    macOS objc2 code can't be compiled from Linux at all — `objc2`'s build script needs a
    macOS C toolchain — so it is **CI-verified only** (macos-latest), not locally.
14. **Linux OWNS the `decide-policy` signal for the redirect guard.** wry connects its own
    `decide-policy` handler (powering `on_navigation`) and CLAIMS the signal (`return true`),
    so a second handler never fires — and Tauri ALWAYS installs a `navigation_handler` (to run
    plugin hooks), so you can't free it by skipping `.on_navigation`. To get the gesture/frame
    info `on_navigation` lacks (gotcha 13), `linux_layout::install_nav_policy` DISCONNECTS
    wry's handler (`g_signal_handlers_disconnect_matched` by signal id) at tab spawn and
    installs ours: it runs the shared `nav::decide_navigation` (ad-block/malware/HTTPS/overlay)
    for NavigationAction AND the scripted-cross-origin-**top-frame redirect guard**. Reliable
    main-frame detection is NOT on `NavigationAction` (only gesture/type are), so the guard is
    TWO-PHASE: record gesture/type per-URL at `NavigationAction`, then CANCEL at
    `ResponsePolicyDecision` where `is_main_frame_main_resource()` (webkit2gtk **`v2_40`** — see
    Cargo.toml) is reliable AND the response is displayable (so embeds + downloads are skipped).
    Allowed navs call `use_()`; non-Response / non-blocked fall through (`false`) so
    downloads/new-windows keep WebKit's default handling. A block emits `redirect.blocked` →
    the chrome's `RedirectBar` (a notification bar that adds `REDIRECT_BAR_H` to the content
    inset; a floating toast can't paint over the opaque content webview). Other platforms keep
    Tauri's `on_navigation` + their own native top-frame hooks (Windows `NavigationStarting`,
    macOS `WKNavigationDelegate`, Android `shouldOverrideUrlLoading`).

14. **Local Windows builds need NASM + CMake** (for `aws-lc-sys`, rustls' crypto C
    backend). The MSVC "Desktop development with C++" workload bundles CMake; install
    NASM separately (nasm.us) and add it to PATH. CI's `windows-latest` ships both, so
    this only bites local builds. Same-machine aside: behind a network that blocks the
    CA revocation endpoints (OCSP/CRL), cargo's schannel TLS fails every crates.io
    fetch with `CRYPT_E_NO_REVOCATION_CHECK` — set `http.check-revoke = false` in
    `~/.cargo/config.toml`.

15. **Windows child webviews need PHYSICAL bounds at fractional DPI.** wry's `add_child`
    / `set_bounds` called with `LogicalPosition`/`LogicalSize` mispositions the WebView2
    controller's INPUT/hit-test region at non-100% scaling (e.g. 125%): the content
    webview *renders* below the chrome bars but *captures their clicks*, so the toolbar
    and favourites bar go dead (the tab strip, above the misplaced region, still works —
    that's the "can't add a tab / favourites don't click" symptom). `nav::spawn_tab` and
    `view::apply_inset` pass `PhysicalPosition`/`PhysicalSize` on Windows (logical×scale)
    so the controller's hit rect matches the host window. Only bites fractional DPI — 100%
    is unaffected, which is why CI / 100%-DPI testing missed it. (macOS keeps Logical.)

16. **Windows runtime tab creation must spawn the webview OFF the UI thread, and tabs
    need explicit show/hide.** Two pre-existing Windows multi-tab bugs:
    (a) `window.add_child` **deadlocks the UI thread** when called synchronously from the
    `ipc` command — WebView2's async `CreateCoreWebView2Controller` can't complete while
    the event loop is blocked waiting on it (Tauri `WebviewBuilder` docs / wry#583). So
    `tabs::spawn` creates the webview on a `std::thread::spawn` worker on Windows, then
    re-applies layout via `run_on_main_thread`. Without it, the **+** button / Ctrl+T
    froze the whole app. (b) Per-tab content webviews all sit at the inset and **overlap**;
    z-order doesn't follow the active tab, so `view::apply_inset` shows the active tab's
    webview and hides every other tab's each layout pass (Linux does this in
    `linux_layout::layout`). Without it, switching tabs left the previous page on top.

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

c. **Hide the active content by parking it OFFSCREEN, never `set_visible(false)`.**
   A full-window chrome overlay (settings/downloads/sidebar-less) should cover the
   page: `content_visible = fullscreen || sidebar || !overlay` (also treat
   `about:`/home as not-covering). But on this stack `set_visible(false)` on the
   active content is wrong twice over: (1) it *backgrounds* the page — rAF stalls,
   which malvertising weaponizes to fire a redirect — and (2) it doesn't even
   reliably hide it: the WebKit native window stays stacked on top, so a full
   overlay renders BEHIND the page (confirmed via layout logging — the flags were
   correct, content stayed on top regardless; see gotcha (d)). So `layout()` keeps
   the active content `set_visible(true)` ALWAYS and, when it shouldn't cover the
   screen, moves it OFFSCREEN (`fixed.move_(&child, -10000, -10000)`) — the same
   mechanism that reliably hides background tabs. Visible+offscreen = not
   backgrounded and not covering the chrome. Z-order: raise the content only when
   it's shown; otherwise raise the chrome — never `raise()` the content while it's
   parked, or it re-covers the overlay.

d. **Fullscreen exit button must be the topmost GtkFixed child.** In fullscreen
   mode the exit button must be re-added as the last (topmost z-order) child of
   the `GtkFixed` each layout pass — `raise()` alone is not enough to lift a GTK
   widget above native WebKit windows.
