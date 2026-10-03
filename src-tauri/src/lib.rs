// `unsafe` is denied crate-wide. Every site we have is FFI glue to a platform
// API (WebKitGTK, WebView2, WKWebView, the OS keychain, JNI), and each such
// module opts back in with a bare `#[allow(unsafe_code)]` on its `mod`
// declaration above — so the unsafe surface is an explicit, reviewable list of
// 12 modules rather than something you have to grep for. Adding a new `unsafe`
// now requires deliberately saying so, and CI's `clippy -D warnings` enforces
// it. Keep the allow list as small as the platform demands.
#![deny(unsafe_code)]

mod adblock;
// The bundled filter lists (EasyList + EasyPrivacy + Peter Lowe's), single-sourced so
// every ad-block tier blocks from the identical set across all platforms.
// WebKit content-blocker conversion. Its only caller is `install_adblock`, which is
// `#[cfg(target_os = "linux")]`, so on every other platform the whole module is dead. The
// `test` arm keeps its unit tests running everywhere; that is why the module carries no
// `#![allow(dead_code)]` -- a blanket allow would suppress Linux's real diagnostics too.
#[cfg(any(target_os = "linux", test))]
mod adblock_convert;
mod adblock_lists;
// Form detection for autofill triggering
mod form;
// Chromium-side network ad-blocking engine (`should_block`). Used by Android (JNI
// export) and Windows (WebView2 interception, adblock_win) for full request blocking,
// and by ALL desktop platforms to drop ad/tracker pop-unders in nav::on_new_window.
#[cfg(any(desktop, target_os = "android", test))]
mod adblock_engine;
// Scripted cross-origin top-frame redirect blocker (anti-malvertising). Pure
// policy (should_block) + per-tab app-initiated nav registry; each platform's
// native nav-policy hook derives the inputs and cancels. The design is recorded in
// `redirect_guard`'s own module header and in `src-tauri/AGENTS.md` (gotcha 14) —
// the spec this used to cite was deleted in commit 58d2c4b and is not recoverable.
#[cfg(any(desktop, target_os = "android", test))]
mod redirect_guard;
// Cross-platform post-change ad-block re-apply (WebKit reinstall on Linux + engine policy
// mirror + engine FilterSet reload everywhere). Replaces the Linux-only install_adblock
// calls so sub/custom-filter changes take effect on Win/macOS/Android too.
mod adblock_refresh;
// Windows full network ad-block: our own WebView2 WebResourceRequested interceptor.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod adblock_win;
// Address-bar URL tracking for same-document (History-API/hash) navigations — the
// per-platform analog of Linux's WebKitGTK notify::uri (linux_layout::connect_url_tracker):
// WebView2 SourceChanged on Windows, WKWebView `URL` KVO on macOS.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod nav_url_win;
// Windows scripted cross-origin top-frame redirect guard: WebView2 NavigationStarting.
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod nav_policy_win;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod nav_url_mac;
// Injected (document-start) ad/tracker blocker for the content webview — the ad-block
// layer on Windows/macOS (wry can't intercept their requests), verifiable on Linux where
// it supplements the WebKit content filters, and on Android it provides the pop-under
// guard + injected ad-block tier via the NativeInject JNI getter (Android injected
// nothing before this). Gated like adblock_engine so the JNI export links on Android.
#[cfg(any(desktop, target_os = "android", test))]
mod adblock_inject;
// WebRTC IP-leak defense: the document-start shim builder + reference filter rules.
// Gated like adblock_engine so the NativeWebrtc JNI export links on Android.
#[cfg(target_os = "linux")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod adblock_webkit;
/// Link gestures (Ctrl/Cmd+click, middle-click, Shift+click -> new background tab), injected
/// at document-start on EVERY platform and AHEAD of the ad-block layer: it reads the native
/// `window.open` that `adblock_inject`'s pop-under guard would otherwise replace, which is
/// what stops the guard from swallowing every cross-origin modifier-click. See the module
/// doc for why the layer needs no IPC channel.
mod link_gestures;
#[cfg(target_os = "linux")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod linux_layout;
/// Per-host WebRTC IP-leak exemptions. LOCAL-ONLY store — see the module doc for why
/// this is not the ad-block allowlist.
mod webrtc_exempt;
#[cfg(any(desktop, target_os = "android", test))]
mod webrtc_shim;
// Sync engine (F2b) crypto: key tree + recovery phrase + record seal/open. Ungated — the
// crypto deps build on every target (the cross-compile gate confirmed this), incl. Android.
mod crypto;
// Anti-fingerprinting (farbling): one-way session salt + per-session public SEED derivation.
// Ungated — the HKDF/getrandom deps build on every target.
mod farble;
// Per-device Ed25519 signed-token auth for the sync server (F2b).
mod customfilters;
mod data;
mod downloads;
mod history;
mod jsonstore;
mod nav;
mod permissions;
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod picker;
mod places;
mod safety;
mod settings;
mod subs;
mod sync_auth;
// Sync data-layer (F2a): the HLC envelope + stable device node id that timestamp every
// syncable record. Pure/ungated — the sync engine (F2b) builds on this frozen contract.
mod sync_envelope;
mod sync_identity;
// Sync seed at rest (F2b): OS keychain (desktop) / passphrase-wrapped fallback + the
// per-install device salt. Android hardware-Keystore path wired in the Android-parity step.
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod sync_keystore;
// The merge seam F2b consumes: SYNCABLE stores + read_all/merge_into (HLC last-writer-wins).
mod sync_stores;
// The sync ENGINE (F2b): enable/disable, device pairing, the encrypted pull/merge/push loop.
mod sync;
// The vault's half of sync: publishes/adopts the account's shared Argon2 salt (so records are
// portable between paired devices at all) and merges records that authenticate under the local
// vault key. Gated on the separate `syncVault` opt-in; see the module docs for the two halves.
mod sync_vault;
mod tab_registry;
mod tabs;
#[cfg(test)]
mod test_support;
mod update;
mod view;
// Find-in-page dispatcher + per-platform native implementations.
mod find;
#[cfg(target_os = "linux")]
mod find_linux;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod find_mac;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod find_win;
// Page zoom (zoom.* IPC): session-only per-tab factor, per-platform native setter.
mod zoom;
#[cfg(target_os = "macos")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod zoom_mac;
#[cfg(target_os = "windows")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod zoom_win;
// Local encrypted-at-rest password vault (Phase A — manage only, NO autofill, NO page bridge).
mod vault;
// In-page autofill badge + form detection JS injection (Phase B).
mod vault_inject;
// Content-webview-scoped proxy: pure parse/validate/URI core (Tasks 1-6).
mod proxy;

use serde_json::Value;
use tauri::{Emitter, Manager};

/// Emit a frontend event. Tauri 2 forbids `.` in event names, but our shared
/// `IPC.evt*` names use dots (Electron's IPC allows them); translate `.`→`:` so
/// the JS listener (which applies the same translation in tauriInvoke.ts) receives
/// it. Without this, every `listen()` is rejected and no rust→renderer event fires.
pub fn emit_event<R: tauri::Runtime, S: serde::Serialize + Clone>(
    app: &tauri::AppHandle<R>,
    name: &str,
    payload: S,
) {
    let _ = app.emit(&name.replace('.', ":"), payload);
}

/// Run `f` under a panic guard, for code reachable from a JNI `extern "system"` frame.
///
/// A panic that unwinds out of an `extern "C"`/`extern "system"` function is undefined
/// behaviour — on Android it tears down the process (a SIGABRT the user sees as the app
/// vanishing), not a catchable exception. Every JNI export must therefore treat a panic
/// as a normal, recoverable outcome. Returns `None` if `f` panicked.
///
/// Callers must keep the `JNIEnv` **outside** the closure: it is `!UnwindSafe`, and the
/// whole point of `AssertUnwindSafe` here is to assert that the *captured* state is plain
/// data. Read the `jstring` arguments into owned `String`s first, guard only the pure
/// computation, then build the return value (e.g. `env.new_string`) outside — the same
/// shape `farble.rs` and `proxy.rs` already use.
///
/// Also serves as the grep-able inventory of guarded exports: every `extern "system" fn
/// Java_*` body should route its fallible work through here.
// Only CALLED from the `#[cfg(target_os = "android")]` JNI exports, so every other
// target would see it as dead code. The `tests` module below exercises it on every
// platform, so this is scoped to non-Android rather than a blanket allow.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub(crate) fn ffi_guard<T>(f: impl FnOnce() -> T) -> Option<T> {
    std::panic::catch_unwind(std::panic::AssertUnwindSafe(f)).ok()
}

/// The app handle for the Android JNI entry points that need managed state.
///
/// Kotlin -> Rust is the only usable direction on Android (Rust cannot up-call into
/// Kotlin), and most native entry points get away without an `AppHandle` because
/// they are pure functions over their arguments. Two cannot: recording a page load
/// (`history`) and recording a download (`downloads`) both need a store that only
/// exists as managed state behind a handle. The handle therefore lives HERE, not in
/// `history.rs`, so the second feature does not have to depend on the first.
#[cfg(target_os = "android")]
static ANDROID_APP: std::sync::OnceLock<tauri::AppHandle> = std::sync::OnceLock::new();

/// Publish the app handle to the Android JNI entry points. Called once from `setup()`.
/// Idempotent (a second call is ignored, not an error).
#[cfg(target_os = "android")]
pub(crate) fn set_android_app(app: &tauri::AppHandle) {
    let _ = ANDROID_APP.set(app.clone());
}

/// The published handle, or `None` when a native call arrives before `setup()`
/// finished. Dropping one event is strictly better than writing into a store that
/// isn't managed yet.
#[cfg(target_os = "android")]
pub(crate) fn android_app() -> Option<&'static tauri::AppHandle> {
    ANDROID_APP.get()
}

/// Single IPC entry point. The renderer calls `invoke('ipc', {channel, payload})`
/// with a channel name (the strings in shared/types.ts `IPC`). `nav.*` and `view.*`
/// are handled live against the content webview; the remaining data namespaces
/// return Phase-0 defaults so the reused React UI renders. Real SQLite/adblock/
/// safety backends replace those arms in Phases 2–3.
#[tauri::command]
fn ipc(app: tauri::AppHandle, channel: String, payload: Value) -> Result<Value, String> {
    if let Some(result) = nav::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = form::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = find::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = zoom::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = tabs::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = view::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = update::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = adblock::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = settings::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = places::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = history::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = customfilters::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = subs::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = picker::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = permissions::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = downloads::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = sync::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = data::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = safety::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = vault::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = farble::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = webrtc_exempt::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = proxy::dispatch(&app, &channel, &payload) {
        return result;
    }
    match channel.as_str() {
        "lists.updateNow" => {
            // Non-blocking: starts a background refresh, result arrives via lists.updateResult.
            subs::update_now(&app);
            Ok(Value::Null)
        }

        // Nothing handled this channel. Every real channel — including the fire-and-forget
        // actions (history.remove/clear, permissions.resolve, downloads.openFile/showInFolder,
        // update.*, safety.proceed/removeException), which resolve to `null` (Promise<void>) —
        // is claimed by one of the `dispatch` calls above, so reaching here means the channel
        // does not exist: a typo, a stale build, or a channel declared in `shared/types.ts`
        // with no Rust arm behind it.
        //
        // This used to return `Ok(Value::Null)`, which was the worst of the possible answers:
        // a rejected promise is visible, but a promise that RESOLVES to `null` is
        // indistinguishable from a channel that legitimately has no result, so the caller
        // renders `null` as data and the mismatch is invisible in both release and dev. The
        // real instance was `vault.autofill` — declared and typed in `shared/types.ts` and
        // tested against the IPC mock, but never implemented in Rust, so it silently
        // resolved to `null` in a release build and the declared `Promise<VaultRecord[]>`
        // was a lie. A misspelled channel arm has the same failure mode. So: say so.
        _ => {
            #[cfg(debug_assertions)]
            eprintln!("[aegis] unrecognized IPC channel: {channel}");
            Err(format!("unknown IPC channel: {channel}"))
        }
    }
}

/// Convert EasyList to content-blocker JSON on a background thread and load it as
/// WebKit content filters (cached after the first compile). Called at boot and
/// whenever ad-blocking is re-enabled.
#[cfg(target_os = "linux")]
pub fn install_adblock<R: tauri::Runtime>(app: tauri::AppHandle<R>) {
    let store_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/aegis"))
        .join("content-filters");
    let custom = customfilters::load(&app);
    let subs_text = subs::enabled_text(&app);
    // The per-host allowlist becomes `ignore-previous-rules` exemptions INSIDE the converted
    // rules (adblock_convert::allowlist_exemptions), so it is part of the filter content and
    // must be part of the cache key — otherwise a stale compiled filter is reused across an
    // allowlist change and the exemption silently never appears. Read from the persisted
    // store (not the in-memory cache) so this is correct even if the two are briefly out of
    // step, and so the hash matches what `adblock::dispatch` re-applies through.
    let allowlist = adblock::load_allowlist_hosts(&app);
    std::thread::spawn(move || {
        use std::hash::{Hash, Hasher};
        // Convert EVERY bundled list (ads + trackers + Peter Lowe's), not just EasyList,
        // so the WebKit content filters match the same set as the engine/inject tiers.
        let bundled = adblock_lists::ALL;
        // Cache key = source hash (all bundled lists + custom rules + enabled subscriptions
        // + the allowlist the exemptions are generated from).
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for list in bundled {
            list.hash(&mut hasher);
        }
        custom.hash(&mut hasher);
        subs_text.hash(&mut hasher);
        allowlist.hash(&mut hasher);
        let marker = store_dir.join(format!("v{:x}.ready", hasher.finish()));
        let cached = marker.exists();
        let sources: Vec<&str> = bundled
            .iter()
            .copied()
            .chain([custom.as_str(), subs_text.as_str()])
            .collect();
        match adblock_convert::to_content_blocker_chunks(&sources, 25_000, &allowlist) {
            Ok(chunks) => {
                eprintln!(
                    "[aegis-cf] filter lists -> {} chunks (cached={cached})",
                    chunks.len()
                );
                // Arm the marker BEFORE kicking off the (async) compiles, so it's written
                // only after the last chunk actually persists — not up front, which would
                // race a mid-compile exit into a stale partial cache. See adblock_webkit.
                if !cached {
                    adblock_webkit::arm_ready_marker(chunks.len(), marker.clone());
                }
                adblock_webkit::apply_filters(&app, chunks, store_dir.clone(), cached);
            }
            Err(e) => eprintln!("[aegis-cf] convert failed: {e}"),
        }
    });
}

#[cfg(all(desktop, not(target_os = "linux")))]
fn install_tab_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, SubmenuBuilder};
    let item = |id: &str, label: &str, accel: &str| {
        MenuItemBuilder::with_id(id, label)
            .accelerator(accel)
            .build(app)
    };
    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&item("tab_new", "New Tab", "CmdOrCtrl+T")?)
        .item(&item("tab_close", "Close Tab", "CmdOrCtrl+W")?)
        .item(&item(
            "tab_reopen",
            "Reopen Closed Tab",
            "CmdOrCtrl+Shift+T",
        )?)
        .item(&item("tab_next", "Next Tab", "Ctrl+Tab")?)
        .item(&item("tab_prev", "Previous Tab", "Ctrl+Shift+Tab")?)
        .build()?;
    let menu = MenuBuilder::new(app).item(&tabs_menu).build()?;
    app.set_menu(menu)?;
    // Windows: hide the lone "Tabs" menu bar — the tab strip below already shows the open
    // tabs, so it's redundant. (macOS keeps it: there it lives in the system menu bar at
    // the top of the screen, not in the window, so it isn't redundant.) Hiding it drops the
    // menu's keyboard accelerators on Windows, so the chrome re-implements the tab
    // shortcuts in JS there (see the Windows keydown handler in App.tsx).
    #[cfg(target_os = "windows")]
    if let Some(w) = app.get_window("main") {
        let _ = w.hide_menu();
    }
    Ok(())
}

/// Whether `path` is a 64-bit ELF (magic `\x7fELF` + EI_CLASS==2). Used to pick the
/// host-arch shared object when an AppImage bundles both 32- and 64-bit copies — Fedora
/// multilib lists the i686 dir first on LD_LIBRARY_PATH, and pointing a loader at a
/// wrong-arch module fails ("wrong ELF class"). Missing/short files read as false.
#[cfg(target_os = "linux")]
fn is_host_elf64(path: &std::path::Path) -> bool {
    use std::io::Read;
    let mut b = [0u8; 5];
    std::fs::File::open(path)
        .and_then(|mut f| f.read_exact(&mut b))
        .is_ok()
        && &b[0..4] == b"\x7fELF"
        && b[4] == 2
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // webkit2gtk's DMABUF renderer paints a blank/white window on many Linux GPU
    // drivers (common on Wayland, Nvidia, and VMs). Disable it before GTK/WebKit
    // initializes so the app renders out of the box — no env var needed at launch.
    // Set only if the user hasn't overridden it. Must run before any WebView spawns.
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
        // The bundled GTK ignores the system theme, and the prefer-dark hint is a no-op
        // on themes (e.g. KDE Breeze) whose dark form is a *separate* theme — so native
        // file choosers (import/export) and <select> popups render white. Force a
        // guaranteed-present dark GTK theme so they match Aegis's dark UI. User-overridable.
        if std::env::var_os("GTK_THEME").is_none() {
            std::env::set_var("GTK_THEME", "Adwaita:dark");
        }
        // Force GTK's own (in-process, themeable) file chooser instead of delegating to
        // the xdg-desktop-portal one, which renders with the portal's own light theme and
        // ignores GTK_THEME above — that's why the import/export dialogs stayed white.
        if std::env::var_os("GTK_USE_PORTAL").is_none() {
            std::env::set_var("GTK_USE_PORTAL", "0");
        }
        // The proprietary NVIDIA driver's Wayland EGL/GBM path crashes the WebKit web
        // process (a libstdc++ assertion deep in libnvidia-egl-*); disabling DMABUF or
        // compositing does NOT prevent it. Force the app onto XWayland (X11/GLX) — the
        // traditional, stable NVIDIA path — when we detect NVIDIA + a Wayland session.
        // X11 sessions and non-NVIDIA GPUs are untouched; guarded so the user can still
        // override GDK_BACKEND. Also keeps compositing as a belt-and-suspenders disable.
        let nvidia = std::path::Path::new("/proc/driver/nvidia").exists()
            || std::path::Path::new("/dev/nvidia0").exists();
        let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
            || std::env::var("XDG_SESSION_TYPE")
                .map(|v| v.eq_ignore_ascii_case("wayland"))
                .unwrap_or(false);
        if nvidia {
            if wayland && std::env::var_os("GDK_BACKEND").is_none() {
                std::env::set_var("GDK_BACKEND", "x11");
            }
            if std::env::var_os("WEBKIT_DISABLE_COMPOSITING_MODE").is_none() {
                std::env::set_var("WEBKIT_DISABLE_COMPOSITING_MODE", "1");
            }
        }
        // WebKitGTK plays HTML5 <video>/<audio> through GStreamer, which dlopens its
        // plugins — `appsink` (how WebKit pulls decoded frames) plus the codecs — from
        // GST_PLUGIN_SYSTEM_PATH_1_0. With `bundleMediaFramework` the AppImage now ships
        // version-matched plugins under usr/lib/<arch>/gstreamer-1.0 (on LD_LIBRARY_PATH);
        // use THOSE. The host's system plugins are built against the host's libgstreamer,
        // NOT the bundled one, so on a cross-distro AppImage they're rejected ("GStreamer
        // element ... not found") and a stream fails/crashes on load. Outside the AppImage
        // (.deb / `tauri dev`) nothing is bundled, so fall back to the host's plugin dirs
        // (there the system libgstreamer matches the system plugins).
        {
            let bundled = std::env::var_os("LD_LIBRARY_PATH").and_then(|ld| {
                std::env::split_paths(&ld)
                    .map(|d| d.join("gstreamer-1.0"))
                    // libgstcoreelements is in every GStreamer; ELF-check picks the host
                    // arch (multilib LD_LIBRARY_PATH lists the 32-bit dir first).
                    .find(|d| is_host_elf64(&d.join("libgstcoreelements.so")))
            });
            if let Some(gst) = bundled {
                std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", &gst);
                // bundleMediaFramework also bundles gst-plugin-scanner and points
                // GST_PLUGIN_SCANNER at it — leave that alone (a host scanner would be the
                // wrong version for the bundled plugins).
            } else {
                let mut dirs: Vec<&str> = vec![
                    "/usr/lib64/gstreamer-1.0",                // Fedora/RHEL/SUSE x86_64
                    "/usr/lib/x86_64-linux-gnu/gstreamer-1.0", // Debian/Ubuntu x86_64
                ];
                // `/usr/lib/gstreamer-1.0` is generic (Arch) but the i686 dir on Fedora
                // multilib — only fall back to it when no arch-specific dir exists.
                if !std::path::Path::new("/usr/lib64/gstreamer-1.0").is_dir()
                    && !std::path::Path::new("/usr/lib/x86_64-linux-gnu/gstreamer-1.0").is_dir()
                {
                    dirs.push("/usr/lib/gstreamer-1.0");
                }
                let current = std::env::var("GST_PLUGIN_SYSTEM_PATH_1_0").unwrap_or_default();
                let mut paths: Vec<&str> = current.split(':').filter(|s| !s.is_empty()).collect();
                for dir in dirs {
                    if std::path::Path::new(dir).is_dir() && !paths.contains(&dir) {
                        paths.push(dir);
                    }
                }
                if !paths.is_empty() {
                    std::env::set_var("GST_PLUGIN_SYSTEM_PATH_1_0", paths.join(":"));
                }
                let scanner_ok = std::env::var_os("GST_PLUGIN_SCANNER")
                    .map(|s| std::path::Path::new(&s).exists())
                    .unwrap_or(false);
                if !scanner_ok {
                    for scanner in [
                        "/usr/libexec/gstreamer-1.0/gst-plugin-scanner",
                        "/usr/lib/x86_64-linux-gnu/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
                        "/usr/lib/gstreamer-1.0/gst-plugin-scanner",
                    ] {
                        if std::path::Path::new(scanner).exists() {
                            std::env::set_var("GST_PLUGIN_SCANNER", scanner);
                            break;
                        }
                    }
                }
            }
        }
        // glib's TLS backend — glib-networking's `libgiognutls.so` GIO module — is what
        // lets the webview speak HTTPS. The AppImage bundles it, but the bundled glib
        // looks for GIO modules at its compiled-in (build-distro) path, which doesn't
        // exist on other distros: an ubuntu-built AppImage run on Fedora loads NO TLS
        // backend (GLib "invalid (NULL) pointer instance" criticals) and every https page
        // comes up blank — which looks like a network error. $APPDIR isn't set, but
        // AppRun puts the bundle's lib dirs on LD_LIBRARY_PATH and the gio/modules dir
        // sits under one of them; point GIO at the bundled module. No-op outside the
        // AppImage (the module isn't found there, so glib's system default is used).
        if std::env::var_os("GIO_MODULE_DIR").is_none() {
            if let Some(ld) = std::env::var_os("LD_LIBRARY_PATH") {
                for dir in std::env::split_paths(&ld) {
                    // Pick the HOST-arch module: on multilib LD_LIBRARY_PATH lists the
                    // 32-bit dir before the 64-bit one, and pointing glib at a wrong-arch
                    // module fails ("wrong ELF class: ELFCLASS32"), leaving TLS broken.
                    if is_host_elf64(&dir.join("gio/modules/libgiognutls.so")) {
                        let mods = dir.join("gio/modules");
                        std::env::set_var("GIO_MODULE_DIR", &mods);
                        std::env::set_var("GIO_EXTRA_MODULES", &mods); // older glib
                        eprintln!(
                            "[aegis] GIO_MODULE_DIR -> {} (bundled TLS backend)",
                            mods.display()
                        );
                        break;
                    }
                }
            }
        }
    }

    // Install the process-global rustls crypto provider once, up front: reqwest is
    // built with `rustls-no-provider` (via the updater plugin), so every TLS client
    // — the updater's and our filter-list fetcher's — needs a provider in the global
    // slot before it builds, or it panics ("No rustls crypto provider is configured").
    match rustls::crypto::aws_lc_rs::default_provider().install_default() {
        Ok(()) => eprintln!("[aegis] rustls aws-lc-rs provider installed"),
        Err(_) => eprintln!("[aegis] rustls provider was already installed"),
    }

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        // No dialog plugin, deliberately. `tauri-plugin-dialog` was registered here
        // with no caller, no `dialog:*` grant in `capabilities/default.json` and no
        // JS package, so nothing could ever have reached it. Separately, `data.rs`
        // records that the native save dialog is not wanted: it renders in the OS's
        // light theme and clashes with the dark UI, so a backup is written to a fixed
        // location and never named by a dialog. `DataTab` picks a file to IMPORT with
        // the webview's own `<input type="file">`, which needs no permission at all.
        // `tests::no_dialog_plugin_is_registered_or_declared` keeps it gone.
        .manage(view::ContentInset::default())
        .manage(update::UpdateState::default())
        .manage(adblock::AdblockState::default())
        .manage(safety::SafetyState::default())
        .manage(sync::SyncState::default())
        .manage(redirect_guard::PendingNavs::default())
        .manage(redirect_guard::NavActions::default())
        .manage(redirect_guard::Chains::default())
        .manage(redirect_guard::RedirectBudget::default())
        .manage(zoom::ZoomStore::default())
        .manage(vault::VaultState::default())
        .manage(farble::FarbleState::default())
        .manage(proxy::ProxyState::default())
        .manage(settings::SettingsCache::default())
        .manage(history::HistoryStore::default())
        .manage(downloads::DownloadsStore::default());

    // Tab keyboard shortcuts arrive as menu events on Win/macOS (Linux uses a GTK key
    // hook). Menus are a desktop-only Tauri feature, so this handler is desktop-gated;
    // mobile has no menu bar (and tabs are a single-webview stub there).
    #[cfg(desktop)]
    let builder = builder.on_menu_event(|app, event| {
        let s = match event.id().0.as_str() {
            "tab_new" => "new",
            "tab_close" => "close",
            "tab_reopen" => "reopen",
            "tab_next" => "next",
            "tab_prev" => "prev",
            _ => return,
        };
        crate::emit_event(app, "tabs.shortcut", s);
    });

    let builder = builder.setup(|app| {
        #[cfg(debug_assertions)]
        let t_setup = std::time::Instant::now();

        if cfg!(debug_assertions) {
            app.handle().plugin(
                tauri_plugin_log::Builder::default()
                    .level(log::LevelFilter::Info)
                    .build(),
            )?;
        }

        // Android: seed the WebRTC document-start shim's policy from settings (its JNI
        // getter has no AppHandle). Kept fresh on settings change in settings.rs.
        // NOTE: the farble level is an app-free JNI global too, and it is seeded by
        // `farble::seed_from_disk` further down — which is also where the fp-allowlist is
        // seeded, so the two farble globals are seeded in one place. If you add a THIRD
        // app-free global for a JNI getter, seed it here or in its owning module's boot
        // hook; the getters have no other way to read settings.
        #[cfg(target_os = "android")]
        crate::webrtc_shim::note_policy(&crate::settings::webrtc_policy(app.handle()));

        // The HTTPS-Only policy, mirrored into the app-free global `MainActivity.secureUrl`
        // reads so Android honours the setting instead of hardcoding the upgrade. Same
        // obligation as the two lines above, and the same reason: `secureUrl` is the single
        // chokepoint for every Android navigation decision and has no `AppHandle` to read
        // the store with. `settings::write` keeps it current on every change.
        //
        // The cfg matches `ANDROID_HTTPS_ONLY`'s own exactly, so the global and the only
        // thing that seeds it can never disagree about which platforms have it.
        #[cfg(any(target_os = "android", test))]
        {
            crate::settings::note_https_only(crate::settings::https_only(app.handle()));
        }

        // The WebRTC IP-leak exemptions, mirrored into the app-free global the JNI
        // document-start getter reads — same obligation as the policy line above, and for
        // the same reason: that getter runs on a JNI thread with no AppHandle. Unconditional
        // (the fn is a no-op off Android) so the boot path is the one place to look.
        crate::webrtc_exempt::seed_from_disk(app.handle());

        // Anti-fingerprinting: generate the per-session salt from the OS CSPRNG. Idempotent.
        // The salt is NEVER persisted — it resets on every launch (Brave-style farbling seed).
        crate::farble::init_session_salt();

        // Seed the ad-block allowlist from disk (the managed AdblockState was created
        // empty at builder time) + mirror it into the engine — so allowlisted hosts
        // survive a restart on every platform.
        crate::adblock::seed_from_disk(app.handle());

        // Seed the fingerprint per-site allowlist from disk (the managed FarbleState was
        // created empty at builder time) — so allowlisted hosts survive a restart.
        crate::farble::seed_from_disk(app.handle());

        // Seed the HLC clock from the stamps already on disk. MUST run before anything can stamp
        // a record (or any sync pass can observe a remote one). The clock is a process-global
        // that starts at (0, 0) and is never persisted, so without this the first local edit
        // after a restart is stamped below any record already holding a later wall — loses
        // last-writer-wins, is silently reverted by the next merge, and can never be won back.
        // See `sync_envelope::seed_clock` for the full failure mode. This is a no-op on a device
        // with nothing stamped, and it never moves the clock backwards.
        crate::sync_stores::seed_hlc_clock(app.handle());

        // Seed the built-in default filter-list subscriptions (EasyList, EasyPrivacy,
        // Peter Lowe's) on first run so they show in the Filter Lists UI and are
        // refreshable. Idempotent + tombstone-aware (never resurrects a default the user
        // removed). Seeds ROWS only (no boot fetch — the baked-in adblock_lists copies
        // already block, and a boot fetch would re-apply the WebKit content filters
        // mid-launch); the defaults refresh on "Update all" or an off→on toggle.
        crate::subs::seed_defaults(app.handle());

        // Seed ProxyState from persisted settings so a saved proxy config is live on the
        // first tab spawn (Tasks 3-6 apply it to the content webview).
        {
            let cfg =
                crate::proxy::ProxyConfig::from_value(&crate::settings::proxy_config(app.handle()));
            if let Some(st) = app.handle().try_state::<crate::proxy::ProxyState>() {
                *st.0.lock().unwrap_or_else(|e| e.into_inner()) = cfg;
            }
            // Apply the persisted proxy immediately so a saved ON config is live from the
            // first navigation (no-op now; Tasks 3-6 fill apply() with per-platform setters).
            crate::proxy::apply(app.handle());
        }

        // Initialize the tab registry: restore from tabs.json if it exists,
        // otherwise start fresh with the configured home page.  Only the active
        // tab gets an eager webview; the rest lazy-spawn on activation.
        #[cfg(debug_assertions)]
        let t_session = std::time::Instant::now();
        let home = crate::settings::home_url(app.handle()).to_string();
        let reg = match tabs::load_session(app.handle()) {
            Some(session) => crate::tab_registry::Registry::restore(session, home.clone()),
            None => crate::tab_registry::Registry::new(home.clone()),
        };
        app.manage(tabs::Tabs::from_registry(reg));
        let active = app
            .state::<tabs::Tabs>()
            .reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active_id();
        let active_url = app
            .state::<tabs::Tabs>()
            .reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .url_of(active)
            .map(str::to_string);
        if let Some(url) = active_url {
            // `tabs.json` is attacker-influenced input: it is written from URLs the
            // content webview reported loading, and it persists across upgrades. A
            // `file:` entry written before `nav::is_navigable` existed would otherwise
            // be re-loaded as a tab on every single launch. Refuse and start on a blank
            // tab — a poisoned session file must not be able to abort `setup`, which
            // would take the whole app down.
            match nav::parse_navigable(&url) {
                Ok(u) => {
                    nav::spawn_tab(app.handle(), active, u, false)?;
                }
                Err(e) => {
                    log::warn!("[aegis] session restore refused persisted tab url: {e}");
                }
            }
        }
        #[cfg(debug_assertions)]
        log::info!(
            "[aegis-perf] setup: session restore + first tab took {}ms",
            t_session.elapsed().as_millis()
        );
        tabs::start_idle_sweep(app.handle());

        // Sync: auto-unlock from the OS keychain if a seed is stored, and start syncing.
        //
        // ORDERING: this MUST run after every `.manage()` above — in particular after
        // `tabs::Tabs`. Tauri builds the configured windows/webviews (app.rs
        // `setup()`: the `WebviewWindowBuilder::from_config` loop) BEFORE it invokes
        // this `setup` closure, so the renderer's first IPCs are already in flight
        // while we are still registering state. Any IPC that reaches a
        // `.state::<Tabs>()` in that window panics, and because it unwinds through a
        // `extern "system"` JNI frame it cannot be caught — the whole process aborts
        // with SIGABRT ("state() called before manage() for app_lib::tabs::Tabs").
        // The boot restore does real blocking work (a JNI round-trip into the
        // hardware keystore, ~100ms+ on a StrongBox device) which used to sit *before*
        // `manage(Tabs)` and reliably lost that race, killing the app on every launch
        // once the seed finally started persisting. Restoring the root is also more
        // correct with the registry live, since the restore kicks off a sync pass.
        crate::sync::start(app.handle());

        // Coalesce per-navigation history writes into a periodic background flush (the
        // live history lives in an in-memory cache; see history.rs "Write batching").
        history::start_flush(app.handle());
        // Android only: publish the handle the JNI entry points need. On desktop a page
        // load is recorded from wry's `on_page_load` (nav.rs) and a download from the
        // content webview's on_download handler; Android's content view is a native
        // Kotlin WebView, so Kotlin has to report both down to us, and both need
        // managed state. Must come after every `.manage()` above — see the ordering note
        // on `sync::start`.
        #[cfg(target_os = "android")]
        set_android_app(app.handle());
        // Same batching for downloads (per-event full-file fsync → periodic flush).
        downloads::start_flush(app.handle());

        // Form detection: install the event listener that bridges detection
        // results from the content webview's JS emit back to waiting IPC calls.
        form::install_listener(app.handle());

        // Tauri child-webview auto-resize is incomplete; recompute bounds on
        // window resize so the content view keeps filling the area below the chrome.
        // Linux: the content/chrome webviews are sized via size_allocate (not
        // set_size_request, which pins the window's minimum to its current size so it can't
        // shrink — see linux_layout's SIZING NOTE). Register the insets state the sizing
        // handler reads before the first layout pass below.
        #[cfg(target_os = "linux")]
        app.manage(linux_layout::LayoutInsets::default());
        if let Some(window) = app.get_window("main") {
            // A sane floor so the window can shrink (the bug was it couldn't at all) without
            // collapsing to an unusable size. Effective now that the webviews no longer pin it.
            let _ = window.set_min_size(Some(tauri::LogicalSize::new(420.0, 320.0)));
            let handle = app.handle().clone();
            window.on_window_event(move |event| {
                // `on_window_resized` — not `apply_inset` — because tao emits `Resized` for
                // EVERY configure, including the pure moves a window DRAG is made of, so an
                // unguarded handler re-ran the whole GTK layout once per drag frame. See
                // `view::on_window_resized`.
                if let tauri::WindowEvent::Resized(size) = event {
                    view::on_window_resized(&handle, (size.width, size.height));
                }
            });
        }
        view::apply_inset(app.handle());

        // Emit the restored tabs state so the chrome renders all tabs immediately
        // (belt-and-suspenders: the chrome also calls tabs.list on mount).
        crate::emit_event(app.handle(), "tabs.state", {
            let s = app
                .state::<tabs::Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .tabs_state();
            serde_json::to_value(s).unwrap_or(serde_json::Value::Null)
        });

        // Win/macOS: install a "Tabs" menu with accelerators so native OS-level
        // key capture delivers Ctrl+T/W/Tab etc. even when the content webview has
        // focus. Linux uses a GTK key hook instead (connect_tab_keys_label).
        #[cfg(all(desktop, not(target_os = "linux")))]
        install_tab_menu(app.handle())?;

        // Linux: render native widgets (the <select> popup menus, file dialogs)
        // in the dark variant so they match Aegis's always-dark UI instead of a
        // white system-light theme. Sets the GTK app-wide "prefer dark" hint.
        #[cfg(target_os = "linux")]
        {
            use gtk::prelude::*;
            if let Some(gset) = gtk::Settings::default() {
                gset.set_gtk_application_prefer_dark_theme(true);
                // Select a concrete dark theme by name (Adwaita-dark is built into
                // GTK). prefer-dark alone is a no-op on themes like Breeze whose dark
                // form is a separate theme, and the GTK_THEME env didn't take — set
                // it directly on the live Settings so native dialogs render dark.
                gset.set_gtk_theme_name(Some("Adwaita-dark"));
            }
            // Style the native floating fullscreen-exit button (linux_layout's
            // `#aegis-fs-exit`) so it matches the dark UI: a small dark box with a
            // light ↘↖ (arrows pointing inward — matches the React Minimize2 exit
            // icon), pinned top-right over edge-to-edge fullscreen content.
            let css = gtk::CssProvider::new();
            let _ = css.load_from_data(
                b"#aegis-fs-exit{background-color:#1f1f1f;border:1px solid #3a3a3a;}\
                      #aegis-fs-exit:hover{background-color:#333333;}\
                      #aegis-fs-exit label{color:#eaeaea;font-size:15px;font-weight:700;}",
            );
            if let Some(screen) = gtk::gdk::Screen::default() {
                gtk::StyleContext::add_provider_for_screen(
                    &screen,
                    &css,
                    gtk::STYLE_PROVIDER_PRIORITY_APPLICATION,
                );
            }
        }

        // The per-tab WebKit signal hooks (permission handler, title→history +
        // picker sentinel, Esc-exits-fullscreen) are installed at spawn time in
        // nav::spawn_tab — including for the first tab spawned above — so they're
        // no longer wired here.

        // Ad-blocking (Linux/WebKit): install EasyList content filters.
        #[cfg(target_os = "linux")]
        install_adblock(app.handle().clone());
        // Pre-warm the WebRTC + farble shim variants so the first tab spawn doesn't
        // pay string-building cost on the UI thread. Cheap (three OnceLock sets).
        #[cfg(debug_assertions)]
        let t_prewarm = std::time::Instant::now();
        webrtc_shim::prewarm();
        #[cfg(debug_assertions)]
        log::info!(
            "[aegis-perf] setup: shim prewarm took {}ms",
            t_prewarm.elapsed().as_millis()
        );
        // Warm the pop-under matching engine off-thread so the first window.open
        // check (nav::on_new_window) doesn't pay the EasyList parse on the UI thread.
        // (Android already warms it on the first intercepted request.)
        #[cfg(desktop)]
        {
            #[cfg(debug_assertions)]
            let t_engine = std::time::Instant::now();
            std::thread::spawn(|| {
                let _ = adblock_engine::should_block(
                    "https://aegis.invalid/",
                    "https://aegis.invalid/",
                    "document",
                );
            });
            #[cfg(debug_assertions)]
            log::info!(
                "[aegis-perf] setup: ad-block engine warm-up dispatched in {}ms",
                t_engine.elapsed().as_millis()
            );
        }
        #[cfg(debug_assertions)]
        log::info!(
            "[aegis-perf] setup: total setup took {}ms",
            t_setup.elapsed().as_millis()
        );
        Ok(())
    });
    let builder = builder.invoke_handler(tauri::generate_handler![ipc]);

    builder
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::ffi_guard;

    /// The needle for a module-level allow attribute, assembled at two halves on purpose.
    /// Written as one literal it would sit in this file's own source, and this file is one
    /// of the files the scan below reads — so the scan would match its own matcher and
    /// report `lib.rs` as an offender on every run, with no way to tell that apart from a
    /// real finding. This is the same self-reference trap `rust_production_source` exists
    /// to close, one level up: there it was a whole test, here it is a single constant.
    const MODULE_ALLOW_PREFIX: &str = concat!("#", "![allow(");

    /// The capability is the renderer's ENTIRE authorisation surface, and it is
    /// load-time configuration rather than code, so nothing else in the crate
    /// changes when it is widened. Read from the file, not from a constant, because a
    /// constant would be a restatement rather than a check.
    ///
    /// The whole file is the assertion, not a prefix: a capability that grows a
    /// permission the app never calls is the exact failure this pins. `core:default`
    /// expands to nine sub-permission sets — `path`, `event`, `window`, `webview`,
    /// `app`, `image`, `resources`, `menu` and `tray` — which is 92 individual
    /// `allow-*` permissions over window geometry, menu and tray construction, and
    /// filesystem path resolution. The renderer reaches none of them: it imports from
    /// `@tauri-apps/api` in exactly two files, `tauriInvoke.ts:1-2`, for `invoke`
    /// (the app's own `ipc` command, which is not ACL-gated) and `listen`. So the
    /// capability names precisely the one set those two need, and dropping `core:default`
    /// removes 92 reachable-by-mistake grants.
    #[test]
    fn the_renderer_capability_grants_only_the_event_permission() {
        let path = format!("{}/capabilities/default.json", env!("CARGO_MANIFEST_DIR"));
        let raw =
            std::fs::read_to_string(&path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"));
        let v: serde_json::Value =
            serde_json::from_str(&raw).unwrap_or_else(|e| panic!("{path} is not JSON: {e}"));
        let perms: Vec<&str> = v["permissions"]
            .as_array()
            .expect("capabilities/default.json must carry a `permissions` array")
            .iter()
            .map(|p| p.as_str().expect("every permission must be a string"))
            .collect();
        assert_eq!(
            perms,
            vec!["core:event:default"],
            "the renderer capability must name ONLY core:event:default — widen it here and in \
             the same commit add the code that needs the new permission, with a test"
        );
        // The identifier and window scope are what make this the *only* capability, so
        // assert them too: a second file in capabilities/ would grant a second surface
        // and this test would keep passing.
        assert_eq!(v["identifier"], "default", "the identifier must not change");
        assert_eq!(
            v["windows"][0], "main",
            "the capability must stay bound to `main`"
        );
    }

    /// The dialog plugin must stay GONE. It was registered with no `dialog:*` grant in
    /// `capabilities/default.json`, no JS package and no caller, so nothing could have
    /// reached it — and `data.rs` records a separate, deliberate reason not to want it
    /// (the native save dialog renders in the OS light theme and clashes with the dark
    /// UI; a backup is written to a fixed location instead, and `DataTab` picks a file to
    /// import with the webview's own `<input type="file">`, which needs no permission).
    ///
    /// The manifest is the load-bearing half: with the dependency gone, registering the
    /// plugin is a COMPILE error, so the source scan can only ever fire if somebody
    /// re-declared the dependency first — at which point the first assertion fails. The two
    /// together state the invariant in both places it could be broken, and the scan covers
    /// every `.rs` file rather than only the crate root.
    #[test]
    fn no_dialog_plugin_is_registered_or_declared() {
        let manifest = format!("{}/Cargo.toml", env!("CARGO_MANIFEST_DIR"));
        let raw = std::fs::read_to_string(&manifest)
            .unwrap_or_else(|e| panic!("cannot read {manifest}: {e}"));
        // Parse the `[dependencies]` table rather than searching the file, so a mention
        // in a comment or in another table cannot satisfy (or trip) this.
        let mut in_deps = false;
        let mut names: Vec<&str> = Vec::new();
        for line in raw.lines() {
            let line = line.trim();
            if line.starts_with('[') {
                in_deps = line == "[dependencies]";
                continue;
            }
            if in_deps && !line.is_empty() && !line.starts_with('#') {
                if let Some((name, _)) = line.split_once('=') {
                    names.push(name.trim());
                }
            }
        }
        assert!(
            !names.contains(&"tauri-plugin-dialog"),
            "tauri-plugin-dialog is back in [dependencies] — if something now needs an OS \
             native file dialog, say so in the commit that adds it and grant the matching \
             `dialog:*` permission in capabilities/default.json at the same time"
        );

        // And the Rust path form must appear in no source file of the crate — not just this
        // one, because a refactor could move the builder out of the crate root.
        //
        // The needle is assembled at runtime, and that is load-bearing twice over. A literal
        // here would match its own assertion, which is exactly what the first version did
        // (it reddened for a string it had just written). And `Vec::concat` joins with NO
        // separator, so a two-element split that looks right reads as a path that does not
        // exist — the needle would match nothing at all and the scan would be vacuous. The
        // self-check below is what makes that failure mode loud instead of silent.
        let needle = ["tauri", "_plugin_", "dialog", "::"].concat();
        let realistic = ["tauri", "_plugin_", "dialog", "::init()"].concat();
        assert!(
            realistic.contains(&needle),
            "the needle no longer matches a realistic registration, so the scan below is vacuous"
        );

        let src_dir = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
        let mut offenders: Vec<String> = Vec::new();
        for entry in std::fs::read_dir(&src_dir).expect("the crate's src/ directory is readable") {
            let path = entry.expect("readable directory entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            let text = std::fs::read_to_string(&path).expect("readable .rs source file");
            if text.contains(&needle) {
                offenders.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }
        assert!(
            offenders.is_empty(),
            "a dialog plugin is being registered again, in {offenders:?}"
        );
    }

    /// Classify a source file: which of its lines are a MODULE-level blanket dead-code
    /// allow? Pulled out of the scan so the RULE the scan applies is itself under test,
    /// instead of the scan being the only place the rule exists and being trusted.
    ///
    /// Only a line that trims to start with a module-level `allow(` and mentions
    /// `dead_code` counts. That deliberately excludes two things that must NOT be
    /// counted: a per-item `allow(dead_code)` or `cfg_attr(..., allow(dead_code))`,
    /// which is scoped to one item and is the form the repo actually wants, and a
    /// commented-out example.
    fn blanket_dead_code_allow_lines(text: &str) -> Vec<usize> {
        text.lines()
            .enumerate()
            .filter(|(_, line)| {
                let t = line.trim();
                t.starts_with(MODULE_ALLOW_PREFIX) && t.contains("dead_code")
            })
            .map(|(i, _)| i + 1)
            .collect()
    }

    /// A module must not carry a blanket dead-code allow.
    ///
    /// Two did, and the two needed DIFFERENT fixes, which is why the scan asserts the
    /// surviving set rather than asserting an empty one. `adblock_webkit` is declared
    /// `#[cfg(target_os = "linux")]`, so on the only platform that compiles it nothing in
    /// it is dead: its allow was pure dead weight, and under CI's externally injected
    /// `-D warnings` a pure-dead-weight allow still suppresses that platform's REAL
    /// diagnostics. `adblock_convert` is declared unconditionally, but its only caller,
    /// `install_adblock`, is `#[cfg(target_os = "linux")]` — so on Windows/macOS/Android
    /// the entire module is dead and the allow was genuinely load-bearing there. For
    /// that one the honest spelling is a cfg gate on the `mod` declaration, which is
    /// what landed; an allow cannot distinguish "dead here" from "dead everywhere".
    ///
    /// It also used to pin THREE module-level allows by name, because an "empty"
    /// assertion could not be written then without lying. All three are gone now
    /// (`adblock_lists`, `sync_stores`, `sync_vault`), so the assertion is the empty set
    /// and the list is empty because every one of them was unnecessary rather than
    /// because the scan stopped looking: all three are declared with a PRIVATE
    /// `mod X;`, so nothing inside them is exported and rustc applies the same
    /// effective-visibility cap to a `staticlib`, a `cdylib` and an `rlib` alike. The
    /// `sync_stores` comment that argued for its allow ("unused pub items warn on the
    /// Android cdylib build, unlike the host rlib") is exactly the argument that cannot
    /// hold for a private module, and it is the reason the three went: they were
    /// suppressing the diagnostics they were supposed to be standing in for.
    #[test]
    fn no_module_carries_a_blanket_dead_code_allow() {
        let src_dir = format!("{}/src", env!("CARGO_MANIFEST_DIR"));
        let mut offenders: Vec<String> = Vec::new();
        let mut read = 0usize;
        for entry in std::fs::read_dir(&src_dir).expect("the crate's src/ directory is readable") {
            let path = entry.expect("readable directory entry").path();
            if path.extension().and_then(|e| e.to_str()) != Some("rs") {
                continue;
            }
            read += 1;
            let text = std::fs::read_to_string(&path).expect("readable .rs source file");
            if !blanket_dead_code_allow_lines(&text).is_empty() {
                offenders.push(
                    path.file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .into_owned(),
                );
            }
        }

        // `read_dir` yields entries in whatever order the FILESYSTEM hands them back, which
        // is not a contract: this list came out alphabetical on the ext4 dev box and in
        // inode order on CI's runner, so the assertion below failed there while passing
        // here with the same three files. The assertion's claim is "exactly these three",
        // which is a claim about the SET, so compare the set. (This test is the only thing
        // that ever compared the two, and it shipped red on its first CI run.)
        offenders.sort();

        // A walk that read nothing would satisfy any offender-list assertion, so the
        // number of files read is checked against the number of module declarations the
        // crate root makes: every `mod X;` needs a file of that name, so a scan that
        // silently stopped early is loud instead of green.
        let crate_root = std::fs::read_to_string(format!("{src_dir}/lib.rs"))
            .expect("the crate root is readable");
        let declared = crate_root
            .lines()
            .filter(|l| {
                let t = l.trim();
                t.starts_with("mod ") && t.ends_with(';')
            })
            .count();
        assert!(
            read >= declared,
            "the scan read {read} .rs files but lib.rs declares {declared} modules, so the walk \
             is not finding every file and an offender list of {offenders:?} would prove nothing"
        );

        assert_eq!(
            offenders,
            Vec::<String>::new(),
            "a module gained a blanket dead-code allow. Give the module a cfg gate instead — and \
             keep a `test` arm on it so its unit tests still run on the platforms where it is \
             otherwise absent. A blanket allow hides dead code on the platform that DOES \
             compile the module, which is exactly where you want to hear about it. A module \
             declared PRIVATE never needs one at all: nothing inside it is exported, so \
             rustc already applies the dead-code cap on every crate type, `cdylib` included."
        );
    }

    /// The scan's rule, tested on a source that contains every shape it must judge. A
    /// sample is the only way to prove the negative cases, because the live crate has
    /// none of them to find.
    #[test]
    fn the_blanket_allow_scan_separates_module_allows_from_scoped_and_commented_ones() {
        let sample = concat!(
            "#![allow(dead_code)]\n",
            "  #![allow(dead_code)]  // indented, still module level\n",
            "#![allow(unused_imports)]\n",
            "#[allow(dead_code)]\n",
            "#[cfg_attr(target_os = \"android\", allow(dead_code))]\n",
            "// #![allow(dead_code)]\n",
            "/* #![allow(dead_code)] */\n",
            "fn clean() {}\n",
        );
        assert_eq!(
            blanket_dead_code_allow_lines(sample),
            vec![1, 2],
            "only the two module-level allows count: the per-item attribute, the cfg_attr, the \
             line comment, the block comment and the unrelated module allow are all not one"
        );
    }

    /// The window-resize handler must NOT run the layout on every configure event.
    ///
    /// tao 0.35.3 emits `WindowEvent::Resized` from its `connect_configure_event` handler with
    /// **no comparison against the previous size** — a ConfigureNotify whose position changed
    /// but whose size did not still arrives as `Resized`. So the unguarded `Resized => apply_inset`
    /// this replaces ran `layout()` once per frame of a window DRAG, and each of those ran
    /// `linux_layout::size_fixed_children`, which collapsed the content webview to 1x1 and
    /// re-expanded it (WebKit re-laying-out the whole page twice per frame). That is the
    /// "the content flickers continuously while I move the window" report, and the collapse
    /// itself is pinned in `linux_layout`'s tests.
    #[test]
    fn the_resize_handler_does_not_re_run_the_layout_for_a_configure_that_only_moved() {
        let src = crate::test_support::rust_production_source(include_str!("lib.rs"));
        let handler = src
            .split("window.on_window_event")
            .nth(1)
            .and_then(|rest| rest.split("});").next())
            .expect("lib.rs still registers window.on_window_event");
        assert!(
            handler.contains("on_window_resized"),
            "the Resized arm still calls the layout unconditionally; tao sends Resized for EVERY \
             configure, so a pure window move re-runs layout() once per drag frame"
        );
        assert!(
            !handler.contains("view::apply_inset"),
            "the Resized arm bypasses the size-unchanged check (on_window_resized owns it)"
        );
    }

    /// The gate belongs on the DECLARATION. A cfg on the module's own items would leave
    /// the file compiled everywhere with the rest of it dead, which is the blanket allow
    /// again under a different spelling. Read the crate root's PRODUCTION source, so
    /// this test's own text cannot satisfy the search — the same trap
    /// `rust_production_source` was added for, and `include_str!` of this file returns
    /// this test.
    #[test]
    fn adblock_convert_is_gated_at_its_mod_declaration() {
        let src = crate::test_support::rust_production_source(include_str!("lib.rs"));
        let lines: Vec<&str> = src.lines().collect();
        let at = lines
            .iter()
            .position(|l| l.trim() == "mod adblock_convert;")
            .expect("lib.rs still declares the adblock_convert module");
        let gate = lines[..at]
            .iter()
            .rev()
            .find(|l| !l.trim().is_empty())
            .expect("the declaration has a line above it");
        assert!(
            gate.trim().starts_with("#[cfg("),
            "adblock_convert is declared with no cfg attribute ({gate:?}). Its only caller is \
             `install_adblock`, which is `#[cfg(target_os = \"linux\")]`, so the module is dead \
             on every other platform and needs a gate on the declaration, not an allow"
        );
        assert!(
            gate.contains("linux") && gate.contains("test"),
            "the gate must compile the module where it has a caller AND under test, or its eight \
             conversion tests stop running off Linux ({gate:?})"
        );
    }

    /// The `test` arm of that gate, proven at COMPILE time rather than by reading it: this
    /// reference only resolves if `adblock_convert` is compiled in a test build. If the gate
    /// ever loses its `test` condition, this stops building on Windows, macOS and Android,
    /// and eight conversion tests quietly vanish from those platforms' runs. A string
    /// assertion could not catch that — it would keep passing.
    #[test]
    fn adblock_convert_is_compiled_for_its_own_tests_off_linux() {
        assert_eq!(
            crate::adblock_convert::to_content_blocker_chunks(&[], 1, &[]).expect("no rules in"),
            Vec::<String>::new(),
            "an empty filter list converts to no chunks at all"
        );
    }

    /// `ffi_guard` is only CALLED from `#[cfg(target_os = "android")]` JNI exports, so
    /// without a test that exercises it on every platform it would be dead code on
    /// Linux/Windows/macOS and trip `clippy -D warnings`. Testing it here also means the
    /// one piece of panic-safety machinery every Android export depends on is covered by
    /// the ordinary `cargo test` run instead of only on a device.
    #[test]
    fn ffi_guard_passes_a_normal_result_through() {
        assert_eq!(ffi_guard(|| 42u32), Some(42));
        assert_eq!(ffi_guard(|| "ok"), Some("ok"));
        assert_eq!(ffi_guard(Vec::<u8>::new), Some(Vec::new()));
    }

    /// The whole point: a panic must come back as `None`, not unwind past the caller.
    /// `catch_unwind` still PRINTS the panic (it does not abort the process), so the
    /// test output carries one expected panic message per case.
    #[test]
    fn ffi_guard_turns_a_panic_into_none() {
        assert_eq!(ffi_guard(|| panic!("boom")), None);
        assert_eq!(
            ffi_guard(|| -> u32 { panic!("boom") }),
            None,
            "a panicking closure with a non-() return type must still yield None"
        );
    }

    /// It must also catch a panic that happens *while unwinding is already propagating
    /// through a nested frame*, i.e. from a closure that calls another panicking
    /// closure. This is the shape of the real risk: a JNI export's body calls a helper
    /// that calls into a third-party crate (the `adblock` engine, a KDF) which panics.
    #[test]
    fn ffi_guard_catches_a_panic_from_a_nested_call() {
        fn inner() -> u8 {
            panic!("nested boom")
        }
        fn outer() -> u8 {
            inner()
        }
        assert_eq!(ffi_guard(outer), None);
    }
}
