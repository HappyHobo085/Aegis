// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager, Url, WebviewUrl};

pub const CONTENT_LABEL: &str = "content";
/// Default top inset = TOOLBAR_H(56) + FAVBAR_H(40); refined by `view.setContentInset`.
pub const DEFAULT_INSET_TOP: f64 = 96.0;

fn blank() -> Url {
    Url::parse("about:blank").expect("about:blank is a valid URL")
}

/// Emit a `nav.state` for the chrome address bar. canGoBack/Forward are
/// best-effort in Phase 0 (no Tauri history API); refined in Phase 2.
fn emit_state(app: &AppHandle, url: &str, loading: bool) {
    let _ = app.emit(
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
pub fn spawn_content(app: &AppHandle) -> tauri::Result<()> {
    let window = app
        .get_window("main")
        .expect("main window must exist (declared in tauri.conf.json)");
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.inner_size()?.to_logical::<f64>(scale);

    let app_nav = app.clone();
    let app_load = app.clone();
    let builder = tauri::webview::WebviewBuilder::new(CONTENT_LABEL, WebviewUrl::External(blank()))
        .on_navigation(move |url| {
            // Fires for every navigation (programmatic, link clicks, redirects).
            // The HTTPS-Only / malware gate lands in Phase 3; Phase 0 allows all.
            emit_state(&app_nav, url.as_str(), true);
            true
        })
        .on_page_load(move |_webview, payload| {
            let loading = matches!(payload.event(), tauri::webview::PageLoadEvent::Started);
            emit_state(&app_load, payload.url().as_str(), loading);
        });

    window.add_child(
        builder,
        tauri::LogicalPosition::new(0.0, DEFAULT_INSET_TOP),
        tauri::LogicalSize::new(size.width, (size.height - DEFAULT_INSET_TOP).max(0.0)),
    )?;
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
                let _ = w.navigate(blank());
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
