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
// cover element hiding too; `apply_cosmetic_css` remains for extra rules.
//
// Mechanism proven (a content filter blocks a target URL; verified 2026-06-13).
#![allow(dead_code)]
use std::ffi::CString;
use std::path::PathBuf;

use glib::translate::ToGlibPtr;
use tauri::{AppHandle, Manager};
use webkit2gtk::{
    UserContentInjectedFrames, UserContentManagerExt, UserStyleLevel, UserStyleSheet, WebViewExt,
};

use crate::nav::CONTENT_LABEL;

/// Apply content-blocker JSON `chunks` to the content webview, each as its own
/// WebKit content filter named `aegis-{i}`. When `cached` is true the filters are
/// loaded from `store_dir` (fast); otherwise they are compiled and saved (slow,
/// first run). `store_dir` persists compiled filters across runs.
pub fn apply_filters(app: &AppHandle, chunks: Vec<String>, store_dir: PathBuf, cached: bool) {
    if chunks.is_empty() {
        return;
    }
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
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
        let store = unsafe { webkit2gtk::ffi::webkit_user_content_filter_store_new(dir_c.as_ptr()) };
        if store.is_null() {
            return;
        }
        for (i, json) in chunks.iter().enumerate() {
            let id = format!("aegis-{i}");
            unsafe { install_filter(&ucm, store, &id, json, cached) };
        }
    });
}

/// Inject an element-hiding stylesheet (safe API), for cosmetic rules beyond what
/// the content filter expresses.
pub fn apply_cosmetic_css(app: &AppHandle, css: String) {
    if css.is_empty() {
        return;
    }
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let _ = content.with_webview(move |pw| {
        if let Some(ucm) = pw.inner().user_content_manager() {
            let empty: [&str; 0] = [];
            let sheet = UserStyleSheet::new(
                &css,
                UserContentInjectedFrames::AllFrames,
                UserStyleLevel::User,
                &empty,
                &empty,
            );
            ucm.add_style_sheet(&sheet);
        }
    });
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
    let ctx = Box::into_raw(Box::new(FilterCtx { ucm: ucm.to_glib_full() }));

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
        eprintln!("[aegis-cf] filter {what} FAILED (err set: {})", !err.is_null());
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
    let filter = webkit2gtk::ffi::webkit_user_content_filter_store_save_finish(store, res, &mut err);
    add_and_finish(filter, err, user_data as *mut FilterCtx, "compiled+added");
}

unsafe extern "C" fn load_done(
    source: *mut glib::gobject_ffi::GObject,
    res: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let store = source as *mut webkit2gtk::ffi::WebKitUserContentFilterStore;
    let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
    let filter = webkit2gtk::ffi::webkit_user_content_filter_store_load_finish(store, res, &mut err);
    add_and_finish(filter, err, user_data as *mut FilterCtx, "loaded+added");
}
