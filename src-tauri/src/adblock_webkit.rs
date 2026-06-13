// Linux ad-blocking via WebKit content filters + cosmetic injection.
//
// WebKit exposes no external-request interception, so network blocking uses a
// declarative content filter (Safari content-blocker JSON) loaded into the
// content webview's UserContentManager. The safe webkit2gtk binding stubs
// `add_filter`, so we compile + add the filter via `webkit2gtk-sys` FFI
// (store_new → save [async] → add_filter in the GAsyncReadyCallback). Cosmetic
// element-hiding CSS uses the safe `add_style_sheet`.
//
// Mechanism proven (a content filter blocks a target URL; verified 2026-06-13).
// `apply` is wired to real filter lists + the adblock.* state in the next step.
#![allow(dead_code)]
use std::ffi::CString;
use std::path::{Path, PathBuf};

use glib::translate::ToGlibPtr;
use tauri::{AppHandle, Manager};
use webkit2gtk::{
    UserContentInjectedFrames, UserContentManagerExt, UserStyleLevel, UserStyleSheet, WebViewExt,
};

use crate::nav::CONTENT_LABEL;

/// Apply a content-blocker JSON (network blocking) and cosmetic CSS to the
/// content webview. `store_dir` caches the compiled filter.
pub fn apply(app: &AppHandle, content_blocker_json: String, cosmetic_css: String, store_dir: PathBuf) {
    let Some(content) = app.get_webview(CONTENT_LABEL) else {
        return;
    };
    let _ = content.with_webview(move |pw| {
        let webview = pw.inner();
        let Some(ucm) = webview.user_content_manager() else {
            eprintln!("[aegis-cf] no user content manager");
            return;
        };

        if !cosmetic_css.is_empty() {
            let empty: [&str; 0] = [];
            let sheet = UserStyleSheet::new(
                &cosmetic_css,
                UserContentInjectedFrames::AllFrames,
                UserStyleLevel::User,
                &empty,
                &empty,
            );
            ucm.add_style_sheet(&sheet);
        }

        if !content_blocker_json.is_empty() {
            unsafe { add_content_filter(&ucm, &content_blocker_json, &store_dir) };
        }
    });
}

/// Compile `json` into a WebKitUserContentFilter and add it to `ucm`. The save is
/// async; the filter is added in `save_done`. Safety: `ucm` is ref'd (+1) for the
/// callback and released there; `store` is intentionally leaked (app-lifetime).
unsafe fn add_content_filter(ucm: &webkit2gtk::UserContentManager, json: &str, store_dir: &Path) {
    let _ = std::fs::create_dir_all(store_dir);
    let Ok(dir_c) = CString::new(store_dir.to_string_lossy().as_bytes()) else {
        return;
    };
    let store = webkit2gtk::ffi::webkit_user_content_filter_store_new(dir_c.as_ptr());
    if store.is_null() {
        return;
    }
    let id = CString::new("aegis").unwrap();
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
        eprintln!("[aegis-cf] content filter compiled + added");
    } else {
        eprintln!("[aegis-cf] content filter save failed (err set: {})", !err.is_null());
        if !err.is_null() {
            glib::ffi::g_error_free(err);
        }
    }
    glib::gobject_ffi::g_object_unref(ucm as *mut glib::gobject_ffi::GObject);
}
