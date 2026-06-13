// Linux ad-blocking via WebKit content filters + cosmetic injection.
//
// WebKit exposes no external-request interception, so network blocking uses
// declarative content filters (Safari content-blocker JSON) loaded into the
// content webview's UserContentManager. The safe webkit2gtk binding stubs
// `add_filter`, so we compile + add each filter via `webkit2gtk-sys` FFI
// (store_new → save [async] → add_filter in the GAsyncReadyCallback). The
// converted rules already include cosmetic `css-display-none`, so the filters
// cover element hiding too; `apply_cosmetic_css` remains for extra rules.
//
// Mechanism proven (a content filter blocks a target URL; verified 2026-06-13).
#![allow(dead_code)]
use std::ffi::CString;
use std::path::{Path, PathBuf};

use glib::translate::ToGlibPtr;
use tauri::{AppHandle, Manager};
use webkit2gtk::{
    UserContentInjectedFrames, UserContentManagerExt, UserStyleLevel, UserStyleSheet, WebViewExt,
};

use crate::nav::CONTENT_LABEL;

/// Apply content-blocker JSON `chunks` (each its own WebKit content filter) to the
/// content webview. `store_dir` caches the compiled filters across runs.
pub fn apply_filters(app: &AppHandle, chunks: Vec<String>, store_dir: PathBuf) {
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
        for (i, json) in chunks.iter().enumerate() {
            unsafe { add_content_filter(&ucm, &format!("aegis-{i}"), json, &store_dir) };
        }
    });
}

/// Inject an element-hiding stylesheet (safe API). For cosmetic rules beyond what
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

/// Compile `json` into a WebKitUserContentFilter named `identifier` and add it to
/// `ucm`. The save is async; the filter is added in `save_done`. Safety: `ucm` is
/// ref'd (+1) for the callback and released there; `store` is intentionally leaked
/// (app-lifetime).
unsafe fn add_content_filter(
    ucm: &webkit2gtk::UserContentManager,
    identifier: &str,
    json: &str,
    store_dir: &Path,
) {
    let Ok(dir_c) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
        return;
    };
    let store = webkit2gtk::ffi::webkit_user_content_filter_store_new(dir_c.as_ptr());
    if store.is_null() {
        return;
    }
    let Ok(id) = CString::new(identifier) else {
        return;
    };
    let bytes = glib::Bytes::from(json.as_bytes());
    let stash = bytes.to_glib_none();
    let bytes_ptr: *const glib::ffi::GBytes = stash.0;
    // +1 ref kept alive across the async callback (released in save_done).
    let ucm_ptr: *mut webkit2gtk::ffi::WebKitUserContentManager = ucm.to_glib_full();

    webkit2gtk::ffi::webkit_user_content_filter_store_save(
        store,
        id.as_ptr(),
        bytes_ptr as *mut glib::ffi::GBytes,
        std::ptr::null_mut(),
        Some(save_done),
        ucm_ptr as glib::ffi::gpointer,
    );
}

unsafe extern "C" fn save_done(
    source: *mut glib::gobject_ffi::GObject,
    res: *mut gio::ffi::GAsyncResult,
    user_data: glib::ffi::gpointer,
) {
    let store = source as *mut webkit2gtk::ffi::WebKitUserContentFilterStore;
    let ucm = user_data as *mut webkit2gtk::ffi::WebKitUserContentManager;
    let mut err: *mut glib::ffi::GError = std::ptr::null_mut();
    let filter = webkit2gtk::ffi::webkit_user_content_filter_store_save_finish(store, res, &mut err);
    if !filter.is_null() {
        webkit2gtk::ffi::webkit_user_content_manager_add_filter(ucm, filter);
        webkit2gtk::ffi::webkit_user_content_filter_unref(filter);
        eprintln!("[aegis-cf] content filter added");
    } else {
        eprintln!("[aegis-cf] content filter save failed (err set: {})", !err.is_null());
        if !err.is_null() {
            glib::ffi::g_error_free(err);
        }
    }
    glib::gobject_ffi::g_object_unref(ucm as *mut glib::gobject_ffi::GObject);
}
