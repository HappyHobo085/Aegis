mod adblock;
// The bundled filter lists (EasyList + EasyPrivacy + Peter Lowe's), single-sourced so
// every ad-block tier blocks from the identical set across all platforms.
mod adblock_lists;
mod adblock_convert;
// Chromium-side network ad-blocking engine (`should_block`). Used by Android (JNI
// export) and Windows (WebView2 interception, adblock_win) for full request blocking,
// and by ALL desktop platforms to drop ad/tracker pop-unders in nav::on_new_window.
#[cfg(any(desktop, target_os = "android", test))]
mod adblock_engine;
// Windows full network ad-block: our own WebView2 WebResourceRequested interceptor.
#[cfg(target_os = "windows")]
mod adblock_win;
// Address-bar URL tracking for same-document (History-API/hash) navigations — the
// per-platform analog of Linux's WebKitGTK notify::uri (linux_layout::connect_url_tracker):
// WebView2 SourceChanged on Windows, WKWebView `URL` KVO on macOS.
#[cfg(target_os = "windows")]
mod nav_url_win;
#[cfg(target_os = "macos")]
mod nav_url_mac;
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
mod tabs;
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
        // Convert EVERY bundled list (ads + trackers + Peter Lowe's), not just EasyList,
        // so the WebKit content filters match the same set as the engine/inject tiers.
        let bundled = adblock_lists::ALL;
        // Cache key = source hash (all bundled lists + custom rules + enabled subscriptions).
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        for list in bundled {
            list.hash(&mut hasher);
        }
        custom.hash(&mut hasher);
        subs_text.hash(&mut hasher);
        let marker = store_dir.join(format!("v{:x}.ready", hasher.finish()));
        let cached = marker.exists();
        let sources: Vec<&str> = bundled.iter().copied().chain([custom.as_str(), subs_text.as_str()]).collect();
        match adblock_convert::to_content_blocker_chunks(&sources, 25_000) {
            Ok(chunks) => {
                eprintln!("[aegis-cf] filter lists -> {} chunks (cached={cached})", chunks.len());
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
        MenuItemBuilder::with_id(id, label).accelerator(accel).build(app)
    };
    let tabs_menu = SubmenuBuilder::new(app, "Tabs")
        .item(&item("tab_new", "New Tab", "CmdOrCtrl+T")?)
        .item(&item("tab_close", "Close Tab", "CmdOrCtrl+W")?)
        .item(&item("tab_reopen", "Reopen Closed Tab", "CmdOrCtrl+Shift+T")?)
        .item(&item("tab_next", "Next Tab", "Ctrl+Tab")?)
        .item(&item("tab_prev", "Previous Tab", "Ctrl+Shift+Tab")?)
        .build()?;
    let menu = MenuBuilder::new(app).item(&tabs_menu).build()?;
    app.set_menu(menu)?;
    Ok(())
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
        // plugins — `appsink` (how WebKit pulls decoded frames) plus the actual codecs —
        // from GST_PLUGIN_SYSTEM_PATH_1_0. In the AppImage, AppRun points that variable at
        // the *bundled* plugin dir, but linuxdeploy bundles libgstreamer (a linked dep)
        // WITHOUT the dlopened plugin modules, so the dir is empty: media dies with
        // "GStreamer element appsink not found" — a permanent spinner, no playback (the
        // streamex.sh symptom). The bundled libgstreamer is copied from this host and
        // version-matches its plugins, so appending the host's plugin dir(s) lets them
        // load. Harmless outside the AppImage (the .deb / `tauri dev` already use these
        // dirs); we only append dirs that exist and aren't already on the path.
        {
            let mut dirs: Vec<&str> = vec![
                "/usr/lib64/gstreamer-1.0",                // Fedora/RHEL/SUSE x86_64
                "/usr/lib/x86_64-linux-gnu/gstreamer-1.0", // Debian/Ubuntu x86_64
            ];
            // `/usr/lib/gstreamer-1.0` is the generic (Arch) location, but on Fedora
            // multilib it's the *i686* dir — only fall back to it when no arch-specific
            // dir exists, so we never scan wrong-arch plugins into this x86_64 process.
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
            // The AppImage may point GST_PLUGIN_SCANNER at a bundled helper that wasn't
            // packaged; fall back to the host's so plugin scanning isn't done noisily
            // in-process. Only override when the current value is missing/nonexistent.
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
        .manage(safety::SafetyState::default());

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
        let _ = crate::emit_event(app, "tabs.shortcut", s);
    });

    builder
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            // Initialize the tab registry: restore from tabs.json if it exists,
            // otherwise start fresh with the configured home page.  Only the active
            // tab gets an eager webview; the rest lazy-spawn on activation.
            let home = crate::settings::home_url(app.handle()).to_string();
            let reg = match tabs::load_session(app.handle()) {
                Some(session) => crate::tab_registry::Registry::restore(session, home.clone()),
                None => crate::tab_registry::Registry::new(home.clone()),
            };
            app.manage(tabs::Tabs::from_registry(reg));
            let active = app.state::<tabs::Tabs>().reg.lock().unwrap().active_id();
            let active_url = app.state::<tabs::Tabs>().reg.lock().unwrap().url_of(active).map(str::to_string);
            if let Some(url) = active_url {
                if let Ok(u) = tauri::Url::parse(&url) {
                    nav::spawn_tab(app.handle(), active, u)?;
                }
            }
            tabs::start_idle_sweep(app.handle());

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

            // Emit the restored tabs state so the chrome renders all tabs immediately
            // (belt-and-suspenders: the chrome also calls tabs.list on mount).
            let _ = crate::emit_event(app.handle(), "tabs.state", {
                let s = app.state::<tabs::Tabs>().reg.lock().unwrap().tabs_state();
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

            // The per-tab WebKit signal hooks (permission handler, title→history +
            // picker sentinel, Esc-exits-fullscreen) are installed at spawn time in
            // nav::spawn_tab — including for the first tab spawned above — so they're
            // no longer wired here.

            // Ad-blocking (Linux/WebKit): install EasyList content filters.
            #[cfg(target_os = "linux")]
            install_adblock(app.handle().clone());
            // Warm the pop-under matching engine off-thread so the first window.open
            // check (nav::on_new_window) doesn't pay the EasyList parse on the UI thread.
            // (Android already warms it on the first intercepted request.)
            #[cfg(desktop)]
            std::thread::spawn(|| {
                let _ = adblock_engine::should_block(
                    "https://aegis.invalid/",
                    "https://aegis.invalid/",
                    "document",
                );
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
