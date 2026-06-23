//! Windows: per-tab page zoom via WebView2 `ICoreWebView2Controller::SetZoomFactor`.
//! `SetZoomFactor` lives directly on the controller — NOT on `ICoreWebView2` — so we
//! call it on the value returned by `pw.controller()` without a `CoreWebView2()` hop.
//! Reached via Tauri's `with_webview` -> `PlatformWebview::controller()`, mirroring
//! adblock_win/nav_url_win. Compile-verified (`cargo check --target
//! x86_64-pc-windows-gnu` + CI msvc); runtime needs a Windows desktop.

/// Set the content webview's zoom factor (1.0 == 100%). Fails silently if the
/// WebView2 isn't ready — browsing is unaffected, zoom just won't apply.
pub fn set(pw: &tauri::webview::PlatformWebview, factor: f64) {
    let controller = pw.controller();
    unsafe {
        let _ = controller.SetZoomFactor(factor);
    }
}
