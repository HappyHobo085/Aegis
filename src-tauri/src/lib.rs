use serde_json::{json, Value};

/// Phase-0 IPC dispatcher. The renderer reaches the backend through a single
/// `ipc` command carrying a channel name (the strings in shared/types.ts `IPC`)
/// plus a payload. Phase 0 returns safe defaults for reads and null/Ok for
/// actions so the reused React UI renders without errors; real per-namespace
/// backends (SQLite, adblock, safety, …) replace these arms in Phases 2–3.
#[tauri::command]
fn ipc(channel: String, _payload: Value) -> Result<Value, String> {
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
        "nav.getState" => json!({
            "viewId": 1, "url": "about:blank", "title": "", "canGoBack": false,
            "canGoForward": false, "isLoading": false, "crashed": false
        }),

        // Fire-and-forget actions (nav.*, view.*, history.remove/clear,
        // downloads.openFile/showInFolder, permissions.resolve, update.*,
        // safety.proceed/removeException, …) resolve to null (Promise<void>).
        _ => Value::Null,
    };
    Ok(v)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![ipc])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
