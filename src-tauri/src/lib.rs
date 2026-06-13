mod adblock_convert;
#[cfg(target_os = "linux")]
mod adblock_webkit;
#[cfg(target_os = "linux")]
mod linux_layout;
mod nav;
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

    let v = match channel.as_str() {
        // Collection reads + mutations that echo the (empty) collection.
        "favorites.list" | "favorites.add" | "favorites.update" | "favorites.remove"
        | "favorites.reorder" | "history.list" | "history.search" | "saved.list"
        | "saved.add" | "saved.remove" | "saved.update" | "saved.renameTag"
        | "saved.deleteTag" | "saved.tagUnion" | "subs.list" | "subs.setEnabled"
        | "subs.add" | "subs.remove" | "downloads.list" | "downloads.remove"
        | "downloads.clear" | "downloads.cancel" | "permissions.list"
        | "permissions.remove" | "permissions.clear" | "safety.listExceptions" => json!([]),

        "saved.has" => json!(false),

        "settings.get" | "settings.set" => json!({
            "siteName": "Aegis",
            "homeUrl": "about:blank",
            "primaryColor": "#3b82f6",
            "defaultSearchTemplate": "https://duckduckgo.com/?q=%s",
            "searchEngines": [],
            "hideChromeByDefault": false,
            "downloadDir": "",
            "httpsOnly": true
        }),

        "adblock.getState" | "adblock.setEnabled" | "adblock.toggleAllowlist"
        | "adblock.removeAllowlist" | "adblock.clearAllowlist" => json!({
            "enabled": true, "allowlistedHosts": [], "sessionBlocked": 0
        }),

        "customFilters.get" | "customFilters.set" => json!(""),
        "lists.updateNow" => json!({ "perSource": [], "lastUpdated": 0 }),
        "update.getState" => json!({
            "status": "idle", "version": null, "percent": 0, "error": null
        }),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(view::ContentInset::default())
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
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
