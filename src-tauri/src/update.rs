//! Auto-update IPC wiring (tauri-plugin-updater). Bridges the renderer's `update.*`
//! channels to the plugin: check for updates, mirror state to the chrome via the
//! `update.state` event, and download+install+restart on request. The update feed
//! (endpoints + pubkey) is configured in tauri.conf.json.
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_updater::UpdaterExt;

/// Last-known update state, mirrored to the chrome via the `update.state` event.
/// Shape matches `UpdateState` in shared/types.ts.
pub struct UpdateState(pub Mutex<Value>);

impl Default for UpdateState {
    fn default() -> Self {
        UpdateState(Mutex::new(idle()))
    }
}

fn idle() -> Value {
    json!({ "status": "idle", "version": null, "percent": 0, "error": null })
}

fn set(app: &AppHandle, v: Value) {
    if let Some(s) = app.try_state::<UpdateState>() {
        *s.0.lock().unwrap() = v.clone();
    }
    let _ = crate::emit_event(app, "update.state", v);
}

/// Handle `update.*` channels. Returns `None` if `channel` is not an update channel.
pub fn dispatch(app: &AppHandle, channel: &str, _payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "update.getState" => {
            let v = app
                .try_state::<UpdateState>()
                .map(|s| s.0.lock().unwrap().clone())
                .unwrap_or_else(idle);
            Some(Ok(v))
        }
        "update.checkNow" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                set(&app, json!({ "status": "checking", "version": null, "percent": 0, "error": null }));
                let result = match app.updater() {
                    Ok(updater) => updater.check().await,
                    Err(e) => Err(e),
                };
                match result {
                    Ok(Some(update)) => set(&app, json!({
                        "status": "available", "version": update.version, "percent": 0, "error": null
                    })),
                    Ok(None) => set(&app, json!({
                        "status": "not-available", "version": null, "percent": 0, "error": null
                    })),
                    Err(e) => set(&app, json!({
                        "status": "error", "version": null, "percent": 0, "error": e.to_string()
                    })),
                }
            });
            Some(Ok(Value::Null))
        }
        "update.restartToInstall" => {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let Ok(updater) = app.updater() else { return };
                if let Ok(Some(update)) = updater.check().await {
                    set(&app, json!({ "status": "downloading", "version": update.version, "percent": 0, "error": null }));
                    let progress_app = app.clone();
                    let result = update
                        .download_and_install(
                            move |_chunk, _total| {
                                // Per-chunk progress; a richer percent could be emitted here.
                                let _ = &progress_app;
                            },
                            || {},
                        )
                        .await;
                    match result {
                        Ok(()) => app.restart(),
                        Err(e) => set(&app, json!({
                            "status": "error", "version": null, "percent": 0, "error": e.to_string()
                        })),
                    }
                }
            });
            Some(Ok(Value::Null))
        }
        _ => None,
    }
}
