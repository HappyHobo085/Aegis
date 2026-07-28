//! Windows redirect guard: cancels scripted cross-origin top-frame redirects via
//! WebView2's NavigationStarting event (top-frame only by definition). Policy is
//! shared via `redirect_guard`. Install inside `content.with_webview(|pw| ...)`.
//!
//! Compile-verified (`cargo check --target x86_64-pc-windows-gnu` + CI msvc); the
//! runtime behavior needs a Windows desktop to confirm.
use tauri::AppHandle;
use webview2_com::Microsoft::Web::WebView2::Win32::{
    ICoreWebView2, ICoreWebView2NavigationStartingEventArgs,
};
use webview2_com::NavigationStartingEventHandler;

/// Install a `NavigationStarting` handler on the content webview that cancels
/// scripted cross-origin top-frame redirects. Call inside
/// `content.with_webview(|pw| nav_policy_win::install(&pw, app, id))`. Fails silently
/// (and fails OPEN) if the WebView2 isn't ready — browsing is unaffected.
pub fn install(pw: &tauri::webview::PlatformWebview, app: AppHandle, id: u32) {
    let controller = pw.controller();
    // SAFETY: COM objects are single-threaded apartment; this runs inside a
    // `with_webview` closure on the UI thread.
    unsafe {
        let Ok(core) = controller.CoreWebView2() else {
            return;
        };
        let handler = NavigationStartingEventHandler::create(Box::new(move |core, args| {
            if let (Some(core), Some(args)) = (core, args) {
                // Fail open: never break navigation if our check errors.
                let _ = handle(&app, id, &core, &args);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_NavigationStarting(&handler, &mut token);
    }
}

/// # Safety
/// `core` and `args` must be valid COM pointers; caller must be on the UI thread.
unsafe fn handle(
    app: &AppHandle,
    id: u32,
    core: &ICoreWebView2,
    args: &ICoreWebView2NavigationStartingEventArgs,
) -> windows::core::Result<()> {
    let target = {
        let mut p = windows::core::PWSTR::null();
        args.Uri(&mut p)?;
        p.to_string().unwrap_or_default()
    };
    let current = {
        let mut p = windows::core::PWSTR::null();
        core.Source(&mut p)?;
        p.to_string().unwrap_or_default()
    };
    let mut user = windows::core::BOOL::default();
    args.IsUserInitiated(&mut user)?;
    let mut redirected = windows::core::BOOL::default();
    args.IsRedirected(&mut redirected)?;
    let scripted = !user.as_bool();
    // NavigationStarting fires for top-frame navigations only (main_frame is always
    // true), and once per redirect hop. Judge the hop by its chain's ORIGIN — begin a
    // chain on a fresh nav, continue it on a redirect — so a scripted cross-origin
    // redirect (e.g. google.com → www.google.com) is blocked even though the final hop
    // looks like "just a redirect", while user/app-initiated redirect chains pass.
    if let Some(from) = crate::redirect_guard::block_at_start(
        app,
        id,
        &current,
        &target,
        scripted,
        redirected.as_bool(),
    ) {
        args.SetCancel(true)?;
        crate::redirect_guard::on_blocked_redirect_to_new_tab(app, id, &from, &target);
    }
    Ok(())
}
