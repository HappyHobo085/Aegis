// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewUrl};

pub const CONTENT_LABEL: &str = "content";
/// Default top inset = TOOLBAR_H(56) + FAVBAR_H(40); refined by `view.setContentInset`.
pub const DEFAULT_INSET_TOP: f64 = 96.0;

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

/// Emit a `nav.state` for the chrome address bar. canGoBack/Forward are
/// best-effort in Phase 0 (no Tauri history API); refined in Phase 2.
fn emit_state(app: &AppHandle, url: &str, loading: bool) {
    let _ = crate::emit_event(app, 
        "nav.state",
        json!({
            "viewId": 1,
            "url": url,
            "title": "",
            "canGoBack": false,
            "canGoForward": false,
            "isLoading": loading,
            "crashed": false
        }),
    );
}

/// Create the content webview as a child of the main window. Initial bounds put
/// it below the chrome; `view::apply_inset` keeps it sized on inset/resize.
///
/// Desktop only: uses the `unstable` multi-webview API (`Window::add_child`), a
/// desktop feature. Mobile (single-webview) gets its own content surface in a
/// later phase; for now this is a no-op there so the chrome still loads.
#[cfg(desktop)]
pub fn spawn_content(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_window("main")
        .expect("main window must exist (declared in tauri.conf.json)");
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?.to_logical::<f64>(scale);

    let app_nav = app.clone();
    let app_load = app.clone();
    let app_dl = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(
        CONTENT_LABEL,
        WebviewUrl::External(crate::settings::home_url(app)),
    )
        .user_agent(CONTENT_UA)
        // Inject the ad/tracker blocker at document start into the page and all iframes.
        // On Linux this supplements the WebKit content filters; on Windows/macOS (where
        // wry exposes no request interception) it IS the ad-block layer.
        .initialization_script_for_all_frames(crate::adblock_inject::script())
        .on_navigation(move |url| {
            // Fires for every navigation (programmatic, link clicks, redirects).
            emit_state(&app_nav, url.as_str(), true);

            // Malicious-site guard: block known-malware hosts.
            if crate::safety::is_blocked(&app_nav, url) {
                crate::safety::raise(&app_nav, url.as_str());
                return false;
            }

            // HTTPS-Only: upgrade http -> https (unless localhost, or the setting is
            // off — the escape hatch for http-only sites). Re-navigate on the main
            // thread AFTER this callback returns, to avoid re-entrancy.
            if url.scheme() == "http"
                && !is_local_host(url)
                && crate::settings::https_only(&app_nav)
            {
                let https = url.as_str().replacen("http://", "https://", 1);
                let app_main = app_nav.clone();
                let _ = app_nav.run_on_main_thread(move || {
                    if let (Some(w), Ok(u)) = (app_main.get_webview(CONTENT_LABEL), Url::parse(&https))
                    {
                        let _ = w.navigate(u);
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
            emit_state(&app_load, u, loading);
            // Hide the content webview at the blank home so the chrome's Home tab
            // shows; show it for any real page as soon as it starts loading (so a
            // slow page doesn't leave the home showing).
            #[cfg(target_os = "linux")]
            crate::linux_layout::set_content_visible(&app_load, !u.starts_with("about:"));
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
        });

    window.add_child(
        builder,
        tauri::LogicalPosition::new(0.0, DEFAULT_INSET_TOP),
        tauri::LogicalSize::new(size.width, (size.height - DEFAULT_INSET_TOP).max(0.0)),
    )?;

    // Windows: wry only intercepts custom-protocol requests, so install our own
    // WebView2 WebResourceRequested handler on the content webview for full network
    // ad-blocking (complements the injected cosmetic/JS tier).
    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(CONTENT_LABEL) {
        let _ = content.with_webview(|pw| crate::adblock_win::install(&pw));
    }

    Ok(())
}

/// Mobile placeholder: no separate content webview yet (single-webview platform).
#[cfg(mobile)]
pub fn spawn_content(_app: &AppHandle) -> tauri::Result<()> {
    Ok(())
}

/// Handle `nav.*` channels. Returns `None` if `channel` is not a nav channel.
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let content = app.get_webview(CONTENT_LABEL);
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
            if let Some(w) = content {
                let _ = w.eval("history.back()");
            }
            Ok(Value::Null)
        }
        "nav.forward" => {
            if let Some(w) = content {
                let _ = w.eval("history.forward()");
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
            Ok(json!({
                "viewId": 1, "url": url, "title": "",
                "canGoBack": false, "canGoForward": false, "isLoading": false, "crashed": false
            }))
        }
        _ => return None,
    };
    Some(res)
}
