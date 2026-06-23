//! Windows full network ad-blocking. wry's WebView2 backend only intercepts
//! custom-protocol requests, so Aegis registers its OWN `WebResourceRequested`
//! handler (all-URLs filter) directly on the content webview's `ICoreWebView2`,
//! reached via Tauri's `Webview::with_webview` -> `PlatformWebview`. The handler asks
//! the same `adblock` engine the rest of the app uses and substitutes an empty 204
//! response for ad/tracker requests — true network blocking, including the HTML
//! parser's `<img>`/`<script>`/`<iframe>` loads that the injected JS tier can't catch.
//!
//! Intricate unsafe COM, mirroring wry's webview2 handler patterns. Compile-verified
//! (`cargo check --target x86_64-pc-windows-gnu` + the CI msvc build); the runtime
//! behavior needs a Windows desktop to confirm.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
};
use webview2_com::WebResourceRequestedEventHandler;
use windows::core::{Result, HSTRING, PWSTR};

/// Install the ad-block request interceptor on the content webview. Call inside
/// `content_webview.with_webview(|pw| adblock_win::install(&pw))`. Fails silently if
/// the WebView2 isn't ready — ad-block just won't be active, browsing is unaffected.
pub fn install(pw: &tauri::webview::PlatformWebview) {
    let controller = pw.controller();
    let environment = pw.environment();
    unsafe {
        let core = match controller.CoreWebView2() {
            Ok(c) => c,
            Err(_) => return,
        };
        // Fire WebResourceRequested for every request (not just custom protocols).
        if core
            .AddWebResourceRequestedFilter(
                &HSTRING::from("*"),
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
            )
            .is_err()
        {
            return;
        }
        let env = environment.clone();
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |_core, args| {
            if let Some(args) = args {
                // Fail open: never break a page if our check errors.
                let _ = handle(&env, &args);
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = core.add_WebResourceRequested(&handler, &mut token);
    }
}

/// Block a single request if the adblock engine matches it.
unsafe fn handle(
    env: &ICoreWebView2Environment,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> Result<()> {
    let request = args.Request()?;
    let mut uri = PWSTR::null();
    request.Uri(&mut uri)?;
    if uri.is_null() {
        return Ok(());
    }
    let url = uri.to_string().unwrap_or_default();
    if !url.starts_with("http") {
        return Ok(());
    }
    // EasyList domain anchors (`||host^`) match on the request host regardless of the
    // source page or resource type, so an empty source / "other" type blocks the bulk
    // of ad/tracker requests.
    if crate::adblock_engine::should_block(&url, "", "other") {
        // Substitute an empty 204 so the resource never loads.
        let response = env.CreateWebResourceResponse(
            None,
            204,
            &HSTRING::from("Blocked by Aegis"),
            &HSTRING::from(""),
        )?;
        args.SetResponse(&response)?;
    }
    Ok(())
}
