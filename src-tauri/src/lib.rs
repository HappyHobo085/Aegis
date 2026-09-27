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
#[cfg(target_os = "linux")]
#[allow(unsafe_code)] // FFI/platform glue; see the deny(unsafe_code) in lib.rs
mod linux_layout;
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
        .plugin(tauri_plugin_dialog::init())
        .manage(view::ContentInset::default())
        .manage(update::UpdateState::default())
        .manage(adblock::AdblockState::default())
        .manage(safety::SafetyState::default())
        .manage(sync::SyncState::default())
        .manage(redirect_guard::PendingNavs::default())
        .manage(redirect_guard::NavActions::default())
        .manage(redirect_guard::Chains::default())
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
        // Android only: publish the handle the `NativeHistory.recordVisit` JNI entry
        // point needs. On desktop the visit is recorded from wry's `on_page_load`
        // (nav.rs); Android's content view is a native Kotlin WebView, so Kotlin has to
        // report the load down to us, and recording needs managed state. Must come after
        // every `.manage()` above — see the ordering note on `sync::start`.
        #[cfg(target_os = "android")]
        history::set_android_app(app.handle());
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
                if let tauri::WindowEvent::Resized(_) = event {
                    view::apply_inset(&handle);
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
