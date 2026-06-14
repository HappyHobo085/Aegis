//! Downloads (downloads.* IPC). The content webview's on_download handler (nav.rs)
//! sets the save path and records an entry; on finish the entry's state is updated.
//! Backed by the JSON store. No live byte-progress (Tauri emits Requested/Finished
//! only) and no mid-flight cancel (no API) — cancel just drops the entry.
use std::path::{Path, PathBuf};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::jsonstore;

/// Resolve the directory downloads are saved to.
fn dir(app: &AppHandle) -> PathBuf {
    let configured = crate::settings::download_dir(app);
    if !configured.is_empty() {
        let p = PathBuf::from(&configured);
        if p.is_dir() {
            return p;
        }
    }
    app.path()
        .download_dir()
        .unwrap_or_else(|_| PathBuf::from("/tmp"))
}

/// On DownloadEvent::Requested: pick the save path and record a progressing entry.
pub fn on_requested(app: &AppHandle, url: &str, destination: &mut PathBuf) {
    let filename = url
        .rsplit('/')
        .next()
        .and_then(|s| s.split('?').next())
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let save = dir(app).join(&filename);
    *destination = save.clone();

    let mut items = jsonstore::load(app, "downloads");
    let id = jsonstore::next_id(&items);
    items.push(json!({
        "id": id,
        "url": url,
        "filename": filename,
        "savePath": save.to_string_lossy(),
        "state": "progressing",
        "receivedBytes": 0,
        "totalBytes": 0,
        "startedAt": jsonstore::now_ms()
    }));
    let _ = jsonstore::save(app, "downloads", &items);
    let _ = crate::emit_event(app, "downloads.changed", Value::Null);
}

/// On DownloadEvent::Finished: mark the newest progressing entry completed/interrupted.
pub fn on_finished(app: &AppHandle, success: bool) {
    let mut items = jsonstore::load(app, "downloads");
    for it in items.iter_mut().rev() {
        if it.get("state").and_then(Value::as_str) == Some("progressing") {
            if let Some(o) = it.as_object_mut() {
                o.insert(
                    "state".into(),
                    json!(if success { "completed" } else { "interrupted" }),
                );
            }
            break;
        }
    }
    let _ = jsonstore::save(app, "downloads", &items);
    let _ = crate::emit_event(app, "downloads.changed", Value::Null);
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let id = || payload.get("id").and_then(Value::as_i64);
    match channel {
        "downloads.list" => Some(Ok(json!(jsonstore::load(app, "downloads")))),

        "downloads.remove" | "downloads.cancel" => {
            let mut items = jsonstore::load(app, "downloads");
            let want = id();
            items.retain(|it| it.get("id").and_then(Value::as_i64) != want);
            let _ = jsonstore::save(app, "downloads", &items);
            Some(Ok(json!(items)))
        }

        "downloads.clear" => {
            // keep in-progress, clear finished
            let kept: Vec<Value> = jsonstore::load(app, "downloads")
                .into_iter()
                .filter(|it| it.get("state").and_then(Value::as_str) == Some("progressing"))
                .collect();
            let _ = jsonstore::save(app, "downloads", &kept);
            Some(Ok(json!(kept)))
        }

        "downloads.openFile" => {
            if let Some(p) = path_of(app, id()) {
                open(&p);
            }
            Some(Ok(Value::Null))
        }

        "downloads.showInFolder" => {
            if let Some(p) = path_of(app, id()) {
                if let Some(parent) = Path::new(&p).parent() {
                    open(&parent.to_string_lossy());
                }
            }
            Some(Ok(Value::Null))
        }

        _ => None,
    }
}

fn path_of(app: &AppHandle, id: Option<i64>) -> Option<String> {
    jsonstore::load(app, "downloads")
        .iter()
        .find(|it| it.get("id").and_then(Value::as_i64) == id)
        .and_then(|it| it.get("savePath").and_then(Value::as_str))
        .map(String::from)
}

/// Open a file or folder with the OS default handler (desktop only — mobile has
/// no shell command to spawn; a platform-appropriate opener is a later follow-up).
fn open(target: &str) {
    #[cfg(desktop)]
    {
        #[cfg(target_os = "linux")]
        let cmd = "xdg-open";
        #[cfg(target_os = "macos")]
        let cmd = "open";
        #[cfg(target_os = "windows")]
        let cmd = "explorer";
        let _ = std::process::Command::new(cmd).arg(target).spawn();
    }
    #[cfg(not(desktop))]
    let _ = target;
}
