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
//! behavior needs a Windows desktop to confirm. There is consequently no unit test for
//! this module — `mod adblock_win` is `#[cfg(target_os = "windows")]`, so a test here
//! could only ever run on a Windows machine. What IS covered on every platform is the
//! policy both this tier and Android's share, in `adblock_engine::should_block`; the
//! Windows-specific part is only the plumbing that supplies the page URL.

use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2Environment, ICoreWebView2WebResourceRequestedEventArgs,
    COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
};
use webview2_com::WebResourceRequestedEventHandler;
use windows::core::{Result, HSTRING, PWSTR};

/// Install the ad-block request interceptor on the content webview. Call inside
/// `content_webview.with_webview(|pw| adblock_win::install(&pw, app, id))`. `app`+`id`
/// let the block branch bump the shield badge (`adblock::note_blocked`). Fails silently
/// if the WebView2 isn't ready — ad-block just won't be active, browsing is unaffected.
pub fn install(pw: &tauri::webview::PlatformWebview, app: tauri::AppHandle, id: u32) {
    let controller = pw.controller();
    let environment = pw.environment();
    // SAFETY: COM objects are single-threaded apartment; this runs inside a
    // `with_webview` closure on the UI thread — the only safe calling context.
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
        let handler = WebResourceRequestedEventHandler::create(Box::new(move |core, args| {
            if let Some(args) = args {
                // Fail open: never break a page if our check errors. Count only in the
                // branch that actually blocks (not allowed requests, not pop-under path).
                if handle(&env, core.as_ref(), &args).unwrap_or(false) {
                    crate::adblock::note_blocked(&app, id);
                }
            }
            Ok(())
        }));
        let mut token: i64 = 0;
        let _ = core.add_WebResourceRequested(&handler, &mut token);
    }
}

/// The page URL the WebView is currently showing, or `""` if it can't be read.
///
/// Needed because the ad-block allowlist is a PER-PAGE trust list, and
/// `ICoreWebView2WebResourceRequestedEventArgs` exposes no source-document property —
/// the event args carry only the request. `ICoreWebView2::Source` (handed to the handler
/// as its first argument) is the page the request belongs to.
///
/// Reading it per request is a COM call on the UI thread's hot path, so it is only done
/// when the engine would otherwise block: `should_block` short-circuits on its toggle
/// first, and the URL is parsed only on the blocking path.
///
/// # Safety
/// Caller must ensure COM pointers are valid and this runs on the UI thread.
unsafe fn page_url(core: Option<&ICoreWebView2>) -> String {
    let Some(core) = core else {
        return String::new();
    };
    let mut src = PWSTR::null();
    // A failure here is not worth propagating: an unknown page just means the allowlist
    // veto can't apply, which is the same as the pre-fix behaviour.
    if core.Source(&mut src).is_err() || src.is_null() {
        return String::new();
    }
    src.to_string().unwrap_or_default()
}

/// Block a single request if the adblock engine matches it. Returns `Ok(true)` when the
/// request was blocked (so the caller can count it on the shield badge), `Ok(false)`
/// when it was allowed.
///
/// # Safety
/// Caller must ensure COM pointers are valid and this runs on the UI thread.
unsafe fn handle(
    env: &ICoreWebView2Environment,
    core: Option<&ICoreWebView2>,
    args: &ICoreWebView2WebResourceRequestedEventArgs,
) -> Result<bool> {
    let request = args.Request()?;
    let mut uri = PWSTR::null();
    request.Uri(&mut uri)?;
    if uri.is_null() {
        return Ok(false);
    }
    let url = uri.to_string().unwrap_or_default();
    if !url.starts_with("http") {
        return Ok(false);
    }
    // Ask the engine first with the real page URL, so BOTH the allowlist veto and any
    // `$third-party`-conditional rule can see the page. Previously this passed `""`, which
    // made the allowlist branch unreachable (`host_of("")` is `None`) and made every
    // request look first-party — the tier blocked EasyList's domain anchors but ignored
    // both the allowlist and the privacy lists' third-party rules.
    let page = page_url(core);
    if crate::adblock_engine::should_block(&url, &page, "other") {
        // Substitute an empty 204 so the resource never loads.
        let response = env.CreateWebResourceResponse(
            None,
            204,
            &HSTRING::from("Blocked by Aegis"),
            &HSTRING::from(""),
        )?;
        args.SetResponse(&response)?;
        return Ok(true);
    }
    Ok(false)
}
