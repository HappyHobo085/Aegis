// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url, WebviewUrl};

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

/// Parse the tab id out of a `content:{id}` label (defaults to 1).
fn label_id(label: &str) -> u32 {
    label
        .strip_prefix("content:")
        .and_then(|s| s.parse().ok())
        .unwrap_or(1)
}

/// Navigate a tab's content webview, FIRST registering the target as an
/// app-initiated navigation so the redirect guard never blocks it. Every
/// programmatic content navigation must go through here.
#[cfg(desktop)]
#[allow(dead_code)]
pub fn navigate_tab(app: &AppHandle, id: u32, url: Url) {
    crate::redirect_guard::expect(app, id, url.as_str());
    if let Some(w) = app.get_webview(&content_label(id)) {
        let _ = w.navigate(url);
    }
}
/// The active tab's webview label (from the registry).
pub fn active_content_label<R: Runtime>(app: &AppHandle<R>) -> String {
    let id = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| s.reg.lock().unwrap().active_id())
        .unwrap_or(1);
    content_label(id)
}
/// The active tab's webview, if it exists.
pub fn active_webview<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Webview<R>> {
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
    let (back, fwd) = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| {
            let r = s.reg.lock().unwrap();
            (r.can_go_back(id), r.can_go_forward(id))
        })
        .unwrap_or((false, false));
    crate::emit_event(
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

/// The navigation-policy decision shared by every desktop platform: returns `true` to
/// ALLOW the navigation, `false` to CANCEL it. Runs the overlay-cancel, malware, ad-block
/// (document-level + pop-under autoclose), and HTTPS-Only checks. Fires for subframes too
/// (the caller doesn't filter frames) — intentional, so a malware/insecure iframe is caught.
/// Non-Linux: wired via Tauri's `on_navigation`. Linux: called from our own `decide-policy`
/// handler (which also adds the gesture/frame-aware redirect guard), because wry otherwise
/// claims the `decide-policy` signal and our handler never runs.
#[cfg(desktop)]
pub(crate) fn decide_navigation(app: &AppHandle, nav_id: u32, u: &Url) -> bool {
    // While a full-window chrome overlay (Settings/Downloads/shield/…) covers the page, the
    // user isn't driving it — so any navigation the content initiates is a script/ad redirect
    // (malvertising fires top-frame redirects on the resize/blur that opening an overlay
    // causes). Cancel them. NOT gated on the sidebar alone: the page stays interactive beside
    // the sidebar panel, so real navigation must still work there.
    if let Some(st) = app.try_state::<crate::view::ContentInset>() {
        let lay = *st.0.lock().unwrap();
        if lay.overlay && !lay.sidebar {
            return false;
        }
    }

    // Malicious-site guard: block known-malware hosts.
    if crate::safety::is_blocked(app, u) {
        crate::safety::raise(app, u.as_str());
        return false;
    }

    // Ad-block at the navigation level: cancel loads of blocked ad/tracker destinations
    // (pop-under redirector chains the WebKit content filter can't catch — those only cover
    // subresources, not top-frame loads). Honors the on/off toggle + allowlist.
    {
        let source = app
            .get_webview(&content_label(nav_id))
            .and_then(|w| w.url().ok())
            .map(|s| s.to_string())
            .unwrap_or_default();
        if crate::adblock_engine::should_block(u.as_str(), &source, "document") {
            if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
                eprintln!(
                    "[aegis-nav] BLOCK ad navigation: {} (from {source})",
                    u.as_str()
                );
            }
            // Auto-close a pop-under shell: a NON-active tab that never showed real content
            // whose navigation is an ad. The active tab + any tab that loaded a real page are
            // never closed (just blocked).
            let has_content = tabs_with_content().lock().unwrap().contains(&nav_id);
            let active = app
                .try_state::<crate::tabs::Tabs>()
                .map(|s| s.reg.lock().unwrap().active_id())
                .unwrap_or(0);
            if should_autoclose_popunder(nav_id, active, has_content) {
                let app_close = app.clone();
                let _ = app.run_on_main_thread(move || {
                    crate::tabs::close_tab(&app_close, nav_id);
                });
            }
            return false;
        }
    }

    // HTTPS-Only: upgrade http -> https (unless localhost, or the setting is off). Re-navigate
    // on the main thread AFTER this returns, to avoid re-entrancy.
    if u.scheme() == "http" && !is_local_host(u) && crate::settings::https_only(app) {
        let https = u.as_str().replacen("http://", "https://", 1);
        let app_main = app.clone();
        let lbl = content_label(nav_id);
        let _ = app.run_on_main_thread(move || {
            if let Ok(p) = Url::parse(&https) {
                crate::redirect_guard::expect(&app_main, nav_id, p.as_str());
                if let Some(w) = app_main.get_webview(&lbl) {
                    let _ = w.navigate(p);
                }
            }
        });
        return false; // cancel the http navigation; https replaces it
    }
    true
}

/// Create a content webview for tab `id` loading `url` as a child of the main
/// window. The label is `content:<id>`. Initial bounds put it below the chrome;
/// `view::apply_inset` keeps it sized on inset/resize.
///
/// `private` marks the tab as incognito — the webview uses an ephemeral data
/// partition (`.incognito(true)`) so cookies, localStorage, IndexedDB, and cache
/// live only in memory and vanish when the webview closes. Platform mapping
/// (Tauri 2.11.2 / wry 0.55.1):
///   Linux   WebKitGTK  → WebContext::new_ephemeral() (in-memory WebsiteDataManager)
///   macOS   WKWebView  → WKWebsiteDataStore::nonPersistentDataStore
///   Windows WebView2   → SetIsInPrivateModeEnabled(true) (WebView2 ≥101.0.1210.39)
///   Android: UNSUPPORTED by wry — handled natively in MainActivity (best-effort flush).
///
/// Desktop only: uses the `unstable` multi-webview API (`Window::add_child`).
/// Mobile (single-webview) is a no-op so the chrome still loads.
#[cfg(desktop)]
pub fn spawn_tab(app: &AppHandle, id: u32, url: Url, private: bool) -> tauri::Result<()> {
    let window = app
        .get_window("main")
        .expect("main window must exist (declared in tauri.conf.json)");
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?.to_logical::<f64>(scale);
    let label = content_label(id);
    // The initial page load reaches the policy hook as a gesture-less navigation;
    // register it so the redirect guard exempts it (it's an app-initiated load).
    crate::redirect_guard::expect(app, id, url.as_str());

    // Per-site WebRTC escape hatch: an allowlisted host (the ad-block allowlist doubles as
    // "trusted site") is exempt from the WebRTC shim + native backstops. Computed from the
    // spawn URL's host before `url` is moved into the builder. Residual: keyed on the spawn
    // host; an in-tab SPA navigation to a different host isn't re-evaluated until respawn.
    //
    // `host` is also threaded into `adblock_inject::script` for the SEPARATE farble
    // fp-allowlist check (farble::host_allowlisted). The two allowlists are independent:
    // ad-block allowlist = "trust this site's ads"; fp-allowlist = "don't farble this site".
    let host = url.host_str().unwrap_or("").to_string();
    let host_allowlisted = if host.is_empty() {
        false
    } else {
        crate::adblock::host_allowlisted(app, &host)
    };

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_dl = app.clone();
    let nav_id = id;
    let load_id = id;
    let dl_id = id;
    // `mut` is only needed on Windows (additional_browser_args below); harmless elsewhere.
    #[allow(unused_mut)]
    let mut builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        .user_agent(CONTENT_UA)
        // PRIVATE TAB: ephemeral data partition — cookies/localStorage/IndexedDB/cache
        // live only in memory and vanish when the webview closes. Verified API:
        // `WebviewBuilder::incognito(bool)` at tauri-2.11.2/src/webview/mod.rs:997.
        .incognito(private)
        // Inject the WebRTC IP-leak shim + ad/tracker blocker + farbling shim at document
        // start into the page and all iframes. The WebRTC shim hides the local IP per the
        // user's webrtcPolicy; the ad-block part supplements WebKit content filters on Linux
        // and IS the ad-block layer on Windows/macOS; the farble shim perturbs canvas/audio/
        // WebGL fingerprinting surfaces per the antiFingerprint setting. All three are
        // evaluated at spawn time: toggling settings applies to new/reloaded tabs only.
        .initialization_script_for_all_frames(crate::adblock_inject::script(
            app,
            host_allowlisted,
            &host,
        ))
        // The policy logic lives in `decide_navigation` so every platform shares it. On Linux
        // this Tauri hook is disconnected at spawn (wry claims `decide-policy` and would block
        // our own gesture/frame-aware handler) and `linux_layout::install_nav_policy` runs the
        // same `decide_navigation` from our own handler; this hook still drives Windows/macOS.
        .on_navigation(move |u| decide_navigation(&app_nav, nav_id, u))
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
            // Desktop-wide: Linux counts via resource-load-started, Windows via the WebView2
            // interceptor (adblock_win); macOS emits 0 (no native per-block callback there).
            #[cfg(desktop)]
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
                // PRIVATE: look up the tab's privateness — is_private returns false for
                // unknown ids, so a normal tab always records. Private tabs skip history.
                crate::history::record(
                    &app_load,
                    u,
                    "",
                    crate::tabs::is_private(&app_load, load_id),
                );
            }
        })
        .on_download(move |_webview, event| {
            match event {
                tauri::webview::DownloadEvent::Requested { url, destination } => {
                    // PRIVATE: still save the file the user asked for, but record NO row.
                    crate::downloads::on_requested(
                        &app_dl,
                        url.as_str(),
                        destination,
                        crate::tabs::is_private(&app_dl, dl_id),
                    );
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
                // PRIVATE: a tab opened FROM a private tab inherits privateness.
                let inherit_private = crate::tabs::is_private(&app_nw, opener_id);
                let app_main = app_nw.clone();
                let _ = app_nw.run_on_main_thread(move || {
                    crate::tabs::open_background(&app_main, &u, inherit_private);
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
                "public-only" => {
                    Some(" --force-webrtc-ip-handling-policy=default_public_interface_only")
                }
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
        // Wire the WebKitFindController found-text / failed-to-find-text signals so
        // find.start/next/prev push live match counts to the chrome's FindBar.
        crate::find_linux::install(app, &label);
        // Own the decide-policy signal: disconnect wry's handler and run our own (the shared
        // nav policy + the gesture/frame-aware redirect guard). MUST run after the webview is
        // built (wry connects its handler during build); with_webview here satisfies that.
        crate::linux_layout::install_nav_policy(app, &label);
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
        let app_ab = app.clone();
        let app_url = app.clone();
        let app_rg = app.clone();
        let app_find = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::adblock_win::install(&pw, app_ab, id);
            crate::nav_url_win::install(&pw, app_url, id);
            crate::nav_policy_win::install(&pw, app_rg, id);
            crate::find_win::install(&pw, app_find, id);
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

    // Replay any session zoom the core holds for this tab (e.g. after a discard→reload),
    // so the user's zoom survives the webview being rebuilt. No-op at 1.0.
    crate::zoom::apply_to_tab(app, id);

    // Apply the active proxy config to this new tab so it inherits the proxy from birth.
    // Linux: routes through WebKitGTK WebsiteDataManager (live, per-webview).
    // Other platforms: Tasks 4-5 fill in their bodies; no-op for now.
    crate::proxy::apply_to_tab(app, id);

    Ok(())
}

/// Mobile placeholder: no separate content webview yet (single-webview platform).
#[cfg(mobile)]
pub fn spawn_tab(_app: &AppHandle, _id: u32, _url: Url, _private: bool) -> tauri::Result<()> {
    Ok(())
}

/// Handle `nav.*` channels. Returns `None` if `channel` is not a nav channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let id = payload
        .get("viewId")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
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
                    Some(w) => {
                        crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                        w.navigate(u)
                            .map(|_| Value::Null)
                            .map_err(|e| e.to_string())
                    }
                    None => Ok(Value::Null),
                },
                Err(e) => Err(format!("invalid url '{url_s}': {e}")),
            }
        }
        "nav.back" => {
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>()
                    .map(|s| s.reg.lock().unwrap().active_id())
                    .unwrap_or(1)
            });
            let url = app
                .try_state::<crate::tabs::Tabs>()
                .and_then(|s| s.reg.lock().unwrap().go_back(target_id));
            if let (Some(url), Some(w)) = (url, content) {
                if let Ok(u) = Url::parse(&url) {
                    crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                    let _ = w.navigate(u);
                }
            }
            Ok(Value::Null)
        }
        "nav.forward" => {
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>()
                    .map(|s| s.reg.lock().unwrap().active_id())
                    .unwrap_or(1)
            });
            let url = app
                .try_state::<crate::tabs::Tabs>()
                .and_then(|s| s.reg.lock().unwrap().go_forward(target_id));
            if let (Some(url), Some(w)) = (url, content) {
                if let Ok(u) = Url::parse(&url) {
                    crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                    let _ = w.navigate(u);
                }
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
                let home = crate::settings::home_url(app);
                crate::redirect_guard::expect(app, label_id(&label), home.as_str());
                let _ = w.navigate(home);
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
            let (back, fwd) = app
                .try_state::<crate::tabs::Tabs>()
                .map(|s| {
                    let r = s.reg.lock().unwrap();
                    (r.can_go_back(vid), r.can_go_forward(vid))
                })
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
    use super::{
        forget_tab_content, mark_tab_has_content, should_autoclose_popunder, tabs_with_content,
    };

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
