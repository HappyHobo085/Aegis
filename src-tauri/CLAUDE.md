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
- **`nav.rs`** — content webview creation (`spawn_content`, desktop), navigation
  callbacks (malware guard, HTTPS-Only upgrade), emits `nav.state`/`nav.failed`.
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
  routes the element-picker sentinel; Esc-exits-fullscreen.
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
malware; `window.AegisAndroid` JS bridge: navigate/back/forward/reload/
setContentHidden/openExternal), `NativeAdblock.kt` + `NativeSafety.kt` (JNI into
the Rust `libapp_lib.so`). `AndroidManifest.xml` grants only `INTERNET`.

## Build

```bash
npm run tauri:dev                              # dev
npm run tauri:build                            # desktop installers
cargo check                                    # quick type-check
cargo check --target x86_64-pc-windows-gnu     # cross-check Windows from Linux (needs mingw)
npm run android:build                          # debug APK
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
