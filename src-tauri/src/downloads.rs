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
//! and `data.import` invalidates both BEFORE writing the file and again after, so the next read
//! reloads the imported rows and a background flush can never write the pre-import rows back
//! over them (see `data.rs`'s import arm). Downloads is NOT synced, so the
//! cache is self-contained (unlike favorites/saved, which the sync engine reads from disk).
//! Crash within the flush window loses at most the last few seconds of download-state updates.
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

use crate::jsonstore;

#[cfg_attr(target_os = "android", allow(dead_code))]
const MAX_DOWNLOAD_ENTRIES: usize = 1000;

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
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
            let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
        if !inner.loaded || !inner.dirty {
            return;
        }
        inner.dirty = false;
        inner.items.clone()
    };
    if jsonstore::save(app, "downloads", &pending).is_err() {
        store.0.lock().unwrap_or_else(|e| e.into_inner()).dirty = true;
    }
}

/// Drop the cache so the next read reloads from disk — used by `data.import` both before it
/// writes the downloads file (so a background flush cannot write the pre-import rows back over
/// it) and after.
pub fn invalidate<R: Runtime>(app: &AppHandle<R>) {
    if let Some(store) = app.try_state::<DownloadsStore>() {
        let mut inner = store.0.lock().unwrap_or_else(|e| e.into_inner());
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
#[cfg_attr(target_os = "android", allow(dead_code))]
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

    if push_row(app, url, &filename, &save.to_string_lossy(), private) {
        crate::emit_event(app, "downloads.changed", Value::Null);
    }
}

/// Push a `progressing` downloads row. Shared by the desktop `on_requested` and by
/// Android's `record_download_start`, which is why the two entry points cannot
/// drift: same id scheme, same `MAX_DOWNLOAD_ENTRIES` drain, same `stamp_new`.
/// Returns whether the store changed; the CALLER emits `downloads.changed`, so one
/// row never produces two events.
fn push_row<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    filename: &str,
    save_path: &str,
    private: bool,
) -> bool {
    if !should_record_download(private) {
        // The file is saved normally; we just skip writing a downloads.json row so the
        // download leaves no persistent trace.
        return false;
    }

    let url = url.to_string();
    let filename = filename.to_string();
    let save_path = save_path.to_string();
    // The directory this file was ACTUALLY written to, recorded per row. See
    // `trusted_download_path` for why a row cannot be validated against the current
    // `downloadDir` setting alone. Derived from the caller's own path rather than
    // passed in, so the two entry points (`on_requested` picks `dir(app).join(name)`,
    // Android's `record_download_start` takes Kotlin's `getExternalFilesDir` path
    // verbatim) cannot disagree about where the file went.
    let save_dir = Path::new(&save_path)
        .parent()
        .map(|d| d.to_string_lossy().to_string());
    let now = jsonstore::now_ms();
    mutate(app, false, |items| {
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
        // Only written when there IS a parent, so a bare filename leaves the field
        // absent rather than writing an empty string that would fail canonicalisation
        // for a different reason.
        if let Some(d) = &save_dir {
            item["saveDir"] = json!(d);
        }
        jsonstore::stamp_new(&mut item, app);
        items.push(item);

        // Enforce maximum number of entries
        if items.len() > MAX_DOWNLOAD_ENTRIES {
            // Remove the oldest entries (from the beginning)
            let excess = items.len() - MAX_DOWNLOAD_ENTRIES;
            items.drain(0..excess);
        }

        true
    })
}

/// Android's half of a download start. Kotlin's `DownloadListener.onDownloadStart`
/// receives a URL and NOTHING about a destination — the app picks the path and hands
/// it to `DownloadManager` — so this takes the caller's path verbatim instead of
/// deriving one. That is what makes the row's `savePath` the same real filesystem
/// path `openFile`/`showInFolder` later check: a `content://` URI would not be one,
/// and those two channels are why it has to be a path.
///
/// `private` is the CALLER's claim, not this function's — it comes from the tab the
/// download started in, and a caller-supplied flag is the only way this can be
/// wrong, so the Kotlin side is documented to pass the real per-tab value.
#[cfg_attr(not(target_os = "android"), allow(dead_code))]
pub fn record_download_start<R: Runtime>(
    app: &AppHandle<R>,
    url: &str,
    destination: &str,
    private: bool,
) {
    let filename = destination
        .rsplit('/')
        .next()
        .filter(|s| !s.is_empty())
        .unwrap_or("download")
        .to_string();
    if push_row(app, url, &filename, destination, private) {
        crate::emit_event(app, "downloads.changed", Value::Null);
    }
}

/// On DownloadEvent::Finished: mark the download that just finished.
///
/// `url` is the URL the event carried. It MUST be matched on, not "whichever row is newest and
/// still progressing": with two concurrent downloads, finishing the first would mark the SECOND
/// complete while the first stayed `progressing` forever — and since `openFile`/`showInFolder`/
/// `remove` are all keyed on the row's id, the wrong file gets opened. The event always supplies
/// the url, so pass it; `None` is the last-resort fallback to the old newest-progressing scan.
/// Live on Android too, via `recordDownloadFinish`.
pub fn on_finished<R: Runtime>(app: &AppHandle<R>, success: bool, url: Option<&str>) {
    let url = url.filter(|u| !u.is_empty());
    let changed = mutate(app, false, |items| {
        // Prefer an exact url match, and among those the newest, so a restarted transfer of the
        // same url still settles on the right row.
        if let Some(target) = url {
            if let Some(it) = items.iter_mut().rev().find(|it| {
                !jsonstore::is_deleted(it) && it.get("url").and_then(Value::as_str) == Some(target)
            }) {
                finish_row(it, success, app);
                return true;
            }
        }
        for it in items.iter_mut().rev() {
            if !jsonstore::is_deleted(it)
                && it.get("state").and_then(Value::as_str) == Some("progressing")
            {
                finish_row(it, success, app);
                return true;
            }
        }
        false
    });
    if changed {
        crate::emit_event(app, "downloads.changed", Value::Null);
    }
}

fn finish_row<R: Runtime>(it: &mut Value, success: bool, app: &AppHandle<R>) {
    if let Some(o) = it.as_object_mut() {
        o.insert(
            "state".into(),
            json!(if success { "completed" } else { "interrupted" }),
        );
    }
    jsonstore::touch(it, app);
}

/// JNI bridge for Android's `NativeDownloads.recordStart`, called from each content
/// WebView's `DownloadListener`. Same pattern (and same `ffi_guard` obligation) as
/// `history.rs`'s `recordVisit`; lives in libapp_lib.so.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
// `#[no_mangle]` is itself linted as `unsafe_code`: overriding the linker's symbol
// name means two libraries could export the same symbol, which the linker leaves
// undefined. That is inherent to every JNI entry point (Kotlin resolves the symbol
// by name), so it is allowed here explicitly rather than by the module scope —
// `deny(unsafe_code)` in lib.rs would otherwise break every Android build.
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeDownloads_recordStart(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    destination: jni::objects::JString,
    is_private: jni::sys::jboolean,
) {
    // Read the JNI args into owned Strings FIRST: `JNIEnv` is `!UnwindSafe`, so it
    // must stay outside the `ffi_guard` closure (see lib.rs::ffi_guard).
    let url: String = env.get_string(&url).map(|s| s.into()).unwrap_or_default();
    let destination: String = env
        .get_string(&destination)
        .map(|s| s.into())
        .unwrap_or_default();
    // An empty url or destination is malformed. The row's whole purpose is to name the
    // real path `openFile`/`showInFolder` will be handed, so there is nothing to record.
    if url.is_empty() || destination.is_empty() {
        return;
    }
    let Some(app) = crate::android_app() else {
        return;
    };
    if crate::ffi_guard(|| record_download_start(app, &url, &destination, is_private != 0))
        .is_none()
    {
        eprintln!("[aegis-downloads] recordStart panicked for {url}; download not recorded");
    }
}

/// JNI bridge for Android's `NativeDownloads.recordFinish`, called from the
/// `ACTION_DOWNLOAD_COMPLETE` receiver. Settles the row by URL, exactly like the
/// desktop `on_download` event path — see `on_finished` for why matching on the URL
/// rather than "whichever row is newest" is load-bearing when two transfers overlap.
#[cfg(target_os = "android")]
#[allow(unsafe_code)]
#[no_mangle]
pub extern "system" fn Java_com_aegis_browser_NativeDownloads_recordFinish(
    mut env: jni::JNIEnv,
    _this: jni::objects::JObject,
    url: jni::objects::JString,
    success: jni::sys::jboolean,
) {
    let url: String = env.get_string(&url).map(|s| s.into()).unwrap_or_default();
    if url.is_empty() {
        return;
    }
    let Some(app) = crate::android_app() else {
        return;
    };
    if crate::ffi_guard(|| on_finished(app, success != 0, Some(&url))).is_none() {
        eprintln!("[aegis-downloads] recordFinish panicked for {url}; row left progressing");
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
            let Some(p) = path_of(app, id()) else {
                return Some(Err(
                    "Downloaded file is missing or outside the downloads folder.".into(),
                ));
            };
            // `?` cannot be used here: `dispatch` returns `Option<Result<…>>`, so it
            // would bind to the Option and turn a failed open into "channel unhandled".
            // Map the open's error into the arm's answer explicitly.
            if let Err(e) = open(&p) {
                return Some(Err(e));
            }
            Some(Ok(Value::Null))
        }

        "downloads.showInFolder" => {
            let Some(p) = path_of(app, id()) else {
                return Some(Err(
                    "Downloaded file is missing or outside the downloads folder.".into(),
                ));
            };
            let Some(parent) = Path::new(&p).parent() else {
                return Some(Err(
                    "Downloaded file is missing or outside the downloads folder.".into(),
                ));
            };
            if let Err(e) = open(&parent.to_string_lossy()) {
                return Some(Err(e));
            }
            Some(Ok(Value::Null))
        }

        _ => None,
    }
}

fn path_of<R: Runtime>(app: &AppHandle<R>, id: Option<i64>) -> Option<String> {
    let rows = snapshot(app);
    let row = rows
        .iter()
        .find(|it| it.get("id").and_then(Value::as_i64) == id)?;
    let p = row.get("savePath").and_then(Value::as_str)?;
    let base = row.get("saveDir").and_then(Value::as_str);
    trusted_download_path(app, p, base).then(|| p.to_string())
}

/// True when `canon` is inside `base`, resolving symlinks on BOTH sides first.
///
/// Both sides must be canonicalized or the comparison is meaningless: a downloads
/// folder reached through a symlink (macOS `/tmp` -> `/private/tmp`, and any Linux
/// box with the home directory on another filesystem) never string-prefixes its own
/// children.
fn within(canon: &Path, base: Option<&Path>) -> bool {
    base.and_then(|b| b.canonicalize().ok())
        .is_some_and(|b| canon.starts_with(b))
}

/// Whether `openFile`/`showInFolder` may hand this path to the OS.
///
/// A downloads row is a HISTORICAL record, so validating it against the *current*
/// `downloadDir` setting was wrong in two ways a user actually hits:
///
/// 1. Change the download folder in Settings and every download taken before the
///    change stops opening -- the file is still on disk, still in a downloads folder,
///    just not the current one. It used to fail as a silent no-op.
/// 2. On Android it failed for EVERY row, always. `record_download_start` records
///    Kotlin's `getExternalFilesDir("downloads")` path
///    (`/storage/emulated/0/Android/data/<pkg>/files/downloads/...`) because that
///    needs no storage permission, while `dir(app)` resolves the `downloadDir`
///    setting or Tauri's `download_dir()` (`/storage/emulated/0/Download`). The two
///    never match.
///
/// So each row records the directory it was written to and that is accepted too.
///
/// **What this does and does not trust.** The recorded `saveDir` comes from the same
/// `downloads.json` a tamperer would control, so honouring it means a hand-crafted
/// store could name any base. That is why `data::import` STRIPS `saveDir` from
/// imported rows: a bundle is the one path where a stranger's bytes reach this
/// check, and an imported row falls back to the strict `dir(app)` test. The
/// `downloads` namespace is not in `sync_stores::SYNCABLE`, so there is no third
/// path. Locally-written rows are written by `push_row` from a path the core itself
/// chose, which is the same trust level as the file already being on disk there.
fn trusted_download_path<R: Runtime>(
    app: &AppHandle<R>,
    raw: &str,
    recorded_base: Option<&str>,
) -> bool {
    let p = Path::new(raw);
    if !p.is_absolute() || !p.is_file() {
        return false;
    }
    let Ok(canon) = p.canonicalize() else {
        return false;
    };
    within(&canon, recorded_base.map(Path::new)) || within(&canon, Some(&dir(app)))
}

/// The OS command that hands a path to the desktop's default handler, or `None` on a
/// tier that has no such command. `None` is the mobile answer: there is no shell
/// command to spawn, so "open this file" is not something the core can do at all.
#[cfg(target_os = "linux")]
const OPENER: Option<&str> = Some("xdg-open");
#[cfg(target_os = "macos")]
const OPENER: Option<&str> = Some("open");
#[cfg(target_os = "windows")]
const OPENER: Option<&str> = Some("explorer");
#[cfg(not(any(target_os = "linux", target_os = "macos", target_os = "windows")))]
const OPENER: Option<&str> = None;

/// An opener: given a path, either hand it to the OS or explain why not.
type Opener = std::sync::Arc<dyn Fn(&str) -> std::result::Result<(), String>>;

/// The real opener for one command. Split out from [`opener`] so a test can build an
/// opener for a command that does not exist — proving the OS-error text — without ever
/// going near the tier's real handler.
fn opener_for(cmd: &'static str) -> Opener {
    Arc::new(
        move |target| match std::process::Command::new(cmd).arg(target).spawn() {
            Ok(_) => Ok(()),
            Err(e) => {
                eprintln!("[aegis-downloads] {cmd} could not open {target}: {e}");
                Err(format!("Could not open {target}: {e}"))
            }
        },
    )
}

fn real_opener() -> Option<Opener> {
    OPENER.map(opener_for)
}

// A test-only override for the opener the dispatch arms use.
//
// Why this exists, in the order it was learned: `OPENER` is a `const` and every Linux
// box has `xdg-open`, so without an override the arms could only ever answer `Ok` here
// — a probe that made `dispatch` throw `open`'s error away produced NO red test at
// all, which is how the arms were found to be unverified rather than verified.
// Testing `open_with`'s arms directly did not close that gap, because the thing that
// must not lie is the ARM, not the helper it calls.
//
// Why it is a CLOSURE and not a command name: the first version took `Option<&str>`
// and the "control" assertion used the host's REAL opener, which meant every run of
// the suite spawned `xdg-open` on a path under `/tmp/aegis-test-*`. On a box with no
// file manager that answers with a GTK error dialog — the tests were popping error
// windows on the developer's desktop, on a file the test itself had already deleted.
// A test must not have that side effect, and the success path does not need a process
// to be proven reachable: the closure stands in for one.
//
// Thread-local rather than a `static` because the crate's tests run in parallel
// threads and one test's override must not be visible to another — and because
// `test_support::with_tmp_app` already holds `test_support::LOCK`, so a global lock
// here would deadlock rather than serialise. `None` inside the cell means "no
// override", which is why the override is itself an `Option`.
#[cfg(test)]
std::thread_local! {
    static TEST_OPENER: std::cell::RefCell<Option<Option<Opener>>> =
        const { std::cell::RefCell::new(None) };
}

/// The opener to use: the test override if one is installed, else the tier's real one.
#[cfg(not(test))]
fn opener() -> Option<Opener> {
    real_opener()
}

/// The opener to use: the test override if one is installed, else the tier's real one.
#[cfg(test)]
fn opener() -> Option<Opener> {
    if let Some(forced) = TEST_OPENER.with(|c| c.borrow().clone()) {
        return forced;
    }
    real_opener()
}

/// Run `f` with the opener forced to `forced` — `None` for the mobile tier, `Some`
/// closure to stand in for a working or a failing handler. The previous value is put
/// back afterwards; a panicking test aborts its thread, so a stale override cannot
/// leak into another test's thread.
#[cfg(test)]
fn with_test_opener<T>(forced: Option<Opener>, f: impl FnOnce() -> T) -> T {
    TEST_OPENER.with(|c| {
        let previous = c.replace(Some(forced));
        let out = f();
        *c.borrow_mut() = previous;
        out
    })
}

/// Open a file or folder with the OS default handler.
///
/// Returns `Err` wherever the open demonstrably did NOT happen, so the caller stops
/// answering `Some(Ok(Null))` for a no-op.
///
/// Two cases, and the old code got both wrong:
/// - **No opener on this tier** (mobile). The old body was `#[cfg(not(desktop))] let
///   target;` — a literal no-op that the dispatch arms still reported as
///   `Some(Ok(Null))`, so "Open" and "Show in folder" on a phone silently did nothing.
///   `data.import` does not filter the `downloads` namespace, so a desktop backup
///   restored on a phone produces exactly such rows: one import away from a lie. A
///   platform-appropriate opener is a real follow-up; until one exists the honest
///   answer is an error the UI can show.
/// - **The spawn fails** (no `xdg-open` in a minimal container, a full process table).
///   The old `let _ = …spawn()` swallowed that too, leaving no log line. Reported, not
///   fatal — the file is still on disk either way.
///
/// `Command::new(cmd).arg(target)` passes NO shell, so `target` can never be read as a
/// command line; this is a liveness/diagnostics fix, not an injection fix.
fn open(target: &str) -> std::result::Result<(), String> {
    let Some(try_open) = opener() else {
        return Err("Opening a downloaded file is not available on this device yet.".into());
    };
    try_open(target)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use std::sync::mpsc;
    use tauri::Listener;

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
            on_finished(app, true, Some("https://files.test/a.bin"));
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
            on_finished(app, false, Some("https://files.test/a.bin"));
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
            on_finished(app, true, Some("https://files.test/a.bin"));
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
            on_finished(app, true, Some("https://files.test/done.bin"));
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

    /// One COMPLETE, TRUSTED download row plus the file it points at, and returns
    /// `(id, path)`. The two open-arm tests need exactly that, and they need it to be
    /// genuinely openable — an unresolvable row would be refused by `path_of` before
    /// `open` was ever reached, so every failure assertion after it would be measuring
    /// the wrong branch.
    fn seed_one_download(
        app: &tauri::AppHandle<tauri::test::MockRuntime>,
    ) -> (i64, std::path::PathBuf) {
        let app_dir = app.path().app_data_dir().unwrap();
        let dl_dir = app_dir.join("downloads");
        std::fs::create_dir_all(&dl_dir).unwrap();
        crate::settings::write(app, &json!({ "downloadDir": dl_dir.to_string_lossy() }))
            .expect("settings fixture write");
        let inside = dl_dir.join("ok.bin");
        std::fs::write(&inside, b"ok").unwrap();
        let id = {
            on_requested(app, "https://files.test/ok.bin", &mut PathBuf::new(), false);
            flush(app);
            let rows = live_rows(app);
            assert_eq!(rows.len(), 1);
            rows[0].get("id").and_then(Value::as_i64).unwrap()
        };
        (id, inside)
    }

    /// The regression this pins: `trusted_download_path` used to validate a row
    /// against the CURRENT `downloadDir` setting, which is wrong for a record of
    /// where a file was written. Change the setting and every earlier download
    /// stopped opening; on Android it was worse, because Kotlin writes into its
    /// app-private `getExternalFilesDir("downloads")` and that never matches the
    /// setting's path, so NO row ever resolved.
    ///
    /// Both are the same defect, and the file is a real one on disk inside the
    /// directory the app itself chose.
    #[test]
    fn a_download_stays_openable_after_the_download_folder_setting_changes() {
        with_tmp_app(|app| {
            let (id, inside) = seed_one_download(app);
            // The control: the row opens while the setting still points at its folder.
            with_test_opener(Some(ok_opener()), || {
                assert_eq!(
                    dispatch(app, "downloads.openFile", &json!({ "id": id })),
                    Some(Ok(Value::Null)),
                    "a row whose file is under the current download folder must open"
                );
            });

            // Now point the setting somewhere else entirely, the way changing it in
            // Settings does. The file has not moved and is still a real download.
            let elsewhere = app.path().app_data_dir().unwrap().join("other-folder");
            std::fs::create_dir_all(&elsewhere).unwrap();
            crate::settings::write(app, &json!({ "downloadDir": elsewhere.to_string_lossy() }))
                .expect("settings fixture write");

            with_test_opener(Some(ok_opener()), || {
                assert_eq!(
                    dispatch(app, "downloads.openFile", &json!({ "id": id })),
                    Some(Ok(Value::Null)),
                    "changing the download folder must not make an existing download unopenable; \
                     the row records where the file actually went"
                );
            });
            assert!(
                inside.is_file(),
                "control: the file itself is untouched by the setting change"
            );
        });
    }

    /// The `saveDir` half of that fix is only safe because an IMPORTED row cannot
    /// choose its own trusted base: a bundle is the one path where a stranger's bytes
    /// reach the check, so `data::import` strips the field and the row falls back to
    /// the strict "is it under the current download folder" test.
    ///
    /// `record_download_start` (not `on_requested`) is what mints a row for this, so
    /// the row carries exactly the path the caller named — which is how Android's
    /// rows are produced, and what a hostile bundle would imitate.
    #[test]
    fn an_imported_row_cannot_name_its_own_trusted_download_folder() {
        with_tmp_app(|app| {
            let dl_dir = app.path().app_data_dir().unwrap().join("downloads");
            std::fs::create_dir_all(&dl_dir).unwrap();
            crate::settings::write(app, &json!({ "downloadDir": dl_dir.to_string_lossy() }))
                .expect("settings fixture write");
            // A real file, outside the configured download folder, in a directory only
            // the bundle names.
            let outside = app.path().app_data_dir().unwrap().join("elsewhere");
            std::fs::create_dir_all(&outside).unwrap();
            let smuggled = outside.join("payload.bin");
            std::fs::write(&smuggled, b"x").unwrap();

            let bundle = json!({
                "downloads": [{
                    "id": 1,
                    "url": "https://files.test/payload.bin",
                    "filename": "payload.bin",
                    "savePath": smuggled.to_string_lossy(),
                    "saveDir": outside.to_string_lossy(),
                    "state": "completed",
                }],
            });
            let r =
                crate::data::dispatch(app, "data.import", &json!({ "text": bundle.to_string() }))
                    .unwrap()
                    .unwrap();
            assert_eq!(
                r.get("ok").and_then(Value::as_bool),
                Some(true),
                "the import itself must still succeed; only the trusted base is refused"
            );
            flush(app);

            let rows = live_rows(app);
            assert_eq!(rows.len(), 1);
            assert!(
                rows[0].get("saveDir").is_none(),
                "an imported row must not carry a saveDir, or a bundle could hand the \
                 core an arbitrary trusted folder"
            );
            assert_eq!(
                dispatch(app, "downloads.openFile", &json!({ "id": 1 })),
                Some(Err(
                    "Downloaded file is missing or outside the downloads folder.".to_string()
                )),
                "with saveDir stripped, a bundle row outside the download folder is refused"
            );
        });
    }

    /// A stand-in for a working desktop handler. Returns `Ok` without touching a
    /// process, so no test that needs the success path has to spawn anything.
    fn ok_opener() -> Opener {
        Arc::new(|_| Ok(()))
    }

    /// A stand-in for a handler that fails the way a real spawn failure does, so the
    /// arms' error path is reachable on any host.
    fn failing_opener() -> Opener {
        Arc::new(|target| Err(format!("Could not open {target}: forced failure")))
    }

    /// The OS-error text, from a real spawn failure, without the tier's real handler.
    ///
    /// This is the one place a process is genuinely started, and it fails at `exec` on a
    /// command that does not exist, so nothing runs and nothing is displayed. The
    /// success path is NOT covered by spawning — see `ok_opener`.
    #[test]
    fn a_spawn_failure_names_the_command_and_the_path() {
        let err = opener_for("aegis-no-such-opener-binary")("/tmp/aegis-test-x/ok.bin")
            .expect_err("spawning a command that does not exist must fail");
        assert!(
            err.contains("Could not open /tmp/aegis-test-x/ok.bin"),
            "the message must name the path the user asked for, got {err:?}"
        );
    }

    /// `open` must never report success for a no-op, and — the part that actually
    /// shipped broken — neither may the DISPATCH ARM that calls it. Both failures
    /// `open` can produce are driven here, through `dispatch` rather than through
    /// `open_with`, because the arm is the thing that used to answer `Some(Ok(Null))`
    /// for a no-op:
    /// - `opener: None` is the MOBILE tier's real state. The old body was a literal
    ///   `let _ = target;` and the arms still reported success, so an "Open" click on a
    ///   phone did nothing and said it worked.
    /// - A command that does not exist is a real desktop spawn failure (a minimal
    ///   container with no `xdg-open`). The old `let _ = …spawn()` discarded it with no
    ///   log line at all.
    ///
    /// Going through `dispatch` needs `with_test_opener` (see `TEST_OPENER`). The seam is a
    /// CLOSURE precisely so this test does not spawn anything: an earlier version used this
    /// host's real `xdg-open` as the control, which popped a GTK error dialog on the
    /// developer's desktop for a `/tmp/aegis-test-*` path the test had already deleted.
    #[test]
    fn the_open_arms_report_a_failure_instead_of_a_success_they_cannot_honour() {
        with_tmp_app(|app| {
            let (id, inside) = seed_one_download(app);

            // The CONTROL: a trusted row plus a working opener is the success case, and
            // the arms must answer `Ok` for it. Without this, the two assertions below
            // would pass for the wrong reason — any `Err` at all, from any cause, would
            // satisfy them. The opener is a CLOSURE, not this host's real `xdg-open`:
            // spawning that from a test pops a GTK error dialog on the developer's
            // desktop, for a path under `/tmp/aegis-test-*` the test has already deleted.
            with_test_opener(Some(ok_opener()), || {
                assert!(
                    dispatch(app, "downloads.openFile", &json!({ "id": id }))
                        .unwrap_or_else(|| panic!("openFile is handled"))
                        .is_ok(),
                    "a trusted row plus a working opener is the success case and must answer Ok"
                );
            });

            for (channel, forced, expect) in [
                (
                    "downloads.openFile",
                    Some(failing_opener()),
                    "Could not open",
                ),
                // The mobile shape: no opener at all, which is what a phone has.
                (
                    "downloads.showInFolder",
                    None,
                    "not available on this device",
                ),
            ] {
                let err = with_test_opener(forced, || dispatch(app, channel, &json!({ "id": id })))
                    .unwrap_or_else(|| panic!("{channel} is handled"))
                    .expect_err(&format!(
                        "{channel} must not report a successful open when the open did not happen"
                    ));
                assert!(
                    err.contains(expect),
                    "{channel}: expected a message containing {expect:?}, got {err:?}"
                );
            }
            assert!(inside.is_file(), "the fixture file must still be there");
        });
    }

    /// A row whose file is gone or was never under the downloads dir cannot be opened
    /// at all, and that is a different failure from `open`'s: the refusal happens before
    /// any opener is consulted, so it is observable on every host and needs no override.
    ///
    /// `path_of` → `trusted_download_path` is what refuses, which is also why a desktop
    /// backup restored on a phone fails here honestly instead of reaching `open`.
    #[test]
    fn the_open_arms_refuse_a_row_they_cannot_resolve() {
        with_tmp_app(|app| {
            let (id, inside) = seed_one_download(app);
            // The file is there and trusted, so both arms get past the lookup and reach
            // `open`. Injected rather than the host's real handler, so a test run spawns
            // no process and pops up no window on the developer's desktop.
            with_test_opener(Some(ok_opener()), || {
                for channel in ["downloads.openFile", "downloads.showInFolder"] {
                    assert!(
                        dispatch(app, channel, &json!({ "id": id })).is_some(),
                        "{channel} is handled"
                    );
                }
            });

            // Now delete the file: neither row resolves, and both arms must say so
            // rather than claiming the open happened.
            std::fs::remove_file(&inside).unwrap();
            for channel in ["downloads.openFile", "downloads.showInFolder"] {
                let err = dispatch(app, channel, &json!({ "id": id }))
                    .unwrap_or_else(|| panic!("{channel} is handled"))
                    .expect_err(&format!("{channel} must not report a successful open"));
                assert!(
                    err.contains("missing") || err.contains("outside the downloads folder"),
                    "{channel}: unexpected message {err:?}"
                );
            }
        });
    }

    #[test]
    fn trusted_download_path_requires_existing_file_under_download_dir() {
        with_tmp_app(|app| {
            let app_dir = app.path().app_data_dir().unwrap();
            let dl_dir = app_dir.join("downloads");
            std::fs::create_dir_all(&dl_dir).unwrap();
            crate::settings::write(
                app,
                &json!({
                    "downloadDir": dl_dir.to_string_lossy(),
                }),
            )
            .expect("settings fixture write");
            let inside = dl_dir.join("ok.bin");
            std::fs::write(&inside, b"ok").unwrap();
            let outside = app_dir.join("outside.bin");
            std::fs::write(&outside, b"no").unwrap();

            assert!(trusted_download_path(app, &inside.to_string_lossy(), None));
            assert!(!trusted_download_path(
                app,
                &outside.to_string_lossy(),
                None
            ));
            assert!(!trusted_download_path(
                app,
                &dl_dir.join("missing.bin").to_string_lossy(),
                None
            ));
            assert!(!trusted_download_path(app, "relative.bin", None));
        });
    }

    /// The regression this guards: with two downloads in flight, `on_finished` used to mark
    /// "whichever row is newest and still progressing", so finishing the FIRST marked the SECOND
    /// complete and left the first `progressing` forever. `openFile`/`showInFolder`/`remove` are
    /// all keyed on the row id, so that also meant opening the wrong file.
    #[test]
    fn finishing_one_of_two_concurrent_downloads_marks_that_one() {
        with_tmp_app(|app| {
            let mut d1 = PathBuf::new();
            on_requested(app, "https://files.test/first.bin", &mut d1, false);
            let mut d2 = PathBuf::new();
            on_requested(app, "https://files.test/second.bin", &mut d2, false);
            assert_eq!(live_rows(app).len(), 2);

            // Finish ONLY the first one.
            on_finished(app, true, Some("https://files.test/first.bin"));

            let rows = live_rows(app);
            let state = |u: &str| {
                rows.iter()
                    .find(|r| r.get("url").and_then(Value::as_str) == Some(u))
                    .and_then(|r| r.get("state"))
                    .and_then(Value::as_str)
                    .unwrap_or("<missing>")
                    .to_string()
            };
            assert_eq!(state("https://files.test/first.bin"), "completed");
            // The second must still be in flight — this is the assertion the old code failed.
            assert_eq!(state("https://files.test/second.bin"), "progressing");
        });
    }

    /// The exact-url match must not resurrect a row the user already removed: a tombstoned
    /// download that finishes late must stay gone rather than being marked completed.
    #[test]
    fn finishing_a_removed_download_does_not_bring_it_back() {
        with_tmp_app(|app| {
            let mut d = PathBuf::new();
            on_requested(app, "https://files.test/gone.bin", &mut d, false);
            let id = live_rows(app)[0].get("id").and_then(Value::as_i64).unwrap();
            let _ = dispatch(app, "downloads.remove", &json!({ "id": id }));
            assert!(
                live_rows(app).is_empty(),
                "precondition: the row is tombstoned"
            );

            on_finished(app, true, Some("https://files.test/gone.bin"));
            assert!(
                live_rows(app).is_empty(),
                "a late finish event must not resurrect a removed download"
            );
        });
    }

    // ---- the Android bridge (record_download_start), the half no desktop path reaches ----

    /// The row's `savePath` is the CALLER's path, verbatim. Android's
    /// `DownloadListener.onDownloadStart` hands over a URL and nothing about a destination —
    /// the app picks the path and passes it to `DownloadManager` — so if this entry point
    /// derived one from the URL (which is what the desktop `on_requested` does) the row
    /// would name a file that is never written, and `openFile`/`showInFolder` would resolve
    /// a path that does not exist.
    #[test]
    fn a_android_download_records_the_path_the_caller_chose() {
        with_tmp_app(|app| {
            record_download_start(
                app,
                "https://files.test/dl/9f2c/report.pdf",
                "/storage/emulated/0/Android/data/com.aegis.browser/files/downloads/report.pdf",
                false,
            );
            let rows = live_rows(app);
            assert_eq!(rows.len(), 1, "one row per download start");
            assert_eq!(
                rows[0].get("savePath").and_then(Value::as_str),
                Some(
                    "/storage/emulated/0/Android/data/com.aegis.browser/files/downloads/report.pdf"
                ),
                "savePath must be the caller's real path, not one derived from the URL"
            );
            // The filename is the path's last segment, so the downloads list shows a name
            // rather than a full path.
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

    /// The same privacy rule the desktop path has always had, on the path that is actually
    /// used on Android: a download in a private tab saves the file (the user asked for it)
    /// but leaves no row. `should_record_download` was `#[cfg_attr(android,
    /// allow(dead_code))]`, i.e. claimed dead on Android; reaching it again is the point.
    #[test]
    fn a_download_started_in_a_private_tab_records_nothing() {
        with_tmp_app(|app| {
            record_download_start(
                app,
                "https://files.test/secret.pdf",
                "/tmp/secret.pdf",
                true,
            );
            assert!(
                live_rows(app).is_empty(),
                "a private download must leave no persistent trace in the store"
            );
        });
    }

    /// Two downloads in flight, then the first finishes. The settled row must be the one
    /// whose URL matches — the mobile Downloads list shows a per-row state, so marking the
    /// wrong one tells the user a file finished that has not (and vice versa). This is the
    /// same property `on_finished`'s doc calls load-bearing, reached through the Android
    /// entry point rather than wry's `on_download` event.
    #[test]
    fn finishing_one_android_download_does_not_settle_the_other() {
        with_tmp_app(|app| {
            record_download_start(app, "https://files.test/a.bin", "/tmp/a.bin", false);
            record_download_start(app, "https://files.test/b.bin", "/tmp/b.bin", false);
            on_finished(app, true, Some("https://files.test/a.bin"));

            let rows = live_rows(app);
            assert_eq!(rows.len(), 2);
            assert_eq!(
                rows[0].get("state").and_then(Value::as_str),
                Some("completed"),
                "the url that finished must settle its own row"
            );
            assert_eq!(
                rows[1].get("state").and_then(Value::as_str),
                Some("progressing"),
                "the still-running download must not be marked complete"
            );
        });
    }

    /// Exactly one event per recorded row. The row push and the event were split when the
    /// Android entry point was added (both call the shared `push_row`), so the emitter has
    /// to stay with the CALLER: emitting inside `push_row` as well would double every
    /// desktop event and double every Android one.
    #[test]
    fn a_android_download_start_tells_the_chrome_exactly_once() {
        with_tmp_app(|app| {
            let (tx, rx) = mpsc::channel();
            let _id = app.listen("downloads:changed", move |e| {
                let _ = tx.send(serde_json::from_str::<Value>(e.payload()).unwrap_or(Value::Null));
            });

            record_download_start(app, "https://files.test/one.pdf", "/tmp/one.pdf", false);
            assert!(
                rx.try_recv().is_ok(),
                "recording a row must tell the chrome so the sheet refreshes"
            );

            // A private tab records nothing, so it must not emit either.
            record_download_start(app, "https://files.test/two.pdf", "/tmp/two.pdf", true);
            assert!(
                rx.try_recv().is_err(),
                "a download that was NOT recorded must not produce an event"
            );
        });
    }

    /// The regression this pins, and the reason the Rust side is involved at all: Kotlin
    /// computed the row's `savePath` as `File(getExternalFilesDir("downloads"), "downloads")`,
    /// one directory below where the transfer actually wrote. Nothing above could see it,
    /// because `getExternalFilesDir` ALREADY appends its dirType -- and
    /// `DownloadManager.Request.setDestinationInExternalFilesDir` is implemented as exactly
    /// `getExternalFilesDir(dirType) + <fileName>` (frameworks/base
    /// `core/java/android/app/DownloadManager.java`), so the two paths could never agree.
    /// The row named a directory that never existed, `downloads.openFile` /
    /// `showInFolder` pointed at nothing, and `trusted_download_path`'s `is_file()` failed on
    /// the row's own prefix.
    ///
    /// The fix is in Kotlin, and this project has NO Kotlin test source set, so the pin is
    /// the strongest thing available: it reads the Kotlin SOURCE and asserts the two halves
    /// that must stay in step. It is a text pin, so it is also verified against the
    /// COMPILER (the Gradle build), which is the half a Rust test cannot reach.
    #[test]
    fn the_kotlin_download_directory_is_the_one_the_platform_writes_into() {
        use crate::test_support::{kotlin_fn_body, kotlin_source};
        let src = kotlin_source("MainActivity.kt");

        let dir = kotlin_fn_body(&src, "private fun downloadDir()");
        assert!(
            dir.contains("getExternalFilesDir(DOWNLOAD_SUBDIR)"),
            "downloadDir() must resolve the platform's own directory; \
             the platform's getExternalFilesDir already appends the dirType"
        );
        assert!(
            !dir.contains("File("),
            "downloadDir() must not nest another directory under getExternalFilesDir: \
             that is the off-by-one, because setDestinationInExternalFilesDir writes into \
             getExternalFilesDir(<dirType>)/<fileName> and nothing deeper"
        );
        assert!(
            dir.contains("return null"),
            "with no directory there is no path a row may record, so downloadDir() must \
             report that instead of naming one the platform will never write to"
        );
        assert!(
            !dir.contains("filesDir"),
            "a filesDir fallback disagrees with setDestinationInExternalFilesDir, which \
             THROWS when the directory is unavailable; the fallback path would be recorded \
             and never written"
        );

        // The recorded path and the platform's destination must come from ONE name, or the
        // two can drift apart again with nothing to catch it.
        let listener = kotlin_fn_body(&src, "private fun wireDownloadListener(");
        assert!(
            listener.contains("File(dir, name)"),
            "the recorded savePath is the file inside the directory downloadDir() resolved"
        );
        assert!(
            listener.contains("setDestinationInExternalFilesDir(this, DOWNLOAD_SUBDIR, name)"),
            "the platform destination must be the SAME constant the recorded path is built from"
        );
        assert!(
            !listener.contains("setDestinationInExternalFilesDir(this, \"downloads\""),
            "a literal here would be a second name for the subdirectory, which is how the \
             two sides drifted in the first place"
        );
        // And the null case must be handled BEFORE a row is recorded, not after. The bail is
        // searched FORWARD from the resolution: the listener already returns early for a
        // non-http URL, and that earlier return says nothing about the directory.
        let null_at = listener
            .find("downloadDir()")
            .expect("the listener resolves the directory");
        let bail_at = listener[null_at..]
            .find("return@setDownloadListener")
            .map(|i| null_at + i)
            .expect("the listener drops a download it cannot place");
        let record_at = listener
            .find("NativeDownloads.recordStart")
            .expect("the listener records the row");
        assert!(
            null_at < bail_at && bail_at < record_at,
            "with no directory the download must be dropped BEFORE recordStart, or the row \
             would advertise a file that was never written"
        );
    }

    /// The pin above reads `MainActivity.kt`; if a future refactor moves `downloadDir()`
    /// into another file the pin would still pass on stale text, so the constant has to
    /// actually exist where the pin says it does.
    #[test]
    fn the_kotlin_download_subdirectory_constant_exists() {
        let src = crate::test_support::kotlin_source("MainActivity.kt");
        assert!(
            src.contains("private const val DOWNLOAD_SUBDIR = \"downloads\""),
            "DOWNLOAD_SUBDIR is the single name the recorded path and the platform \
             destination share; without it the pin above is asserting a fiction"
        );
    }
}
