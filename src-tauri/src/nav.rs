// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewUrl};

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
fn emit_state(app: &AppHandle, id: u32, url: &str, title: &str, loading: bool) {
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

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_dl = app.clone();
    let nav_id = id;
    let load_id = id;
    let builder = tauri::webview::WebviewBuilder::new(&label, WebviewUrl::External(url))
        .user_agent(CONTENT_UA)
        // Inject the ad/tracker blocker at document start into the page and all iframes.
        // On Linux this supplements the WebKit content filters; on Windows/macOS (where
        // wry exposes no request interception) it IS the ad-block layer.
        .initialization_script_for_all_frames(crate::adblock_inject::script())
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
        crate::linux_layout::connect_fullscreen_exit_label(app, &label);
        crate::linux_layout::connect_tab_keys_label(app, &label);
        crate::permissions::install_handler_label(app, &label);
        // Ad-block: WebKit content filters live per-webview, so this new tab needs
        // its own copy (install_adblock only filtered tabs that existed at boot).
        crate::adblock_webkit::apply_to_new_tab(app, &label);
        // Count blocked subresources on this tab for the shield badge.
        crate::linux_layout::connect_block_counter(app, &label);
    }

    // Windows: wry only intercepts custom-protocol requests, so install our own
    // WebView2 WebResourceRequested handler on the content webview for full network
    // ad-blocking (complements the injected cosmetic/JS tier).
    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let _ = content.with_webview(|pw| crate::adblock_win::install(&pw));
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
