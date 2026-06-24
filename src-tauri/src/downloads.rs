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

/// Returns `true` when a download should be written to the downloads store.
/// Private tabs skip the record so the download leaves no persistent trace —
/// but the file itself is always saved (the user explicitly asked for it),
/// matching Chrome/Firefox incognito behaviour.
pub fn should_record_download(is_private: bool) -> bool {
    !is_private
}

/// On DownloadEvent::Requested: pick the save path and (unless private) record a
/// progressing entry. Private tabs still save the file the user asked for but leave
/// no trace in the downloads store.
pub fn on_requested(app: &AppHandle, url: &str, destination: &mut PathBuf, private: bool) {
    let filename = url
        .rsplit('/')
        .next()
        .and_then(|s| s.split('?').next())
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    let save = dir(app).join(&filename);
    *destination = save.clone();

    if !should_record_download(private) {
        // The file is saved normally; we just skip writing a downloads.json row so the
        // download leaves no persistent trace.
        return;
    }

    let mut items = jsonstore::load_synced(app, "downloads");
    let id = jsonstore::next_id(&items);
    let mut item = json!({
        "id": id,
        "url": url,
        "filename": filename,
        "savePath": save.to_string_lossy(),
        "state": "progressing",
        "receivedBytes": 0,
        "totalBytes": 0,
        "startedAt": jsonstore::now_ms()
    });
    jsonstore::stamp_new(&mut item, app);
    items.push(item);
    let _ = jsonstore::save(app, "downloads", &items);
    crate::emit_event(app, "downloads.changed", Value::Null);
}

/// On DownloadEvent::Finished: mark the newest progressing entry completed/interrupted.
pub fn on_finished(app: &AppHandle, success: bool) {
    let mut items = jsonstore::load_synced(app, "downloads");
    for it in items.iter_mut().rev() {
        if !jsonstore::is_deleted(it)
            && it.get("state").and_then(Value::as_str) == Some("progressing")
        {
            if let Some(o) = it.as_object_mut() {
                o.insert(
                    "state".into(),
                    json!(if success { "completed" } else { "interrupted" }),
                );
            }
            jsonstore::touch(it, app);
            break;
        }
    }
    let _ = jsonstore::save(app, "downloads", &items);
    crate::emit_event(app, "downloads.changed", Value::Null);
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let id = || payload.get("id").and_then(Value::as_i64);
    match channel {
        "downloads.list" => Some(Ok(json!(jsonstore::live(jsonstore::load_synced(
            app,
            "downloads"
        ))))),

        "downloads.remove" | "downloads.cancel" => {
            let mut items = jsonstore::load_synced(app, "downloads");
            let want = id();
            jsonstore::tombstone(
                &mut items,
                |it| it.get("id").and_then(Value::as_i64) == want,
                app,
            );
            let _ = jsonstore::save(app, "downloads", &items);
            Some(Ok(json!(jsonstore::live(items))))
        }

        "downloads.clear" => {
            // Tombstone finished rows (completed/interrupted); keep in-progress live.
            let mut items = jsonstore::load_synced(app, "downloads");
            jsonstore::tombstone(
                &mut items,
                |it| {
                    !jsonstore::is_deleted(it)
                        && it.get("state").and_then(Value::as_str) != Some("progressing")
                },
                app,
            );
            let _ = jsonstore::save(app, "downloads", &items);
            Some(Ok(json!(jsonstore::live(items))))
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

#[cfg(test)]
mod tests {
    use super::should_record_download;
    #[test]
    fn private_downloads_are_not_recorded() {
        assert!(should_record_download(false)); // normal tab → record
        assert!(!should_record_download(true)); // private tab → no record (file still saved)
    }
}
