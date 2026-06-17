// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewUrl};

/// Tabs that have committed at least one real (non-`about:blank`) top-frame page.
/// Used to auto-close pop-under shells: a background tab opened by `window.open` that
/// goes straight to a blocked ad domain (directly or via a redirector) never shows real
/// content, so when its ad navigation is cancelled we close the empty tab instead of
/// leaving it behind. A tab that DID load a real page is never auto-closed.
static TABS_WITH_CONTENT: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
fn tabs_with_content() -> &'static Mutex<HashSet<u32>> {
    TABS_WITH_CONTENT.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Mark tab `id` as having shown a real page (called on a non-blank top-frame load).
pub fn mark_tab_has_content(id: u32) {
    tabs_with_content().lock().unwrap().insert(id);
}

/// Forget a closed tab's content flag (ids are monotonic, so this is just tidiness).
pub fn forget_tab_content(id: u32) {
    tabs_with_content().lock().unwrap().remove(&id);
}

/// Whether a tab whose ad navigation was just cancelled should be auto-closed as a
/// pop-under shell. ONLY a non-active tab that has never shown a real page: the active
/// tab is never closed (the user is looking at it), and a tab that already loaded real
/// content is kept (the ad navigation is still blocked, just not fatal to the tab).
fn should_autoclose_popunder(tab_id: u32, active_id: u32, has_content: bool) -> bool {
    tab_id != active_id && !has_content
}

/// Webview label for a tab. Tab ids start at 1; the first tab is `content:1`.
pub fn content_label(id: u32) -> String {
    format!("content:{id}")
}
/// The active tab's webview label (from the registry).
pub fn active_content_label(app: &AppHandle) -> String {
    let id = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| s.reg.lock().unwrap().active_id())
        .unwrap_or(1);
    content_label(id)
}
/// The active tab's webview, if it exists.
pub fn active_webview(app: &AppHandle) -> Option<tauri::Webview> {
    app.get_webview(&active_content_label(app))
}

/// Default top inset = TOOLBAR_H(56) + FAVBAR_H(40) + TABSTRIP_H(36); refined by view.setContentInset.
pub const DEFAULT_INSET_TOP: f64 = 132.0;

/// Present a mainstream Chrome user-agent to browsed sites (anti-fingerprint /
/// fewer "unsupported browser" walls) instead of the default WebKitGTK string,
/// mirroring the Electron app. Platform-specific so the OS token is honest.
#[cfg(target_os = "macos")]
const CONTENT_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
#[cfg(target_os = "windows")]
const CONTENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
const CONTENT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

fn is_local_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// Emit a `nav.state` carrying the real tab id and page state.
pub(crate) fn emit_state(app: &AppHandle, id: u32, url: &str, title: &str, loading: bool) {
    if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
        eprintln!("[aegis-nav] emit_state id={id} loading={loading} url={url}");
    }
    let (back, fwd) = app.try_state::<crate::tabs::Tabs>()
        .map(|s| { let r = s.reg.lock().unwrap(); (r.can_go_back(id), r.can_go_forward(id)) })
        .unwrap_or((false, false));
    let _ = crate::emit_event(
        app,
        "nav.state",
        json!({
            "viewId": id,
            "url": url,
            "title": title,
            "canGoBack": back,
            "canGoForward": fwd,
            "isLoading": loading,
            "crashed": false
        }),
    );
}

/// Create a content webview for tab `id` loading `url` as a child of the main
/// window. The label is `content:<id>`. Initial bounds put it below the chrome;
/// `view::apply_inset` keeps it sized on inset/resize.
///
/// Desktop only: uses the `unstable` multi-webview API (`Window::add_child`).
/// Mobile (single-webview) is a no-op so the chrome still loads.
#[cfg(desktop)]
pub fn spawn_tab(app: &AppHandle, id: u32, url: Url) -> tauri::Result<()> {
    let window = app
        .get_window("main")
        .expect("main window must exist (declared in tauri.conf.json)");
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?.to_logical::<f64>(scale);
    let label = content_label(id);

    // Per-site WebRTC escape hatch: an allowlisted host (the ad-block allowlist doubles as
    // "trusted site") is exempt from the WebRTC shim + native backstops. Computed from the
    // spawn URL's host before `url` is moved into the builder. Residual: keyed on the spawn
    // host; an in-tab SPA navigation to a different host isn't re-evaluated until respawn.
    let host_allowlisted = url
        .host_str()
        .map(|h| crate::adblock::host_allowlisted(app, h))
        .unwrap_or(false);

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_dl = app.clone();
    let nav_id = id;
    let load_id = id;
    // `mut` is only needed on Windows (additional_browser_args below); harmless elsewhere.
    #[allow(unused_mut)]
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        .user_agent(CONTENT_UA)
        // Inject the WebRTC IP-leak shim + ad/tracker blocker at document start into the
        // page and all iframes. The shim hides the local IP per the user's webrtcPolicy;
        // the ad-block part supplements WebKit content filters on Linux and IS the ad-block
        // layer on Windows/macOS (where wry exposes no request interception).
        .initialization_script_for_all_frames(crate::adblock_inject::script(app, host_allowlisted))
        .on_navigation(move |u| {
            // Fires for EVERY navigation action — including cross-site subframe/iframe
            // loads. wry wires this to WebKitGTK's `decide-policy` (NavigationAction),
            // which does NOT filter to the main frame, so an embedded player/ad iframe
            // navigating would land here too. We must NOT update the address bar from
            // here, or it flickers to those embedded URLs while a page loads. The URL bar
            // is driven by `on_page_load` below — wired to `load-changed`, which is
            // main-frame only. We still run the safety + HTTPS-Only checks here so they
            // cover subframes too (a malware/insecure iframe should be caught as well).

            // Malicious-site guard: block known-malware hosts.
            if crate::safety::is_blocked(&app_nav, u) {
                crate::safety::raise(&app_nav, u.as_str());
                return false;
            }

            // Ad-block at the navigation level: cancel loads of blocked ad/tracker
            // destinations. `on_new_window` only sees a pop-under's INITIAL url, but these
            // networks open a clean redirector that bounces through an ad domain
            // (e.g. .../api/rtb-pops/go -> daleelerah.info -> the landing page), so the tab
            // opens before the ad domain is known. Catching it here stops the chain on any
            // frame and on every desktop (the WebKit content filters only cover
            // subresources, not top-frame loads). Honors the on/off toggle + allowlist
            // (should_block does); source = the page initiating the navigation.
            {
                let source = app_nav
                    .get_webview(&content_label(nav_id))
                    .and_then(|w| w.url().ok())
                    .map(|s| s.to_string())
                    .unwrap_or_default();
                if crate::adblock_engine::should_block(u.as_str(), &source, "document") {
                    if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
                        eprintln!("[aegis-nav] BLOCK ad navigation: {} (from {source})", u.as_str());
                    }
                    // Auto-close a pop-under shell: a NON-active tab that never showed real
                    // content and whose navigation is an ad is an opened-then-redirected-to-ad
                    // pop-under — close the empty tab rather than leave it. The active tab and
                    // any tab that already loaded a real page are never closed (just blocked).
                    let has_content = tabs_with_content().lock().unwrap().contains(&nav_id);
                    let active = app_nav
                        .try_state::<crate::tabs::Tabs>()
                        .map(|s| s.reg.lock().unwrap().active_id())
                        .unwrap_or(0);
                    if should_autoclose_popunder(nav_id, active, has_content) {
                        let app_close = app_nav.clone();
                        // Defer off the navigation callback to avoid re-entrancy.
                        let _ = app_nav.run_on_main_thread(move || {
                            crate::tabs::close_tab(&app_close, nav_id);
                        });
                    }
                    return false;
                }
            }

            // HTTPS-Only: upgrade http -> https (unless localhost, or the setting is
            // off — the escape hatch for http-only sites). Re-navigate on the main
            // thread AFTER this callback returns, to avoid re-entrancy.
            if u.scheme() == "http"
                && !is_local_host(u)
                && crate::settings::https_only(&app_nav)
            {
                let https = u.as_str().replacen("http://", "https://", 1);
                let app_main = app_nav.clone();
                let lbl = content_label(nav_id);
                let _ = app_nav.run_on_main_thread(move || {
                    if let (Some(w), Ok(p)) = (app_main.get_webview(&lbl), Url::parse(&https)) {
                        let _ = w.navigate(p);
                    }
                });
                return false; // cancel the http navigation; https replaces it
            }
            true
        })
        .on_page_load(move |_webview, payload| {
            let event = payload.event();
            let loading = matches!(event, tauri::webview::PageLoadEvent::Started);
            let u = payload.url();
            let u = u.as_str();
            emit_state(&app_load, load_id, u, "", loading);
            crate::tabs::on_tab_url(&app_load, load_id, u);
            // A real page committed → this tab isn't a blank pop-under shell, so the
            // ad-navigation auto-close (above) must never close it.
            if !u.starts_with("about:") {
                mark_tab_has_content(load_id);
            }
            // New top-frame navigation → reset this tab's per-page blocked count (badge).
            #[cfg(target_os = "linux")]
            if loading {
                crate::adblock::reset_page(&app_load, load_id);
            }
            // Hide THIS tab's content webview at the blank home so the chrome's Home
            // tab shows; show it for any real page as soon as it starts loading (so a
            // slow page doesn't leave the home showing). Per-label so each tab toggles
            // its OWN webview, not whichever happens to be active.
            #[cfg(target_os = "linux")]
            crate::linux_layout::set_content_visible_label(
                &app_load,
                &content_label(load_id),
                !u.starts_with("about:"),
            );
            if matches!(event, tauri::webview::PageLoadEvent::Finished) {
                crate::history::record(&app_load, u, "");
            }
        })
        .on_download(move |_webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    crate::downloads::on_requested(&app_dl, url.as_str(), destination);
                }
                tauri::webview::DownloadEvent::Finished { success, .. } => {
                    crate::downloads::on_finished(&app_dl, success);
                }
                _ => {}
            }
            true
        })
        .on_new_window({
            let app_nw = app.clone();
            let opener_id = id;
            move |url, _features| {
                let u = url.to_string();
                // Drop ad pop-unders instead of opening them as background tabs:
                // blank/script-scheme shells (window.open('about:blank') the opener
                // scripts — Aegis can't share the handle, so it'd leave an empty tab)
                // and ad/tracker destinations (honoring the toggle + allowlist). A
                // legit target=_blank link to a real http(s) page still opens.
                let opener = app_nw
                    .get_webview(&content_label(opener_id))
                    .and_then(|w| w.url().ok())
                    .map(|u| u.to_string())
                    .unwrap_or_default();
                if crate::adblock_engine::is_unwanted_popup(&u, &opener) {
                    return tauri::webview::NewWindowResponse::Deny;
                }
                let app_main = app_nw.clone();
                let _ = app_nw.run_on_main_thread(move || {
                    crate::tabs::open_background(&app_main, &u);
                });
                tauri::webview::NewWindowResponse::Deny
            }
        });

    // Windows: WebRTC native backstop via Chromium's IP-handling policy. CRITICAL:
    // additional_browser_args REPLACES wry's ENTIRE default arg string, so we must
    // re-include BOTH defaults wry sets — the --disable-features list AND
    // --autoplay-policy=no-user-gesture-required (wry appends it because autoplay defaults
    // to true; dropping it would break HTML5 video/audio autoplay). disable → block all
    // non-proxied UDP (worker-tight); public-only → only the public interface (hides the
    // LAN IP). Only override the args when we actually add a WebRTC flag, so the
    // no-protection / allowlisted path keeps wry's untouched defaults. Read at webview
    // creation only → a mid-session change applies to new tabs; the shim covers open tabs.
    // (Runs before add_child, which consumes `builder`.)
    #[cfg(target_os = "windows")]
    {
        let webrtc_arg = if host_allowlisted {
            None
        } else {
            match crate::settings::webrtc_policy(app).as_str() {
                "disable" => Some(" --force-webrtc-ip-handling-policy=disable_non_proxied_udp"),
                "public-only" => Some(" --force-webrtc-ip-handling-policy=default_public_interface_only"),
                _ => None,
            }
        };
        if let Some(arg) = webrtc_arg {
            let mut args = String::from(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
            );
            args.push_str(arg);
            builder = builder.additional_browser_args(&args);
        }
    }

    // Windows (fractional DPI): create the child webview with PHYSICAL bounds so the
    // WebView2 controller's input/hit-test region matches its render region. With Logical
    // bounds at e.g. 125% the controller's hit region ends up far above the host window,
    // so the content webview swallows clicks meant for the chrome's toolbar/favourites.
    #[cfg(target_os = "windows")]
    window.add_child(
        builder,
        tauri::PhysicalPosition::new(0.0, (DEFAULT_INSET_TOP * scale).round()),
        tauri::PhysicalSize::new(
            (size.width * scale).round(),
            ((size.height - DEFAULT_INSET_TOP).max(0.0) * scale).round(),
        ),
    )?;
    #[cfg(not(target_os = "windows"))]
    window.add_child(
        builder,
        tauri::LogicalPosition::new(0.0, DEFAULT_INSET_TOP),
        tauri::LogicalSize::new(size.width, (size.height - DEFAULT_INSET_TOP).max(0.0)),
    )?;

    // Linux: install this tab's own WebKit signal hooks (title→history + element
    // picker sentinel, Esc-exits-fullscreen, and the site-permission handler). Done
    // per-tab so tabs 2+ also record titles, exit fullscreen, and prompt for
    // permissions — not just the first tab.
    #[cfg(target_os = "linux")]
    {
        crate::linux_layout::mark_content_label(app, &label);
        crate::linux_layout::connect_title_label(app, &label);
        // Track the main-frame URL for the address bar (incl. SPA pushState/hash that
        // on_page_load's load-changed misses; main-frame only, so no subframe flicker).
        crate::linux_layout::connect_url_tracker(app, &label);
        crate::linux_layout::connect_fullscreen_exit_label(app, &label);
        crate::linux_layout::connect_tab_keys_label(app, &label);
        crate::permissions::install_handler_label(app, &label);
        // Ad-block: WebKit content filters live per-webview, so this new tab needs
        // its own copy (install_adblock only filtered tabs that existed at boot).
        crate::adblock_webkit::apply_to_new_tab(app, &label);
        // Count blocked subresources on this tab for the shield badge.
        crate::linux_layout::connect_block_counter(app, &label);
        // WebRTC native backstop: WebKitGTK's set_enable_webrtc is all-or-nothing, so it
        // only enforces "disable" (worker-tight); public-only/default rely on the injected
        // shim. Skipped for allowlisted ("trusted") hosts.
        if !host_allowlisted {
            crate::linux_layout::apply_webrtc_policy_label(
                app,
                &label,
                &crate::settings::webrtc_policy(app),
            );
        }
    }

    // Windows: wry only intercepts custom-protocol requests, so install our own
    // WebView2 WebResourceRequested handler on the content webview for full network
    // ad-blocking (complements the injected cosmetic/JS tier). Also install the
    // SourceChanged URL tracker so the address bar follows same-document (History-API)
    // navigations — the WebView2 analog of Linux's notify::uri.
    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let app_url = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::adblock_win::install(&pw);
            crate::nav_url_win::install(&pw, app_url, id);
        });
    }

    // macOS: observe the WKWebView's `URL` (KVO) so the address bar follows
    // same-document (History-API/hash) navigations that wry's nav callbacks miss —
    // the WKWebView analog of Linux's notify::uri.
    #[cfg(target_os = "macos")]
    if let Some(content) = app.get_webview(&label) {
        let app_url = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::nav_url_mac::install(&pw, app_url, id);
        });
    }

    Ok(())
}

/// Mobile placeholder: no separate content webview yet (single-webview platform).
#[cfg(mobile)]
pub fn spawn_tab(_app: &AppHandle, _id: u32, _url: Url) -> tauri::Result<()> {
    Ok(())
}

/// Handle `nav.*` channels. Returns `None` if `channel` is not a nav channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let id = payload.get("viewId").and_then(Value::as_u64).map(|n| n as u32);
    let label = match id {
        Some(i) => content_label(i),
        None => active_content_label(app),
    };
    let content = app.get_webview(&label);
    let res: Result<Value, String> = match channel {
        "nav.navigate" => {
            let url_s = payload.get("url").and_then(|v| v.as_str()).unwrap_or("");
            match Url::parse(url_s) {
                Ok(u) => match content {
                    Some(w) => w.navigate(u).map(|_| Value::Null).map_err(|e| e.to_string()),
                    None => Ok(Value::Null),
                },
                Err(e) => Err(format!("invalid url '{url_s}': {e}")),
            }
        }
        "nav.back" => {
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>().map(|s| s.reg.lock().unwrap().active_id()).unwrap_or(1)
            });
            let url = app.try_state::<crate::tabs::Tabs>().and_then(|s| s.reg.lock().unwrap().go_back(target_id));
            if let (Some(url), Some(w)) = (url, content) {
                if let Ok(u) = Url::parse(&url) { let _ = w.navigate(u); }
            }
            Ok(Value::Null)
        }
        "nav.forward" => {
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>().map(|s| s.reg.lock().unwrap().active_id()).unwrap_or(1)
            });
            let url = app.try_state::<crate::tabs::Tabs>().and_then(|s| s.reg.lock().unwrap().go_forward(target_id));
            if let (Some(url), Some(w)) = (url, content) {
                if let Ok(u) = Url::parse(&url) { let _ = w.navigate(u); }
            }
            Ok(Value::Null)
        }
        "nav.reloadOrStop" => {
            if let Some(w) = content {
                let _ = w.reload();
            }
            Ok(Value::Null)
        }
        "nav.home" => {
            if let Some(w) = content {
                let _ = w.navigate(crate::settings::home_url(app));
            }
            Ok(Value::Null)
        }
        "nav.getState" => {
            let url = content
                .as_ref()
                .and_then(|w| w.url().ok())
                .map(|u| u.to_string())
                .unwrap_or_else(|| "about:blank".to_string());
            let vid = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>()
                    .map(|s| s.reg.lock().unwrap().active_id())
                    .unwrap_or(1)
            });
            let (back, fwd) = app.try_state::<crate::tabs::Tabs>()
                .map(|s| { let r = s.reg.lock().unwrap(); (r.can_go_back(vid), r.can_go_forward(vid)) })
                .unwrap_or((false, false));
            Ok(json!({
                "viewId": vid, "url": url, "title": "",
                "canGoBack": back, "canGoForward": fwd, "isLoading": false, "crashed": false
            }))
        }
        _ => return None,
    };
    Some(res)
}

#[cfg(test)]
mod tests {
    use super::{forget_tab_content, mark_tab_has_content, should_autoclose_popunder, tabs_with_content};

    #[test]
    fn autoclose_only_nonactive_blank_tabs() {
        // A background (non-active) tab that never showed content → close the shell.
        assert!(should_autoclose_popunder(7, 3, false));
        // The ACTIVE tab is never auto-closed, even with no content — it's the user's tab.
        assert!(!should_autoclose_popunder(3, 3, false));
        // A tab that already loaded a real page is kept (the ad nav is still blocked).
        assert!(!should_autoclose_popunder(7, 3, true));
    }

    #[test]
    fn content_flag_round_trips() {
        let id = 99_001; // unlikely to collide with other tests sharing the global
        assert!(!tabs_with_content().lock().unwrap().contains(&id));
        mark_tab_has_content(id);
        assert!(tabs_with_content().lock().unwrap().contains(&id));
        forget_tab_content(id);
        assert!(!tabs_with_content().lock().unwrap().contains(&id));
    }
}
