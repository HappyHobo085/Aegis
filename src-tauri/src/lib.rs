mod adblock;
mod adblock_convert;
// Chromium-side network ad-blocking engine (`should_block`). Compiled on Android (JNI
// export) and Windows (WebView2 interception, adblock_win) and under `cargo test`.
#[cfg(any(target_os = "android", target_os = "windows", test))]
mod adblock_engine;
// Windows full network ad-block: our own WebView2 WebResourceRequested interceptor.
#[cfg(target_os = "windows")]
mod adblock_win;
// Injected (document-start) ad/tracker blocker for the desktop content webview — the
// ad-block layer on Windows/macOS (wry can't intercept their requests), verifiable on
// Linux where it supplements the WebKit content filters.
#[cfg(any(desktop, test))]
mod adblock_inject;
#[cfg(target_os = "linux")]
mod adblock_webkit;
#[cfg(target_os = "linux")]
mod linux_layout;
mod customfilters;
mod data;
mod downloads;
mod history;
mod jsonstore;
mod nav;
mod permissions;
mod picker;
mod places;
mod safety;
mod settings;
mod subs;
mod tab_registry;
mod update;
mod view;

use serde_json::Value;
use tauri::{Emitter, Manager};

/// Emit a frontend event. Tauri 2 forbids `.` in event names, but our shared
/// `IPC.evt*` names use dots (Electron's IPC allows them); translate `.`→`:` so
/// the JS listener (which applies the same translation in tauriInvoke.ts) receives
/// it. Without this, every `listen()` is rejected and no rust→renderer event fires.
pub fn emit_event<S: serde::Serialize + Clone>(app: &tauri::AppHandle, name: &str, payload: S) {
    let _ = app.emit(&name.replace('.', ":"), payload);
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
    if let Some(result) = data::dispatch(&app, &channel, &payload) {
        return result;
    }
    if let Some(result) = safety::dispatch(&app, &channel, &payload) {
        return result;
    }

    let v = match channel.as_str() {
        "lists.updateNow" => subs::update_all(&app),

        // Fire-and-forget actions (history.remove/clear, permissions.resolve,
        // downloads.openFile/showInFolder, update.*, safety.proceed/removeException)
        // resolve to null (Promise<void>).
        _ => Value::Null,
    };
    Ok(v)
}

/// Convert EasyList to content-blocker JSON on a background thread and load it as
/// WebKit content filters (cached after the first compile). Called at boot and
/// whenever ad-blocking is re-enabled.
#[cfg(target_os = "linux")]
pub fn install_adblock(app: tauri::AppHandle) {
    let store_dir = app
        .path()
        .app_cache_dir()
        .unwrap_or_else(|_| std::path::PathBuf::from("/tmp/aegis"))
        .join("content-filters");
    let custom = customfilters::load(&app);
    let subs_text = subs::enabled_text(&app);
    std::thread::spawn(move || {
        use std::hash::{Hash, Hasher};
        const EASYLIST: &str = include_str!("../resources/easylist.txt");
        // Cache key = source hash (EasyList + custom rules + enabled subscriptions).
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        EASYLIST.hash(&mut hasher);
        custom.hash(&mut hasher);
        subs_text.hash(&mut hasher);
        let marker = store_dir.join(format!("v{:x}.ready", hasher.finish()));
        let cached = marker.exists();
        match adblock_convert::to_content_blocker_chunks(&[EASYLIST, &custom, &subs_text], 25_000) {
            Ok(chunks) => {
                eprintln!("[aegis-cf] EasyList -> {} chunks (cached={cached})", chunks.len());
                adblock_webkit::apply_filters(&app, chunks, store_dir.clone(), cached);
                if !cached {
                    let _ = std::fs::create_dir_all(&store_dir);
                    let _ = std::fs::write(&marker, b"");
                }
            }
            Err(e) => eprintln!("[aegis-cf] convert failed: {e}"),
        }
    });
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
    }

    // Install the process-global rustls crypto provider once, up front: reqwest is
    // built with `rustls-no-provider` (via the updater plugin), so every TLS client
    // — the updater's and our filter-list fetcher's — needs a provider in the global
    // slot before it builds, or it panics ("No rustls crypto provider is configured").
    match rustls::crypto::aws_lc_rs::default_provider().install_default() {
        Ok(()) => eprintln!("[aegis] rustls aws-lc-rs provider installed"),
        Err(_) => eprintln!("[aegis] rustls provider was already installed"),
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_dialog::init())
        .manage(view::ContentInset::default())
        .manage(update::UpdateState::default())
        .manage(adblock::AdblockState::default())
        .manage(safety::SafetyState::default())
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Add the content webview (the browsed page) below the chrome.
            nav::spawn_content(app.handle())?;

            // Tauri child-webview auto-resize is incomplete; recompute bounds on
            // window resize so the content view keeps filling the area below the chrome.
            if let Some(window) = app.get_window("main") {
                let handle = app.handle().clone();
                window.on_window_event(move |event| {
                    if let tauri::WindowEvent::Resized(_) = event {
                        view::apply_inset(&handle);
                    }
                });
            }
            view::apply_inset(app.handle());

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
                // light ✕, pinned top-right over edge-to-edge fullscreen content.
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

            // Content-webview permission requests: prompt (remembered per origin),
            // deny unrecognized types (Linux).
            #[cfg(target_os = "linux")]
            permissions::install_handler(app.handle());

            // Fill history entries' titles as WebKit reports them (Linux); also
            // routes the element picker's title sentinel to picker::on_picked.
            #[cfg(target_os = "linux")]
            linux_layout::connect_title(app.handle());

            // Exit fullscreen on Esc from the content webview (Linux).
            #[cfg(target_os = "linux")]
            linux_layout::connect_fullscreen_exit(app.handle());

            // Ad-blocking (Linux/WebKit): install EasyList content filters.
            #[cfg(target_os = "linux")]
            install_adblock(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
