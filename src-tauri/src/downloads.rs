//! Downloads (downloads.* IPC). The content webview's on_download handler (nav.rs)
//! sets the save path and records an entry; on finish the entry's state is updated.
//! Backed by the JSON store. No live byte-progress (Tauri emits Requested/Finished
//! only) and no mid-flight cancel (no API) — cancel just drops the entry.
//!
//! ## Write batching
//! Like `history`, the live downloads list is an in-memory cache (`DownloadsStore`, managed
//! state). Download events (`on_requested`/`on_finished`) and `remove`/`clear` mutate the
//! cache and mark it dirty; a background flush (`start_flush`) coalesces those into one write
//! instead of a full read-modify-serialize-double-fsync of the whole file per event. Reads
//! (`list`, and the `openFile`/`showInFolder` path lookup) serve from the cache; user-initiated
//! `remove`/`clear` flush synchronously; `data.export` flushes first so a backup is never stale
//! and `data.import` invalidates so the next read reloads. Downloads is NOT synced, so the
//! cache is self-contained (unlike favorites/saved, which the sync engine reads from disk).
//! Crash within the flush window loses at most the last few seconds of download-state updates.
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

/// In-memory downloads cache (managed state) — the source of truth while the app runs.
#[derive(Default)]
pub struct DownloadsStore(Mutex<DlInner>);

#[derive(Default)]
struct DlInner {
    items: Vec<Value>,
    loaded: bool,
    dirty: bool,
}

/// Load the on-disk downloads (migrating to sync-record shape once) into the cache on first access.
fn ensure_loaded<R: Runtime>(app: &AppHandle<R>, inner: &mut DlInner) {
    if !inner.loaded {
        inner.items = jsonstore::load_synced(app, "downloads");
        inner.loaded = true;
        inner.dirty = false;
    }
}

/// A copy of the full downloads array (incl. tombstones — use `jsonstore::live` for UI reads).
/// Serves from the in-memory cache when managed; falls back to disk otherwise.
fn snapshot<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    if let Some(store) = app.try_state::<DownloadsStore>() {
        let mut inner = store.0.lock().unwrap();
        ensure_loaded(app, &mut inner);
        inner.items.clone()
    } else {
        jsonstore::load_synced(app, "downloads")
    }
}

/// Apply a mutation to the downloads items — through the cache when managed, else directly on
/// disk — persisting now iff `flush_now`. Returns whether the items changed.
fn mutate<R: Runtime>(
    app: &AppHandle<R>,
    flush_now: bool,
    f: impl FnOnce(&mut Vec<Value>) -> bool,
) -> bool {
    if let Some(store) = app.try_state::<DownloadsStore>() {
        let changed = {
            let mut inner = store.0.lock().unwrap();
            ensure_loaded(app, &mut inner);
            let changed = f(&mut inner.items);
            if changed {
                inner.dirty = true;
            }
            changed
        };
        if flush_now {
            flush(app);
        }
        changed
    } else {
        let mut items = jsonstore::load_synced(app, "downloads");
        let changed = f(&mut items);
        if changed {
            let _ = jsonstore::save(app, "downloads", &items);
        }
        changed
    }
}

/// Persist the cache to disk if dirty. Clones under the lock and writes OUTSIDE it so a slow
/// fsync never blocks a download event; re-marks dirty on write failure so the next flush
/// retries. No-op when the cache isn't managed or isn't dirty.
pub fn flush<R: Runtime>(app: &AppHandle<R>) {
    let Some(store) = app.try_state::<DownloadsStore>() else {
        return;
    };
    let pending = {
        let mut inner = store.0.lock().unwrap();
        if !inner.loaded || !inner.dirty {
            return;
        }
        inner.dirty = false;
        inner.items.clone()
    };
    if jsonstore::save(app, "downloads", &pending).is_err() {
        store.0.lock().unwrap().dirty = true;
    }
}

/// Drop the cache so the next read reloads from disk — used after `data.import` overwrites the
/// downloads file.
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(store) = app.try_state::<DownloadsStore>() {
        let mut inner = store.0.lock().unwrap();
        inner.items.clear();
        inner.loaded = false;
        inner.dirty = false;
    }
}

/// Background flush loop: every few seconds, persist the cache if dirty. Started once from
/// lib.rs setup (mirrors `history::start_flush`).
pub fn start_flush(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(3));
        flush(&app);
    });
}

/// Resolve the directory downloads are saved to.
fn dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
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
pub fn on_requested<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    destination: &mut PathBuf,
    private: bool,
) {
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

    let save_path = save.to_string_lossy().to_string();
    let url = url.to_string();
    let now = jsonstore::now_ms();
    let changed = mutate(app, false, |items| {
        let id = jsonstore::next_id(items);
        let mut item = json!({
            "id": id,
            "url": url,
            "filename": filename,
            "savePath": save_path,
            "state": "progressing",
            "receivedBytes": 0,
            "totalBytes": 0,
            "startedAt": now
        });
        jsonstore::stamp_new(&mut item, app);
        items.push(item);
        true
    });
    if changed {
        crate::emit_event(app, "downloads.changed", Value::Null);
    }
}

/// On DownloadEvent::Finished: mark the newest progressing entry completed/interrupted.
pub fn on_finished<R: Runtime>(app: &AppHandle<R>, success: bool) {
    let changed = mutate(app, false, |items| {
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
                return true;
            }
        }
        false
    });
    if changed {
        crate::emit_event(app, "downloads.changed", Value::Null);
    }
}

pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let id = || payload.get("id").and_then(Value::as_i64);
    match channel {
        "downloads.list" => Some(Ok(json!(jsonstore::live(snapshot(app))))),

        "downloads.remove" | "downloads.cancel" => {
            let want = id();
            // User-initiated → flush now so the removal hits disk immediately.
            mutate(app, true, |items| {
                jsonstore::tombstone(
                    items,
                    |it| it.get("id").and_then(Value::as_i64) == want,
                    app,
                )
            });
            Some(Ok(json!(jsonstore::live(snapshot(app)))))
        }

        "downloads.clear" => {
            // Tombstone finished rows (completed/interrupted); keep in-progress live.
            mutate(app, true, |items| {
                jsonstore::tombstone(
                    items,
                    |it| {
                        !jsonstore::is_deleted(it)
                            && it.get("state").and_then(Value::as_str) != Some("progressing")
                    },
                    app,
                )
            });
            Some(Ok(json!(jsonstore::live(snapshot(app)))))
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

fn path_of<R: Runtime>(app: &AppHandle<R>, id: Option<i64>) -> Option<String> {
    snapshot(app)
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
    use super::*;
    use crate::test_support::with_tmp_app;

    /// Live rows from the cache (the source of truth) — NOT a fresh disk read, since writes
    /// now batch in memory and only flush periodically.
    fn live_rows(app: &tauri::AppHandle<tauri::test::MockRuntime>) -> Vec<Value> {
        jsonstore::live(snapshot(app))
    }

    #[test]
    fn private_downloads_are_not_recorded() {
        assert!(should_record_download(false)); // normal tab → record
        assert!(!should_record_download(true)); // private tab → no record (file still saved)
    }

    #[test]
    fn on_requested_derives_filename_and_records_progressing() {
        with_tmp_app(|app| {
            let mut dest = PathBuf::new();
            on_requested(
                app,
                "https://files.test/path/report.pdf?token=abc",
                &mut dest,
                false,
            );
            assert_eq!(dest.file_name().unwrap().to_string_lossy(), "report.pdf");
            let rows = live_rows(app);
            assert_eq!(rows.len(), 1);
            assert_eq!(
                rows[0].get("filename").and_then(Value::as_str),
                Some("report.pdf")
            );
            assert_eq!(
                rows[0].get("state").and_then(Value::as_str),
                Some("progressing")
            );
        });
    }

    #[test]
    fn on_requested_batches_in_memory_and_flush_persists() {
        with_tmp_app(|app| {
            let mut dest = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut dest, false);
            // Batched: nothing written to disk yet (the win — no per-event fsync)…
            assert!(
                jsonstore::live(jsonstore::load_synced(app, "downloads")).is_empty(),
                "on_requested must batch in memory, not write to disk per event"
            );
            // …but it IS visible to reads (served from the cache).
            assert_eq!(live_rows(app).len(), 1);
            // An explicit flush persists it.
            flush(app);
            assert_eq!(
                jsonstore::live(jsonstore::load_synced(app, "downloads")).len(),
                1
            );
        });
    }

    #[test]
    fn on_finished_marks_newest_progressing_completed() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d, false);
            on_finished(app, true);
            let rows = live_rows(app);
            assert_eq!(
                rows[0].get("state").and_then(Value::as_str),
                Some("completed")
            );
        });
    }

    #[test]
    fn on_finished_false_marks_interrupted() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d, false);
            on_finished(app, false);
            assert_eq!(
                live_rows(app)[0].get("state").and_then(Value::as_str),
                Some("interrupted")
            );
        });
    }

    #[test]
    fn remove_tombstones_one_row() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/a.bin", &mut d, false);
            on_finished(app, true);
            let id = live_rows(app)[0].get("id").and_then(Value::as_i64).unwrap();
            let after = dispatch(app, "downloads.remove", &json!({ "id": id }))
                .unwrap()
                .unwrap();
            assert!(after.as_array().unwrap().is_empty());
            // remove flushes synchronously → the tombstone is on disk immediately.
            assert!(jsonstore::live(jsonstore::load_synced(app, "downloads")).is_empty());
        });
    }

    #[test]
    fn clear_keeps_progressing_and_tombstones_finished() {
        with_tmp_app(|app| {
            // one finished, one still progressing.
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/done.bin", &mut d, false);
            on_finished(app, true);
            let mut d2 = PathBuf::new();
            on_requested(app, "https://files.test/inflight.bin", &mut d2, false);
            let after = dispatch(app, "downloads.clear", &json!({}))
                .unwrap()
                .unwrap();
            let rows = after.as_array().unwrap();
            assert_eq!(rows.len(), 1, "only the progressing row survives clear");
            assert_eq!(
                rows[0].get("state").and_then(Value::as_str),
                Some("progressing")
            );
        });
    }
}
