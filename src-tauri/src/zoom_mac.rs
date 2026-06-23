//! macOS: per-tab page zoom via `WKWebView::setPageZoom` (CONTENT zoom — the Ctrl
//! +/− analog, NOT `setMagnification`'s pinch scale). Reached via Tauri's
//! `with_webview` -> `PlatformWebview::inner()` (the WKWebView). `setPageZoom` is
//! gated on the `objc2-core-foundation` feature (CGFloat); that feature is enabled in
//! Cargo.toml. Compiles on macOS CI (macos-latest); runtime needs a macOS desktop.
//! objc2 cannot be built from Linux (the build script needs a macOS C toolchain —
//! see aegis-macos-crosscompile memory) — CI-verify only.

use objc2::rc::Retained;
use objc2_web_kit::WKWebView;

/// Set the content WKWebView's page zoom (1.0 == 100%). Fails silently if the
/// pointer is null — browsing is unaffected, zoom just won't apply.
pub fn set(pw: &tauri::webview::PlatformWebview, factor: f64) {
    let ptr = pw.inner() as *mut WKWebView;
    if ptr.is_null() {
        return;
    }
    // SAFETY: ptr is non-null and is a valid WKWebView owned by wry.
    if let Some(webview) = unsafe { Retained::retain(ptr) } {
        // setPageZoom takes CGFloat (= f64 on all Apple targets); pass factor directly.
        unsafe { webview.setPageZoom(factor) };
    }
}
