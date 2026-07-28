// Linux ad-blocking via WebKit content filters + cosmetic injection.
//
// WebKit exposes no external-request interception, so network blocking uses
// declarative content filters (Safari content-blocker JSON) loaded into the
// content webview's UserContentManager. The safe webkit2gtk binding stubs
// `add_filter`, so we compile + add each filter via `webkit2gtk-sys` FFI.
//
// Compiling ~78k rules takes many seconds, so we cache: `WebKitUserContentFilterStore`
// stores compiled filters by identifier on disk. First run compiles (`save`); later
// runs load the pre-compiled bytecode (`load`, fast). A version-marker file (keyed on
// the source hash) selects load-vs-save. Both are async (GAsyncReadyCallback); the
// filter is added to the UserContentManager in the callback.
//
// Converted rules already include cosmetic `css-display-none`, so the content filters
// cover element hiding too.
//
// Mechanism proven (a content filter blocks a target URL; verified 2026-06-13).
#![allow(dead_code)]
use std::ffi::CString;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Mutex, OnceLock};

use glib::translate::ToGlibPtr;
use tauri::{AppHandle, Manager, Runtime};
use webkit2gtk::{UserContentManagerExt, WebViewExt};

/// The converted EasyList filters, cached after the first conversion so tabs
/// spawned *later* (`apply_to_new_tab`) get the same filters as the boot tab.
/// WebKit content filters live on each webview's own `UserContentManager`, so a
/// filter added to one tab does NOT cover another — every tab must be filtered.
struct CachedFilters {
    chunks: Vec<String>,
    store_dir: PathBuf,
    cached: bool,
}
static FILTERS: OnceLock<Mutex<Option<CachedFilters>>> = OnceLock::new();
fn filters_cell() -> &'static Mutex<Option<CachedFilters>> {
    FILTERS.get_or_init(|| Mutex::new(None))
}

// --- Deferred ready-marker (fixes a stale-cache race) ---
// Compiling a chunk persists it to the on-disk store ASYNCHRONOUSLY (the
// `webkit_user_content_filter_store_save` callback). The "these filters are
// compiled" marker must therefore be written only AFTER every save callback has
// fired — writing it up front (as install_adblock used to) races a mid-compile
// exit: the marker survives but the blobs are partial/stale, so the next launch
// does `cached=true` and loads incomplete filters → silent under-blocking.
// `arm_ready_marker` records how many compiles to wait for; each `save_done`
// decrements, and the last one writes the marker. Callbacks run on the single GTK
// main loop, so plain atomics (no real concurrency) are enough. Armed only on the
// compile path (`cached=false`); loads leave the count at 0 and never write.
static SAVES_PENDING: AtomicUsize = AtomicUsize::new(0);
static READY_MARKER: OnceLock<Mutex<Option<PathBuf>>> = OnceLock::new();
fn ready_marker_cell() -> &'static Mutex<Option<PathBuf>> {
    READY_MARKER.get_or_init(|| Mutex::new(None))
}

/// Arm the deferred ready-marker: once `expected` chunk compiles have completed,
/// `marker` is written so the next launch can safely load the now-complete filters.
pub fn arm_ready_marker(expected: usize, marker: PathBuf) {
    *ready_marker_cell()
        .lock()
        .unwrap_or_else(|e| e.into_inner()) = Some(marker);
    SAVES_PENDING.store(expected, Ordering::SeqCst);
}

/// One chunk compile finished (success or failure). When the last armed compile
/// completes, write the ready-marker. No-op when not armed (the load path).
fn note_save_complete() {
    if SAVES_PENDING.load(Ordering::SeqCst) == 0 {
        return; // not armed (load path, or already written)
    }
    if SAVES_PENDING.fetch_sub(1, Ordering::SeqCst) == 1 {
        if let Some(marker) = ready_marker_cell()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            if let Some(dir) = marker.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&marker, b"");
            eprintln!(
                "[aegis-cf] ready-marker written ({} compiles done)",
                marker.display()
            );
        }
    }
}

/// Apply content-blocker JSON `chunks` to **every** content webview (all tabs),
/// each chunk as its own WebKit content filter named `aegis-{i}`, and cache them
/// so tabs spawned afterwards are filtered too (`apply_to_new_tab`). When `cached`
/// is true the filters are loaded from `store_dir` (fast); otherwise compiled and
/// saved (slow, first run). `store_dir` persists compiled filters across runs.
pub fn apply_filters<R: Runtime>(
    app: &AppHandle<R>,
    chunks: Vec<String>,
    store_dir: PathBuf,
    cached: bool,
) {
    if chunks.is_empty() {
        return;
    }
    *filters_cell().lock().unwrap_or_else(|e| e.into_inner()) = Some(CachedFilters {
        chunks: chunks.clone(),
        store_dir: store_dir.clone(),
        cached,
    });
    for (label, content) in app.webviews() {
        if is_content_label(&label) {
            install_on(content, &chunks, &store_dir, cached);
        }
    }
}

/// Apply the cached filters to a single just-spawned tab's webview (called from
/// `nav::spawn_tab`). No-op when ad-block is off or the filters aren't converted
/// yet (the boot `apply_filters` covers tabs that exist at startup).
pub fn apply_to_new_tab<R: Runtime>(app: &AppHandle<R>, label: &str) {
    let enabled = app
        .try_state::<crate::adblock::AdblockState>()
        .map(|s| s.0.lock().unwrap_or_else(|e| e.into_inner()).enabled)
        .unwrap_or(true);
    if !enabled {
        return;
    }
    let guard = filters_cell().lock().unwrap_or_else(|e| e.into_inner());
    if let (Some(f), Some(content)) = (guard.as_ref(), app.get_webview(label)) {
        eprintln!("[aegis-cf] applying filters to new tab {label}");
        install_on(content, &f.chunks, &f.store_dir, f.cached);
    }
}

fn is_content_label(label: &str) -> bool {
    label.starts_with("content:")
}

/// Install `chunks` as WebKit content filters on one webview's UserContentManager.
#[allow(clippy::ptr_arg)] // store_dir is cloned into an async closure that must be 'static; &Path can't be moved into it
fn install_on<R: Runtime>(
    content: tauri::Webview<R>,
    chunks: &[String],
    store_dir: &PathBuf,
    cached: bool,
) {
    let chunks = chunks.to_vec();
    let store_dir = store_dir.clone();
    let _ = content.with_webview(move |pw| {
        let webview = pw.inner();
        let Some(ucm) = webview.user_content_manager() else {
            eprintln!("[aegis-cf] no user content manager");
            return;
        };
        let _ = std::fs::create_dir_all(&store_dir);
        let Ok(dir_c) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
            return;
        };
        // One store handle (to the on-disk cache dir), shared by all chunks and
        // intentionally leaked (it must outlive the async callbacks; app lifetime).
        let store =
            unsafe { webkit2gtk::ffi::webkit_user_content_filter_store_new(dir_c.as_ptr()) };
        if store.is_null() {
            return;
        }
        for (i, json) in chunks.iter().enumerate() {
            let id = format!("aegis-{i}");
            unsafe { install_filter(&ucm, store, &id, json, cached) };
        }
    });
}

/// Remove all content filters from **every** content webview (ad-block disabled).
pub fn remove_all<R: Runtime>(app: &AppHandle<R>) {
    for (label, content) in app.webviews() {
        if !is_content_label(&label) {
            continue;
        }
        let _ = content.with_webview(move |pw| {
            if let Some(ucm) = pw.inner().user_content_manager() {
                ucm.remove_all_filters();
            }
        });
    }
}

/// Heap state carried through the async load/save callback so the filter can be
/// added to the right manager. `ucm` holds a +1 ref released in the callback.
struct FilterCtx {
    ucm: *mut webkit2gtk::ffi::WebKitUserContentManager,
}

/// `cached` → load the pre-compiled filter `identifier` from `store`; else compile
/// `json` and save it under `identifier` (caching it for next time).
unsafe fn install_filter(
    ucm: &webkit2gtk::UserContentManager,
    store: *mut webkit2gtk::ffi::WebKitUserContentFilterStore,
    identifier: &str,
    json: &str,
    cached: bool,
) {
    let Ok(id) = CString::new(identifier) else {
        return;
    };
    let ctx = Box::into_raw(Box::new(FilterCtx {
        ucm: ucm.to_glib_full(),
    }));

    if cached {
        webkit2gtk::ffi::webkit_user_content_filter_store_load(
            store,
            id.as_ptr(),
            std::ptr::null_mut(),
            Some(load_done),
            ctx as glib::ffi::gpointer,
        );
    } else {
        let bytes = glib::Bytes::from(json.as_bytes());
        let stash = bytes.to_glib_none();
        let bytes_ptr: *const glib::ffi::GBytes = stash.0;
        webkit2gtk::ffi::webkit_user_content_filter_store_save(
            store,
            id.as_ptr(),
            bytes_ptr as *mut glib::ffi::GBytes,
            std::ptr::null_mut(),
            Some(save_done),
            ctx as glib::ffi::gpointer,
        );
    }
}

/// Add `filter` to the manager in `ctx`, then release the ctx + its ucm ref.
unsafe fn add_and_finish(
    filter: *mut webkit2gtk::ffi::WebKitUserContentFilter,
    err: *mut glib::ffi::GError,
    ctx: *mut FilterCtx,
    what: &str,
) {
    if !filter.is_null() {
        webkit2gtk::ffi::webkit_user_content_manager_add_filter((*ctx).ucm, filter);
        webkit2gtk::ffi::webkit_user_content_filter_unref(filter);
        eprintln!("[aegis-cf] filter {what}");
    } else {
        eprintln!(
            "[aegis-cf] filter {what} FAILED (err set: {})",
            !err.is_null()
        );
        if !err.is_null() {
            glib::ffi::g_error_free(err);
        }
    }
    glib::gobject_ffi::g_object_unref((*ctx).ucm as *mut glib::gobject_ffi::GObject);
    drop(Box::from_raw(ctx));
}

unsafe extern "C" fn save_done(
    source: *mut glib::gobject_ffi::GObject,
    res: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let store = source as *mut webkit2gtk::ffi::WebKitUserContentFilterStore;
    let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
    let filter =
        webkit2gtk::ffi::webkit_user_content_filter_store_save_finish(store, res, &mut err);
    add_and_finish(filter, err, user_data as *mut FilterCtx, "compiled+added");
    // A compile finished — only now is this chunk safely on disk. Write the marker
    // once the last one lands (avoids the stale-cache race; see arm_ready_marker).
    note_save_complete();
}

unsafe extern "C" fn load_done(
    source: *mut glib::gobject_ffi::GObject,
    res: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let store = source as *mut webkit2gtk::ffi::WebKitUserContentFilterStore;
    let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
    let filter =
        webkit2gtk::ffi::webkit_user_content_filter_store_load_finish(store, res, &mut err);
    add_and_finish(filter, err, user_data as *mut FilterCtx, "loaded+added");
}

#[cfg(test)]
mod tests {
    use super::is_content_label;

    #[test]
    fn content_labels_are_matched_but_chrome_is_not() {
        // Every tab webview is "content:<id>" (see nav::content_label); the chrome
        // (React UI) webview must NEVER get ad-block content filters or the UI breaks.
        assert!(is_content_label("content:1"));
        assert!(is_content_label("content:42"));
        assert!(!is_content_label("main"));
        assert!(!is_content_label(""));
        assert!(!is_content_label("contentish"));
    }
}
