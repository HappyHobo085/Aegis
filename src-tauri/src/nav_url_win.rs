//! Windows: keep the address bar on the main-frame URL across same-document
//! navigations — History API (`pushState`/`replaceState`) and hash changes — which
//! wry's `NavigationCompleted`-based `on_page_load` doesn't report. WebView2's
//! `SourceChanged` event fires whenever the top-level `Source` changes, for BOTH
//! new-document and same-document updates, so it's the WebView2 analog of Linux's
//! WebKitGTK `notify::uri` (`linux_layout::connect_url_tracker`). Reached via Tauri's
//! `with_webview` -> `PlatformWebview::controller()`, mirroring `adblock_win.rs`.
//!
//! Compile-verified (`cargo check --target x86_64-pc-windows-gnu` + CI msvc); the
//! runtime behavior needs a Windows desktop to confirm.

use tauri::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2;
use webview2_com::SourceChangedEventHandler;
use windows::core::PWSTR;

/// Install a `SourceChanged` handler on the content webview that pushes the current
/// top-frame URL to the chrome address bar (`nav.state`). Call inside
/// `content.with_webview(|pw| nav_url_win::install(&pw, app, id))`. Fails silently if
/// the WebView2 isn't ready — the bar just won't track same-document nav; browsing is
/// unaffected (full loads are still reported by `on_page_load`).
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    let controller = pw.controller();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        let core_for_handler = core.clone();
        let handler = SourceChangedEventHandler::create(Box::new(move |_sender, args| {
            // `IsNewDocument` distinguishes a full navigation from a same-document
            // History-API change — used as the loading hint for the bar's spinner.
            let loading = args
                .and_then(|a| {
                    let mut is_new = windows::core::BOOL::default();
                    a.IsNewDocument(&mut is_new).ok().map(|_| is_new.as_bool())
                })
                .unwrap_or(false);
            if let Ok(url) = source_url(&core_for_handler) {
                if !url.is_empty() {
                    crate::nav::emit_state(&app, id, &url, "", loading);
                }
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = core.add_SourceChanged(&handler, &mut token);
    }
}

/// Read `ICoreWebView2::Source` — the current top-frame URL.
unsafe fn source_url(core: &ICoreWebView2) -> windows::core::Result<String> {
    let mut uri = PWSTR::null();
    core.Source(&mut uri)?;
    if uri.is_null() {
        return Ok(String::new());
    }
    Ok(uri.to_string().unwrap_or_default())
}
