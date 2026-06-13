mod adblock;
mod adblock_convert;
#[cfg(target_os = "linux")]
mod adblock_webkit;
#[cfg(target_os = "linux")]
mod linux_layout;
mod jsonstore;
mod nav;
mod places;
mod settings;
mod update;
mod view;

use serde_json::{json, Value};
use tauri::Manager;

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

    let v = match channel.as_str() {
        // Still-stubbed collections (history/subs/downloads/permissions land next).
        "history.list" | "history.search" | "subs.list" | "subs.setEnabled"
        | "subs.add" | "subs.remove" | "downloads.list" | "downloads.remove"
        | "downloads.clear" | "downloads.cancel" | "permissions.list"
        | "permissions.remove" | "permissions.clear" | "safety.listExceptions" => json!([]),

        "customFilters.get" | "customFilters.set" => json!(""),
        "lists.updateNow" => json!({ "perSource": [], "lastUpdated": 0 }),
        "safety.getState" => Value::Null,
        "data.export" => json!({ "ok": false }),
        "data.import" => json!({ "ok": false }),
        "picker.start" => json!({ "ok": false }),

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
    std::thread::spawn(move || {
        use std::hash::{Hash, Hasher};
        const EASYLIST: &str = include_str!("../resources/easylist.txt");
        // Cache key = source hash, so list updates invalidate the cache.
        let mut hasher = std::collections::hash_map::DefaultHasher::new();
        EASYLIST.hash(&mut hasher);
        let marker = store_dir.join(format!("v{:x}.ready", hasher.finish()));
        let cached = marker.exists();
        match adblock_convert::to_content_blocker_chunks(&[EASYLIST], 25_000) {
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
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(view::ContentInset::default())
        .manage(update::UpdateState::default())
        .manage(adblock::AdblockState::default())
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

            // Ad-blocking (Linux/WebKit): install EasyList content filters.
            #[cfg(target_os = "linux")]
            install_adblock(app.handle().clone());
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
