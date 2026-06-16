//! macOS: keep the address bar on the main-frame URL across same-document navigations
//! — History API (`pushState`/`replaceState`) and hash changes — which wry's
//! `WKNavigationDelegate` callbacks (behind `on_page_load`) don't report. We observe
//! the WKWebView's `URL` property via KVO; it's the WKWebView analog of Linux's
//! WebKitGTK `notify::uri` (`linux_layout::connect_url_tracker`) and Windows'
//! `SourceChanged` (`nav_url_win.rs`). The observer object mirrors wry's own
//! `DocumentTitleChangedObserver` (objc2 0.6 `define_class!` + KVO registration),
//! changed from the `title` key path to `URL`.
//!
//! Reached via Tauri's `with_webview` -> `PlatformWebview::inner()` (the WKWebView).
//! Compiles on macOS CI (macos-latest); runtime behavior needs a macOS desktop.

use std::ffi::c_void;
use std::ptr::null_mut;

use objc2::rc::Retained;
use objc2::runtime::{AnyObject, NSObject};
use objc2::{define_class, msg_send, AllocAnyThread, DefinedClass};
use objc2_foundation::{
    ns_string, NSDictionary, NSKeyValueChangeKey, NSKeyValueObservingOptions,
    NSObjectNSKeyValueObserverRegistration, NSObjectProtocol, NSString, NSURL,
};
use objc2_web_kit::WKWebView;
use tauri::AppHandle;

pub struct UrlObserverIvars {
    object: Retained<WKWebView>,
    handler: Box<dyn Fn(String)>,
}

define_class!(
    #[unsafe(super(NSObject))]
    #[ivars = UrlObserverIvars]
    pub struct UrlObserver;

    /// NSKeyValueObserving.
    impl UrlObserver {
        #[unsafe(method(observeValueForKeyPath:ofObject:change:context:))]
        fn observe_value_for_key_path(
            &self,
            key_path: Option<&NSString>,
            of_object: Option<&AnyObject>,
            _change: Option<&NSDictionary<NSKeyValueChangeKey, AnyObject>>,
            _context: *mut c_void,
        ) {
            if let (Some(key_path), Some(object)) = (key_path, of_object) {
                unsafe {
                    if key_path.isEqualToString(ns_string!("URL")) {
                        let url: *const NSURL = msg_send![object, URL];
                        if !url.is_null() {
                            let abs: *const NSString = msg_send![url, absoluteString];
                            if !abs.is_null() {
                                (self.ivars().handler)((*abs).to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    unsafe impl NSObjectProtocol for UrlObserver {}
);

impl UrlObserver {
    fn new(webview: Retained<WKWebView>, handler: Box<dyn Fn(String)>) -> Retained<Self> {
        let observer = Self::alloc().set_ivars(UrlObserverIvars {
            object: webview,
            handler,
        });
        let observer: Retained<Self> = unsafe { msg_send![super(observer), init] };
        unsafe {
            observer
                .ivars()
                .object
                .addObserver_forKeyPath_options_context(
                    &observer,
                    ns_string!("URL"),
                    NSKeyValueObservingOptions::New,
                    null_mut(),
                );
        }
        observer
    }
}

impl Drop for UrlObserver {
    fn drop(&mut self) {
        unsafe {
            self.ivars()
                .object
                .removeObserver_forKeyPath(self, ns_string!("URL"));
        }
    }
}

/// Install a KVO observer on the content WKWebView that pushes top-frame URL changes
/// to the chrome address bar (`nav.state`). Call inside
/// `content.with_webview(|pw| nav_url_mac::install(&pw, app, id))`. The observer is
/// leaked (one per tab, app lifetime) so KVO stays registered for the tab's life.
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    let ptr = pw.inner() as *mut WKWebView;
    if ptr.is_null() {
        return;
    }
    // pw.inner() is a borrowed WKWebView pointer (wry owns it) — retain a strong ref.
    let webview: Retained<WKWebView> = match unsafe { Retained::retain(ptr) } {
        Some(w) => w,
        None => return,
    };
    let observer = UrlObserver::new(
        webview,
        Box::new(move |url: String| {
            if !url.is_empty() {
                // Same-document URL change (History API/hash) → not a fresh load.
                crate::nav::emit_state(&app, id, &url, "", false);
            }
        }),
    );
    // KVO needs the observer alive for as long as it's registered; keep it for the
    // tab/app lifetime (the WKWebView outlives this call).
    std::mem::forget(observer);
}
