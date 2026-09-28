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
//! behavior needs a Windows desktop to confirm. The COM plumbing itself can only be
//! exercised on a Windows machine, because `mod adblock_win` is
//! `#[cfg(target_os = "windows")]` — so the `tests` module at the bottom of this file
//! runs on the Windows CI leg, and the `x86_64-pc-windows-gnu` cross-check compile-verifies
//! it everywhere else. What IS covered on every platform is the policy both this tier and
//! Android's share, in `adblock_engine::should_block`, and the WebView2-resource-type ->
//! filter-type mapping, which is pure data and is therefore unit-tested in `adblock.rs` on
//! every host. The Windows-specific part is the plumbing that supplies that page URL and
//! that request type.

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
    // The request TYPE is the same story, for the same reason: it used to be the literal
    // `"other"`, which the engine types as `Other`, so not one `$script` / `$image` /
    // `$stylesheet` / `$xhr` / `$font` / `$media` / `$websocket` rule in EasyList or
    // EasyPrivacy could ever match on this tier — it acted only on host-anchored rules and
    // left the injected JS tier to carry the rest. `ResourceContext` is an
    // out-parameter getter (there is no value-returning `Context()`); a getter that fails
    // leaves `ALL` = 0, which maps to "other" — the old, conservative behaviour.
    let mut context = COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL;
    let _ = args.ResourceContext(&mut context);
    if crate::adblock_engine::should_block(
        &url,
        &page,
        crate::adblock::win_resource_type(context.0),
    ) {
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

#[cfg(test)]
mod tests {
    //! The one thing that can be checked about this module WITHOUT a Windows machine is
    //! whether the type table it feeds is keyed on the REAL WebView2 values.
    //!
    //! `adblock::win_resource_type` is written as a `match` on plain integers so it can
    //! live in a module every host compiles. That makes the integers load-bearing in a way
    //! a Linux test cannot see: if WebView2 ever renumbered `COREWEBVIEW2_WEB_RESOURCE_CONTEXT`,
    //! every request would be silently retyped and every `$script` / `$image` / `$stylesheet`
    //! rule would stop matching on Windows again — with nothing failing. These tests read the
    //! constants the `webview2-com` bindings actually declare, so that drift fails here.
    //!
    //! `mod adblock_win` is `#[cfg(target_os = "windows")]`, so this test RUNS only on the
    //! Windows CI leg (which exists); the `cargo check --target x86_64-pc-windows-gnu
    //! --all-targets` cross-check is what keeps it compiling everywhere else. That is the same
    //! trade `find_win.rs`'s `handler_query` test already makes.
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SIGNED_EXCHANGE,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET, COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET,
        COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST,
    };

    #[test]
    fn the_type_table_is_keyed_on_the_real_webview2_values() {
        let mapped = [
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT.0, "document"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET.0, "stylesheet"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE.0, "image"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA.0, "media"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT.0, "font"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT.0, "script"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST.0, "xhr"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH.0, "xhr"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET.0, "websocket"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST.0, "web_manifest"),
            (COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING.0, "ping"),
            (
                COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT.0,
                "csp_report",
            ),
        ];
        for (context, expected) in mapped {
            assert_eq!(
                crate::adblock::win_resource_type(context),
                expected,
                "WebView2 context {context} must reach the engine as a filter type \
                 EasyList's type options can actually match"
            );
        }
        for context in [
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_ALL.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_TEXT_TRACK.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_EVENT_SOURCE.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SIGNED_EXCHANGE.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_OTHER.0,
        ] {
            assert_eq!(
                crate::adblock::win_resource_type(context),
                "other",
                "no filter type option targets this context, so it is honestly 'other'"
            );
        }
    }

    /// The defect in one assertion: before the mapping existed every request was typed
    /// `"other"`, so a context a filter CAN target was indistinguishable from one it cannot.
    #[test]
    fn no_context_a_filter_can_target_is_typed_other() {
        for context in [
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_DOCUMENT.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_STYLESHEET.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_IMAGE.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MEDIA.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FONT.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_SCRIPT.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_XML_HTTP_REQUEST.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_FETCH.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_WEBSOCKET.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_MANIFEST.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_PING.0,
            COREWEBVIEW2_WEB_RESOURCE_CONTEXT_CSP_VIOLATION_REPORT.0,
        ] {
            assert_ne!(
                crate::adblock::win_resource_type(context),
                "other",
                "a request of this kind must not be flattened to 'other' — that is what made \
                 every type option in the filter lists inert on Windows"
            );
        }
    }
}
