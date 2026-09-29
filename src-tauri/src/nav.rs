// Content-webview navigation (Phase 0 Task 6). A second webview is added as a
// child of the "main" window, positioned below the chrome by `view.rs`. nav.*
// channels drive it; navigation events are pushed to the chrome as `nav.state`.
use std::collections::HashSet;
use std::sync::{Mutex, OnceLock};

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime, Url, Webview};
// `WebviewUrl` has exactly one user, `spawn_tab`, which is `#[cfg(desktop)]`. Android
// builds a single webview in Kotlin instead, so importing it there is an unused import.
#[cfg(desktop)]
use tauri::WebviewUrl;

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
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn mark_tab_has_content(id: u32) {
    tabs_with_content()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .insert(id);
}

/// Forget a closed tab's content flag (ids are monotonic, so this is just tidiness).
///
/// NOT tidiness, though: the flag's only consumer is the pop-under auto-close in
/// [`decide_navigation`], which refuses to close a tab that has real content. A
/// flag left set on a closed id therefore suppresses a security behaviour for
/// whatever tab is later given that id. Both writers of the flag — the
/// programmatic [`crate::tabs::close_tab`] and the `tabs.close` IPC arm — must
/// clear it.
pub fn forget_tab_content(id: u32) {
    tabs_with_content()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
}

/// Test-only reader for the content flag, so the forget paths can be asserted
/// rather than assumed. `#[cfg(test)]` because production has no reader: the
/// pop-under check reads the whole set at its single call site.
#[cfg(test)]
pub fn tab_has_content(id: u32) -> bool {
    tabs_with_content()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&id)
}

/// Tabs with a load in flight, so `nav.reloadOrStop` can honour the Stop half of its
/// contract. `on_page_load` is the ONLY place that knows this — the engine reports the
/// load edges and the core forwards them to the renderer, but nothing kept the state,
/// so the core could not answer "is this tab loading?" when the button was pressed.
static TABS_LOADING: OnceLock<Mutex<HashSet<u32>>> = OnceLock::new();
fn tabs_loading() -> &'static Mutex<HashSet<u32>> {
    TABS_LOADING.get_or_init(|| Mutex::new(HashSet::new()))
}

/// Record a load edge for tab `id`: `true` when the load started, `false` when it settled.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn note_tab_loading(id: u32, loading: bool) {
    let mut set = tabs_loading().lock().unwrap_or_else(|e| e.into_inner());
    if loading {
        set.insert(id);
    } else {
        set.remove(&id);
    }
}

/// Whether tab `id` has a load in flight.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn tab_is_loading(id: u32) -> bool {
    tabs_loading()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .contains(&id)
}

/// Forget a closed tab's loading flag (ids are monotonic, so this is just tidiness).
pub fn forget_tab_loading(id: u32) {
    tabs_loading()
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .remove(&id);
}

/// The blank page a new tab starts on, and the target the Stop button uses to abandon a
/// load (see [`reload_or_stop`]).
const ABOUT_BLANK: &str = "about:blank";

/// What the Reload/Stop button should do for a tab in the given state.
#[derive(Debug, PartialEq, Eq)]
pub(crate) enum ReloadOrStop {
    Reload,
    Stop,
}

/// The decision behind the Reload/Stop button, as a pure function so the branch is
/// testable: Stop while a load is in flight, Reload once it has settled.
pub(crate) fn reload_or_stop_action(is_loading: bool) -> ReloadOrStop {
    if is_loading {
        ReloadOrStop::Stop
    } else {
        ReloadOrStop::Reload
    }
}

/// The Reload/Stop button's core action.
///
/// Stop is implemented as a navigation to [`ABOUT_BLANK`], NOT a platform stop call:
/// wry 0.55.1 exposes no `stop()` and no `is_loading()` (nor do tauri 2.11.3 or
/// tauri-runtime-wry 2.11.3 — `stop_loading` appears nowhere in any of the three), and
/// `ICoreWebView2Find::Stop` is the WebView2 *find* API, not a page stop. Navigating
/// away is what all three engines treat as abandoning an in-flight load, and
/// `about:blank` is already this app's blank-page target. The cost is that the tab
/// ends up blank rather than frozen mid-load, which is what a user who pressed Stop on
/// a slow page asked for anyway; a real stop would need a wry upgrade to be exact.
pub(crate) fn reload_or_stop<R: Runtime>(
    app: &AppHandle<R>,
    nav_id: u32,
    webview: Option<&Webview<R>>,
) {
    let action = reload_or_stop_action(tab_is_loading(nav_id));
    match action {
        ReloadOrStop::Reload => {
            if let Some(w) = webview {
                let _ = w.reload();
            }
        }
        ReloadOrStop::Stop => {
            // The STATE half comes first and is deliberately independent of the webview:
            // the load is over by definition once we navigate away, so the flag is
            // cleared here rather than waiting for a `Finished` edge that will never
            // arrive, and the guard is told about the navigation. Doing this after (or
            // inside) a webview call would leave a tab stuck "loading" forever whenever
            // the handle is missing or `navigate` errors.
            forget_tab_loading(nav_id);
            crate::redirect_guard::expect(app, nav_id, ABOUT_BLANK);
            if let Some(w) = webview {
                let _ = w.navigate(Url::parse(ABOUT_BLANK).expect("about:blank always parses"));
            }
        }
    }
}

/// Whether a tab whose ad navigation was just cancelled should be auto-closed as a
/// pop-under shell. ONLY a non-active tab that has never shown a real page: the active
/// tab is never closed (the user is looking at it), and a tab that already loaded real
/// content is kept (the ad navigation is still blocked, just not fatal to the tab).
#[cfg_attr(target_os = "android", allow(dead_code))]
fn should_autoclose_popunder(tab_id: u32, active_id: u32, has_content: bool) -> bool {
    tab_id != active_id && !has_content
}

/// Whether a URL is a scheme the content webview may be asked to load.
///
/// This mirrors two helpers that already exist and are NOT a substitute for it:
/// the renderer's `isAllowedNavigationUrl` (`src/lib/schemes.ts`) and the Android
/// `isLoadableUrl` (`MainActivity.kt`). The renderer's guard sits *inside* the trust
/// boundary Tauri assumes is trusted — it is a UI affordance, not a policy. Anything
/// that reaches a URL without going through the chrome (a synced setting, an imported
/// bundle, a `tabs.json` written before this check existed, or a page's own
/// `window.open`) bypasses it entirely, so the core needs its own copy.
///
/// http/https are the two browsable schemes. `about:blank` is allowed because that is
/// what a new tab starts on and what the ad-block/pop-under shell logic keys off.
/// Everything else is refused:
///
/// * `file:` — makes the content webview read a local file. This is the one that
///   mattered: `tabs.recordNav` persists the URL, so a single `file:` nav became a
///   local-file read on *every subsequent launch*, not just the current one.
/// * `javascript:` — script injection into a webview that can reach the IPC chokepoint.
/// * `data:`/`blob:`/custom schemes — a page-controlled origin we have no policy for.
pub fn is_navigable(u: &Url) -> bool {
    match u.scheme() {
        "http" | "https" => true,
        // `about:blank` and nothing else. Matched on the path (not `as_str()`) so a
        // benign fragment like `about:blank#x` still passes while `about:config` does not.
        "about" => u.path() == "blank",
        _ => false,
    }
}

/// [`is_navigable`] as a fallible check, naming the refused scheme so the renderer (and
/// the user, via its error toast) can see *why* a navigation was rejected.
pub fn require_navigable(u: &Url) -> Result<(), String> {
    if is_navigable(u) {
        Ok(())
    } else {
        Err(format!(
            "refusing to navigate content webview to scheme {:?} ({}) — only http, https and about:blank are allowed",
            u.scheme(),
            u.as_str()
        ))
    }
}

/// Parse `raw` and require it to be navigable, in one step. Returns the parse error or
/// the scheme error so callers can just `?` it.
pub fn parse_navigable(raw: &str) -> Result<Url, String> {
    let u = Url::parse(raw).map_err(|e| format!("invalid url '{raw}': {e}"))?;
    require_navigable(&u)?;
    Ok(u)
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
        .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
        .unwrap_or(1);
    content_label(id)
}
/// The active tab's webview, if it exists.
#[cfg_attr(target_os = "android", allow(dead_code))] // Android is a single webview built in Kotlin; only the desktop paths ask for this.
pub fn active_webview<R: Runtime>(app: &AppHandle<R>) -> Option<tauri::Webview<R>> {
    app.get_webview(&active_content_label(app))
}

/// Default top inset = WORKSPACE_BAR_H(32) + TABSTRIP_H(40) + TOOLBAR_H(56) + FAVBAR_H(36);
/// Refined by view.setContentInset (renderer reports actual DOM measurement).
pub const DEFAULT_INSET_TOP: f64 = 164.0;

/// Present a mainstream Chrome user-agent to browsed sites (anti-fingerprint /
/// fewer "unsupported browser" walls) instead of the default WebKitGTK string,
/// mirroring the Electron app. Platform-specific so the OS token is honest.
#[cfg(target_os = "macos")]
const CONTENT_UA: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
#[cfg(target_os = "windows")]
const CONTENT_UA: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";
#[cfg(not(any(target_os = "macos", target_os = "windows")))]
#[cfg_attr(target_os = "android", allow(dead_code))]
const CONTENT_UA: &str = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36";

#[cfg_attr(target_os = "android", allow(dead_code))]
fn is_local_host(url: &Url) -> bool {
    matches!(
        url.host_str(),
        Some("localhost") | Some("127.0.0.1") | Some("::1")
    )
}

/// Emit a `nav.state` carrying the real tab id and page state.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) fn emit_state(app: &AppHandle, id: u32, url: &str, title: &str, loading: bool) {
    if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
        eprintln!("[aegis-nav] emit_state id={id} loading={loading} url={url}");
    }
    let (back, fwd) = app
        .try_state::<crate::tabs::Tabs>()
        .map(|s| {
            let r = s.reg.lock().unwrap_or_else(|e| e.into_inner());
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

/// Emit a `nav.failed` event when a page load fails (network error, certificate
/// error, DNS failure, etc.). The `kind` discriminates load errors (`"load"`) from
/// certificate errors (`"cert"`).
#[allow(dead_code)] // Windows/macOS/Android still need their own signal wiring (see below).
pub(crate) fn emit_nav_failed(
    app: &AppHandle,
    id: u32,
    error_code: i32,
    error_description: &str,
    validated_url: &str,
    kind: &str,
) {
    crate::emit_event(
        app,
        "nav.failed",
        json!({
            "viewId": id,
            "errorCode": error_code,
            "errorDescription": error_description,
            "validatedURL": validated_url,
            "kind": kind,
        }),
    );
}

/// Emit a `nav.crashed` event when the webview/renderer process crashes.
/// Wired on Linux by `linux_layout::connect_nav_failure_label`.
#[allow(dead_code)] // Windows/macOS/Android still need their own signal wiring (see below).
pub(crate) fn emit_nav_crashed(app: &AppHandle, id: u32, reason: &str) {
    crate::emit_event(
        app,
        "nav.crashed",
        json!({
            "viewId": id,
            "reason": reason,
        }),
    );
}

// TODO(M12): Wire platform-specific load-failure and crash signals to the helpers above.
//
// **Linux (WebKitGTK): DONE** — `linux_layout::connect_nav_failure_label` is called from
// `spawn_tab` right after `install_nav_policy`. It gates `load-failed` on main-frame load state
// (tracked via `load-changed`, which is main-frame only) so a failing subresource cannot
// replace the page with an error view, and adds `load-failed-with-tls-errors` to emit
// `kind: "cert"`.
//
// **Windows (WebView2):** After `crate::adblock_win::install(...)` in `spawn_tab`, use
// `content.with_webview(move |pw| { ... })` to access the `ICoreWebView2` COM interface and
// subscribe to `NavigationFailed` (→ `emit_nav_failed`) and `ProcessFailed`
// (→ `emit_nav_crashed`).
//
// **macOS (WKWebView):** Use `WKNavigationDelegate`'s `didFailProvisionalNavigation:withError:`
// (→ `emit_nav_failed`) and `webProcessDidCrash` KVO observation (→ `emit_nav_crashed`).
//
// **Android:** Kotlin's `WebViewClient.onReceivedError` (→ `__aegisNavFailed`) and
// `WebViewClient.onRenderProcessGone` (→ `__aegisNavCrashed`) — mirror the existing
// `__aegisNavState` bridge pattern.

/// The navigation-policy decision shared by every desktop platform: returns `true` to
/// ALLOW the navigation, `false` to CANCEL it. Runs the overlay-cancel, malware, ad-block
/// (document-level + pop-under autoclose), and HTTPS-Only checks. Fires for subframes too
/// (the caller doesn't filter frames) — intentional, so a malware/insecure iframe is caught.
/// Non-Linux: wired via Tauri's `on_navigation`. Linux: called from our own `decide-policy`
/// handler (which also adds the gesture/frame-aware redirect guard), because wry otherwise
/// claims the `decide-policy` signal and our handler never runs.
#[cfg(desktop)]
pub(crate) fn decide_navigation(app: &AppHandle, nav_id: u32, u: &Url) -> bool {
    // Scheme gate, FIRST, before anything that reasons about the destination.
    // `is_navigable` is the app's single definition of a browsable scheme
    // (http/https + about:blank) and it is already consulted by `tabs.create`,
    // `tabs.recordNav`, `open_redirect_background` and `nav.home` — but NOT
    // here, which is the gate every PAGE-initiated navigation passes through.
    // Without it, `location = 'file:///…'` or `javascript:…` from a page was not
    // refused by the navigation policy at all: the overlay, malware, ad-block
    // and https-only checks all read the destination as an ordinary web address
    // and then `return true`. That is what made the per-page-load writer
    // (`tabs::on_tab_url`) able to persist a `file:` url into `tabs.json`.
    if !is_navigable(u) {
        if std::env::var_os("AEGIS_NAV_DEBUG").is_some() {
            eprintln!("[aegis-nav] REFUSE scheme {}: {}", u.scheme(), u.as_str());
        }
        return false;
    }

    // While a full-window chrome overlay (Settings/Downloads/shield/…) covers the page, the
    // user isn't driving it — so any navigation the content initiates is a script/ad redirect
    // (malvertising fires top-frame redirects on the resize/blur that opening an overlay
    // causes). Cancel them. NOT gated on the sidebar alone: the page stays interactive beside
    // the sidebar panel, so real navigation must still work there.
    if let Some(st) = app.try_state::<crate::view::ContentInset>() {
        let lay = *st.0.lock().unwrap_or_else(|e| e.into_inner());
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
            let has_content = tabs_with_content()
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .contains(&nav_id);
            let active = app
                .try_state::<crate::tabs::Tabs>()
                .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
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
    // A missing window is reachable (a late IPC or a sweep closure racing teardown), and a panic
    // here would take down the app rather than fail one request — so return the error instead.
    // Every other `get_window("main")` in this crate already uses this let-else shape.
    let Some(window) = app.get_window("main") else {
        return Err(tauri::Error::WindowNotFound);
    };
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
            note_tab_loading(load_id, loading);
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
                tauri::webview::DownloadEvent::Finished { success, url, .. } => {
                    crate::downloads::on_finished(&app_dl, success, Some(url.as_str()));
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
                // PAGE-CONTROLLED URL. The popup target comes from the page, not from
                // the user or the chrome, so `window.open('file:///…')` reached
                // `open_background` unfiltered and spawned a tab that loaded it. Deny
                // the same way as an ad popup — the response is Deny either way, since
                // Aegis opens the tab itself rather than letting the webview do it.
                if !is_navigable(&url) {
                    log::warn!(
                        "[aegis] blocked window.open to non-navigable scheme {:?}",
                        url.scheme()
                    );
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

    // Windows: WebRTC native backstop + proxy via Chromium browser args. CRITICAL:
    // additional_browser_args REPLACES wry's ENTIRE default arg string, so we must
    // re-include BOTH defaults wry sets — the --disable-features list AND
    // --autoplay-policy=no-user-gesture-required (wry appends it because autoplay defaults
    // to true; dropping it would break HTML5 video/audio autoplay). We build ONE combined
    // arg string that may include a WebRTC flag AND/OR proxy switches; the arg is only set
    // when at least one override is needed, so the no-override path keeps wry's untouched
    // defaults. Read at webview creation only → a mid-session toggle applies to new/reloaded
    // tabs only (SPAWN-TIME LIMITATION: browser args are immutable after WebView2 creation;
    // existing open tabs keep their spawn-time proxy; see apply_to_tab / proxy::apply which
    // emit state but cannot retarget live WebView2 instances on Windows). Task 9 docs should
    // note this: "On Windows, change the proxy setting and reload the tab to apply it."
    // (Runs before add_child, which consumes `builder`.)
    //
    // CRITICAL (regression fix): WebView2 refuses to create a webview whose
    // AdditionalBrowserArguments differ from ANOTHER webview that shares the same
    // user-data-folder — `CreateCoreWebView2EnvironmentWithOptions` fails and the content
    // webview comes up with NO engine (a blank page, no panic). The chrome window uses
    // wry's DEFAULT args; a content webview that appends the WebRTC/proxy flag therefore
    // clashes with it on the shared default folder, so EVERY page was blank by default
    // (webrtcPolicy defaults to "public-only", so the override is on out of the box). Fix:
    // house each content webview in its OWN user-data-folder, KEYED on its exact arg string,
    // so (a) it never clashes with the chrome and (b) only content tabs with identical args
    // share a folder — they share cookies/logins; a different WebRTC policy, proxy, or
    // per-site allowlist status gets its own profile. Applies to private tabs too: incognito
    // keeps their session ephemeral, but they must still avoid the chrome's folder.
    #[cfg(target_os = "windows")]
    {
        let webrtc_exempt = crate::webrtc_exempt::host_exempt(app, &host);
        let webrtc_arg = if webrtc_exempt {
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

        // Proxy: read the active config from managed state (seeded at boot from settings.json).
        // When active, append --proxy-server=<uri> and optionally --proxy-bypass-list=<hosts>.
        // The URI form is "<scheme>://<host>:<port>" — Chromium accepts the full URI for both
        // http (e.g. "http://proxy.corp:3128") and socks5 (e.g. "socks5://127.0.0.1:1080"),
        // which is the same form that proxy::ProxyConfig::default_uri() returns and that the
        // Linux WebKitGTK tier uses. The bypass list uses WebView2's ";"-separated format
        // (--proxy-bypass-list=localhost;127.0.0.1;*.internal), matching Chromium's convention.
        let proxy_cfg = crate::proxy::current(app);
        let proxy_uri = proxy_cfg.default_uri(); // None when mode=off or config is invalid

        let overridden = webrtc_arg.is_some() || proxy_uri.is_some();
        let browser_args = if overridden {
            let mut args = String::from(
                "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --autoplay-policy=no-user-gesture-required",
            );
            if let Some(arg) = webrtc_arg {
                args.push_str(arg);
            }
            if let Some(uri) = proxy_uri {
                args.push_str(&format!(" --proxy-server={uri}"));
                if !proxy_cfg.bypass_hosts.is_empty() {
                    args.push_str(&format!(
                        " --proxy-bypass-list={}",
                        proxy_cfg.bypass_hosts.join(";")
                    ));
                }
            }
            Some(args)
        } else {
            None
        };

        // Per-args content profile (see the CRITICAL note above). The key is a stable hash
        // of the exact args (DefaultHasher uses fixed SipHash keys → deterministic across
        // runs), or "default" when no override is set. Content tabs are siblings of the
        // chrome's "EBWebView" folder under the app's local-data dir.
        if let Ok(base) = app.path().app_local_data_dir() {
            let key = match &browser_args {
                Some(a) => {
                    use std::hash::{Hash, Hasher};
                    let mut h = std::collections::hash_map::DefaultHasher::new();
                    a.hash(&mut h);
                    format!("{:016x}", h.finish())
                }
                None => "default".to_string(),
            };
            builder = builder.data_directory(base.join(format!("EBWebView-content-{key}")));
        }

        if let Some(args) = &browser_args {
            builder = builder.additional_browser_args(args);
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
        // Surface main-frame load failures / web-process crashes as `nav.failed` /
        // `nav.crashed` so the chrome can draw its own error + retry UI.
        crate::linux_layout::connect_nav_failure_label(app, &label);
        // WebRTC native backstop: WebKitGTK's set_enable_webrtc is all-or-nothing, so it
        // only enforces "disable" (worker-tight); public-only/default rely on the injected
        // shim. Skipped for hosts on the LOCAL-ONLY WebRTC exemption list — NOT the
        // ad-block allowlist, which is synced and must not be able to switch this off.
        if !crate::webrtc_exempt::host_exempt(app, &host) {
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
    // the WKWebView analog of Linux's notify::uri.  Also install the find-in-page
    // JS shim so Ctrl+F works with real match count + highlights (replacing the
    // degraded native findString: that only returns a bool).
    #[cfg(target_os = "macos")]
    if let Some(content) = app.get_webview(&label) {
        let app_url = app.clone();
        let app_find = app.clone();
        let _ = content.with_webview(move |pw| {
            crate::nav_url_mac::install(&pw, app_url, id);
            crate::find_mac::install(&pw, app_find, id);
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
///
/// PLACE 2 of the three-place rule: these names also live in `shared/types.ts`
/// (`IPC.nav*`) and in `src/lib/ipcClient.ts`.
///
/// Generic over `R: Runtime` purely so the dispatcher is drivable from a
/// `MockRuntime` test — the renderer's `useNav` depends on the shape of the
/// `nav.getState` answer, on `nav.back`/`nav.forward` really walking the tab's
/// history, and on `nav.navigate` refusing a forbidden scheme *before* a webview is
/// needed, and none of that was observable while this took a concrete
/// `&AppHandle`. Every callee it uses was already generic except
/// `settings::home_url`, which was widened with it. The only production caller is
/// `lib.rs`'s `ipc()` arm, which infers `R = Wry` unchanged.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
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
            match parse_navigable(url_s) {
                Ok(u) => match content {
                    Some(w) => {
                        crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                        w.navigate(u)
                            .map(|_| Value::Null)
                            .map_err(|e| e.to_string())
                    }
                    None => Ok(Value::Null),
                },
                Err(e) => Err(e),
            }
        }
        "nav.back" => {
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>()
                    .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
                    .unwrap_or(1)
            });
            let url = app.try_state::<crate::tabs::Tabs>().and_then(|s| {
                s.reg
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .go_back(target_id)
            });
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
                    .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
                    .unwrap_or(1)
            });
            let url = app.try_state::<crate::tabs::Tabs>().and_then(|s| {
                s.reg
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .go_forward(target_id)
            });
            if let (Some(url), Some(w)) = (url, content) {
                if let Ok(u) = Url::parse(&url) {
                    crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                    let _ = w.navigate(u);
                }
            }
            Ok(Value::Null)
        }
        "nav.reloadOrStop" => {
            // Same resolution as nav.back/nav.forward: the explicit viewId, else the
            // active tab (the button acts on whatever the user is looking at).
            let target_id = id.unwrap_or_else(|| {
                app.try_state::<crate::tabs::Tabs>()
                    .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
                    .unwrap_or(1)
            });
            reload_or_stop(app, target_id, content.as_ref());
            Ok(Value::Null)
        }
        "nav.home" => {
            if let Some(w) = content {
                let home = crate::settings::home_url(app);
                // `home_url()` is validated on every write path now (settings.set,
                // apply_synced, apply_imported), but a settings.json written before
                // that allowlist existed can still hold a `file:` target, and this is
                // the code that would load it on every launch. Check at the point of use.
                let u = home;
                if let Err(e) = require_navigable(&u) {
                    return Some(Err(e));
                }
                crate::redirect_guard::expect(app, label_id(&label), u.as_str());
                let _ = w.navigate(u);
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
                    .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
                    .unwrap_or(1)
            });
            let (back, fwd) = app
                .try_state::<crate::tabs::Tabs>()
                .map(|s| {
                    let r = s.reg.lock().unwrap_or_else(|e| e.into_inner());
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
        dispatch, forget_tab_content, forget_tab_loading, is_navigable, mark_tab_has_content,
        note_tab_loading, parse_navigable, reload_or_stop, reload_or_stop_action,
        require_navigable, should_autoclose_popunder, tab_is_loading, tabs_with_content,
        ReloadOrStop,
    };
    use crate::test_support::with_tmp_app;
    use serde_json::{json, Value};
    use std::collections::HashMap;
    use tauri::{AppHandle, Manager, Runtime, Url};

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
        assert!(!tabs_with_content()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id));
        mark_tab_has_content(id);
        assert!(tabs_with_content()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id));
        forget_tab_content(id);
        assert!(!tabs_with_content()
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .contains(&id));
    }

    // ── scheme allowlist ───────────────────────────────────────────────────
    //
    // These pin the predicate the six call sites depend on. The call sites themselves
    // (`tabs::dispatch`) take a concrete wry `&AppHandle` and so cannot be driven from
    // a MockRuntime test — that is a pre-existing limitation of those signatures, not
    // of this check, and it is why the predicate is pure and tested here.

    #[test]
    fn http_and_https_are_navigable() {
        for raw in [
            "http://example.com/",
            "https://example.com/",
            "https://example.com:8443/a?b=c#d",
            // The url crate lowercases the scheme, so mixed case needs no special case.
            "HTTPS://EXAMPLE.COM/",
            "HtTp://example.com/",
        ] {
            let u = Url::parse(raw).expect(raw);
            assert!(is_navigable(&u), "{raw} should be navigable");
        }
    }

    #[test]
    fn about_blank_is_navigable_but_other_about_pages_are_not() {
        // A new tab starts here and the pop-under shell logic keys off it.
        assert!(is_navigable(&Url::parse("about:blank").unwrap()));
        // A benign fragment must not break a legitimate blank tab.
        assert!(is_navigable(&Url::parse("about:blank#x").unwrap()));
        // about:config & friends are privileged pages we have no policy for.
        for raw in ["about:config", "about:blankx", "about:"] {
            let Ok(u) = Url::parse(raw) else { continue };
            assert!(!is_navigable(&u), "{raw} must not be navigable");
        }
    }

    #[test]
    fn dangerous_and_unknown_schemes_are_refused() {
        for raw in [
            "file:///etc/passwd",
            "file:///home/u/.ssh/id_rsa",
            "javascript:alert(1)",
            "JavaScript:alert(1)", // scheme is case-insensitive; must still be refused
            "data:text/html,<script>alert(1)</script>",
            "blob:https://example.com/abc",
            "ftp://example.com/",
            "chrome://settings",
            "intent://scan/#Intent;scheme=zxing;end",
            "aegis-internal://thing",
        ] {
            let u = Url::parse(raw).expect(raw);
            assert!(!is_navigable(&u), "{raw} must NOT be navigable");
        }
    }

    #[test]
    fn require_navigable_names_the_scheme_it_refused() {
        let u = Url::parse("file:///etc/passwd").unwrap();
        let err = require_navigable(&u).expect_err("file: must be refused");
        // The message has to name the scheme, or the renderer's error toast is useless.
        assert!(err.contains("file"), "error should name the scheme: {err}");
        assert!(require_navigable(&Url::parse("https://ok.test/").unwrap()).is_ok());
    }

    #[test]
    fn parse_navigable_reports_a_parse_error_before_a_scheme_error() {
        // Not a URL at all → the parse error, not a confusing "empty scheme" refusal.
        let e = parse_navigable("not a url").expect_err("garbage must be refused");
        assert!(e.contains("invalid url"), "got: {e}");
        // Parses fine but the wrong scheme → the scheme refusal.
        let e = parse_navigable("file:///etc/passwd").expect_err("file: must be refused");
        assert!(e.contains("file"), "got: {e}");
        // The happy path returns the parsed Url for the caller to navigate to.
        assert_eq!(
            parse_navigable("https://example.com/x").unwrap().as_str(),
            "https://example.com/x"
        );
    }

    /// The Stop branch of the Reload/Stop button, driven through the real `reload_or_stop`.
    ///
    /// The observable is `redirect_guard::PendingNavs`, which the Stop branch arms via
    /// `expect` — state work that needs no webview, so the branch is observable on the
    /// mock (which has none). `reload_or_stop_action` is the pure decision, asserted
    /// inline so the helper and the pure fn cannot drift apart.
    ///
    /// HONEST LIMIT: this pins that the Stop branch is TAKEN and that the tab's loading
    /// state is settled. The `navigate(about:blank)` call itself is not observable from
    /// Linux — there is no webview on the mock runtime — so it is compile-verified only.
    #[test]
    fn a_settled_tab_reloads_and_a_loading_tab_is_stopped() {
        // The pure decision, both ways: this is the branch the whole fix rests on.
        assert_eq!(reload_or_stop_action(true), ReloadOrStop::Stop);
        assert_eq!(reload_or_stop_action(false), ReloadOrStop::Reload);

        let id = 4_240_001u32; // unlikely to collide with other tests sharing the global
        with_tmp_app(|app| {
            // A SETTLED tab: no load in flight, so the button reloads and arms nothing.
            note_tab_loading(id, true);
            note_tab_loading(id, false);
            assert!(!tab_is_loading(id), "the load edge must have been recorded");
            reload_or_stop(app, id, None);
            let pending = app.state::<crate::redirect_guard::PendingNavs>();
            let armed: HashMap<u32, String> =
                pending.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
            assert!(
                armed.is_empty(),
                "a settled tab reloads in place and must arm no navigation, got {armed:?}"
            );

            // A LOADING tab: the button abandons the load, which is a navigation to the
            // blank page, so it DOES arm one — and that is what a test without a webview
            // can see. Passing `None` for the webview proves the arming happens before the
            // webview is needed, so the branch is not skipped for want of one.
            note_tab_loading(id, true);
            reload_or_stop(app, id, None);
            let armed: HashMap<u32, String> =
                pending.0.lock().unwrap_or_else(|e| e.into_inner()).clone();
            assert_eq!(
                armed.get(&id).map(String::as_str),
                Some("about:blank"),
                "a loading tab must be stopped by abandoning the load for the blank page"
            );
            // …and the flag is cleared here rather than waiting for a `Finished` edge
            // that will never arrive, so the next press reloads instead of re-stopping.
            assert!(
                !tab_is_loading(id),
                "Stop must settle the tab's loading flag, or the next press stops again"
            );
            forget_tab_loading(id);
        });
    }

    // ── nav.* dispatch (PLACE 2 of the three-place rule) ─────────────────
    //
    // What is worth pinning here is what the CHROME depends on and what the SCHEME
    // POLICY depends on, neither of which was reachable while `dispatch` took a
    // concrete `&AppHandle`: that an unowned channel falls THROUGH (a `Some(..)` here
    // would swallow the channel in `ipc()` and no later arm would run), that
    // `nav.navigate` refuses a forbidden scheme, that the `nav.getState` answer is
    // complete and per-tab, and that the back/forward channels really walk the tab's
    // history rather than only the webview's.
    //
    // HONEST LIMIT: the mock runtime has no webview, so `app.get_webview(..)` is
    // `None` for every label. That is what makes the scheme refusal observable at all
    // (it must be decided BEFORE the webview lookup) and it also means the arms that
    // need one are exercised only through their side effects on state. So the
    // `navigate` calls themselves — and `nav.home`'s point-of-use
    // `require_navigable` check, which sits INSIDE `if let Some(w) = content` and is
    // therefore unreachable here — are compile-verified only.

    /// One `nav.*` call, with the routing already asserted by the caller.
    fn nav_call<R: Runtime>(
        app: &AppHandle<R>,
        channel: &str,
        payload: Value,
    ) -> Result<Value, String> {
        match dispatch(app, channel, &payload) {
            Some(r) => r,
            None => panic!("{channel} must be handled by nav::dispatch"),
        }
    }

    /// The one-shot expected-navigation table as a plain map. `nav.reloadOrStop`'s
    /// Stop branch arms it, and arming is state work that needs no webview — which is
    /// why it is the observable for that channel.
    fn armed_navs<R: Runtime>(app: &AppHandle<R>) -> HashMap<u32, String> {
        app.state::<crate::redirect_guard::PendingNavs>()
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    /// Record two navigations on a tab, so it has somewhere to go back to.
    fn give_history<R: Runtime>(app: &AppHandle<R>, id: u32) {
        let tabs = app.state::<crate::tabs::Tabs>();
        let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
        reg.record_nav(id, "https://first.test/");
        reg.record_nav(id, "https://second.test/");
        assert!(
            reg.can_go_back(id),
            "fixture must have somewhere to go back to"
        );
    }

    #[test]
    fn nav_dispatch_declines_every_channel_it_does_not_own() {
        with_tmp_app(|app| {
            for channel in [
                "nav",          // the prefix, not a channel
                "nav.goBack",   // camelCase is a DIFFERENT channel (the real one is `nav.back`)
                "nav.getstate", // channel names are exact, not case-folded
                "nav.state",    // an EVENT name, and `emit_event` translates `.`→`:` for it
                "tabs.list",
                "settings.get",
                "view.getState",
            ] {
                assert!(
                    dispatch(app, channel, &json!({})).is_none(),
                    "{channel:?} is not a nav request channel and must fall through, not be answered"
                );
            }
        });
    }

    #[test]
    fn nav_navigate_refuses_every_scheme_the_policy_forbids() {
        with_tmp_app(|app| {
            for (raw, must_name) in [
                ("file:///etc/passwd", "file"),
                ("javascript:alert(1)", "javascript"),
                ("data:text/html,<b>x</b>", "data"),
                ("blob:https://example.com/abc", "blob"),
                ("ftp://example.com/", "ftp"),
                ("chrome://settings", "chrome"),
            ] {
                let err = nav_call(app, "nav.navigate", json!({ "url": raw }))
                    .expect_err("a forbidden scheme must be refused by the channel itself");
                assert!(
                    err.contains(must_name),
                    "the refusal must name the scheme the renderer's toast shows: got {err}"
                );
            }
            // Not a URL at all → the parse error, not a confusing "empty scheme" refusal.
            let err = nav_call(app, "nav.navigate", json!({ "url": "not a url" }))
                .expect_err("garbage must be refused");
            assert!(err.contains("invalid url"), "got: {err}");
            // A missing `url` is a refusal too, never a silent success.
            assert!(
                nav_call(app, "nav.navigate", json!({})).is_err(),
                "a nav.navigate with no url must not report success"
            );
            // …and the schemes the policy DOES allow go through.
            for raw in [
                "https://example.com/x",
                "http://example.com/",
                "about:blank",
            ] {
                nav_call(app, "nav.navigate", json!({ "url": raw }))
                    .unwrap_or_else(|e| panic!("{raw} must be navigable, got: {e}"));
            }
        });
    }

    #[test]
    fn nav_get_state_answers_a_complete_state_for_the_tab_it_was_asked_about() {
        with_tmp_app(|app| {
            let tabs = app.state::<crate::tabs::Tabs>();
            let active = tabs
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active_id();
            give_history(app, active);
            let other = active.wrapping_add(9_001); // a tab id that does not exist

            // No `viewId` → the ACTIVE tab, which is what the toolbar reads on mount.
            let s = nav_call(app, "nav.getState", json!({})).expect("getState must answer");
            assert_eq!(s["viewId"].as_u64(), Some(active as u64));
            assert_eq!(s["canGoBack"], json!(true), "the active tab has history");
            assert_eq!(s["canGoForward"], json!(false), "…and is at the end of it");
            // `useNav` reads all of these; a missing or wrongly-typed one is a crash or a
            // blank address bar in the chrome, and nothing else covers this answer's shape.
            for k in [
                "url",
                "title",
                "canGoBack",
                "canGoForward",
                "isLoading",
                "crashed",
            ] {
                assert!(s.get(k).is_some(), "nav.getState must report {k}: {s}");
            }
            // No webview on the mock, so `url` takes its documented fallback rather than
            // reporting nothing the chrome would have to null-check.
            assert_eq!(s["url"].as_str(), Some("about:blank"), "got {s}");

            // An EXPLICIT `viewId` is answered for THAT tab: the flags are per-tab, and a
            // tab with no history of its own must not inherit the active tab's.
            let s = nav_call(app, "nav.getState", json!({ "viewId": other }))
                .expect("getState must answer for any tab");
            assert_eq!(s["viewId"].as_u64(), Some(other as u64));
            assert_eq!(
                s["canGoBack"],
                json!(false),
                "a tab with no history cannot go back"
            );
            assert_eq!(s["canGoForward"], json!(false));
            // The active tab's own state is untouched by asking about another one.
            let s = nav_call(app, "nav.getState", json!({ "viewId": active })).expect("answered");
            assert_eq!(s["canGoBack"], json!(true));
        });
    }

    #[test]
    fn nav_back_and_forward_walk_the_tabs_history() {
        with_tmp_app(|app| {
            let tabs = app.state::<crate::tabs::Tabs>();
            let id = tabs
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active_id();
            give_history(app, id);

            // Back once: the forward stack opens up, which is what enables the button.
            nav_call(app, "nav.back", json!({})).expect("nav.back must answer");
            let s = nav_call(app, "nav.getState", json!({})).expect("answered");
            assert_eq!(
                s["canGoBack"],
                json!(true),
                "one step back is still not the start"
            );
            assert_eq!(
                s["canGoForward"],
                json!(true),
                "going back must open the forward stack"
            );

            // Back to the very start, then one more: the ends are no-ops, not errors and
            // not an underflow. (The webview's own history is what stops the navigation on
            // a real platform; the registry is the chrome's source of truth for the
            // button states, so it must settle, not run away.)
            nav_call(app, "nav.back", json!({})).expect("nav.back must answer");
            nav_call(app, "nav.back", json!({})).expect("an exhausted back must still answer");
            let s = nav_call(app, "nav.getState", json!({})).expect("answered");
            assert_eq!(
                s["canGoBack"],
                json!(false),
                "back must stop at the first entry"
            );
            assert_eq!(s["canGoForward"], json!(true));

            // Forward again, and past the end: still a no-op.
            nav_call(app, "nav.forward", json!({})).expect("nav.forward must answer");
            nav_call(app, "nav.forward", json!({})).expect("an exhausted forward must answer");
            nav_call(app, "nav.forward", json!({})).expect("an exhausted forward must answer");
            let s = nav_call(app, "nav.getState", json!({})).expect("answered");
            assert_eq!(
                s["canGoForward"],
                json!(false),
                "forward must stop at the last entry"
            );
            assert_eq!(
                s["canGoBack"],
                json!(true),
                "and going forward must keep the way back"
            );

            // A STALE `viewId` — a tab that no longer exists, which is exactly what the
            // chrome sends if the tab closed between the state it read and the click —
            // must NOT fall back to the active tab. Falling back would navigate the tab
            // the user is looking at, out from under them, on a click aimed at nothing.
            nav_call(app, "nav.back", json!({ "viewId": id.wrapping_add(9_002) }))
                .expect("answered");
            let s = nav_call(app, "nav.getState", json!({})).expect("answered");
            assert_eq!(
                (s["canGoBack"].clone(), s["canGoForward"].clone()),
                (json!(true), json!(false)),
                "a stale viewId must leave the active tab's history alone, got {s}"
            );
        });
    }

    #[test]
    fn nav_reload_or_stop_acts_on_the_tab_it_was_asked_about() {
        with_tmp_app(|app| {
            let tabs = app.state::<crate::tabs::Tabs>();
            let active = tabs
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .active_id();
            let other = active.wrapping_add(9_003);
            note_tab_loading(active, true);
            note_tab_loading(other, true);

            // No `viewId` → the ACTIVE tab, which is what the toolbar button acts on.
            nav_call(app, "nav.reloadOrStop", json!({})).expect("must answer");
            assert!(
                armed_navs(app).get(&active).map(String::as_str) == Some("about:blank"),
                "stopping the active tab must abandon THAT tab's load: {:?}",
                armed_navs(app)
            );
            assert!(
                !tab_is_loading(active),
                "the stop must settle the tab's loading flag, or the next press stops again"
            );

            // An EXPLICIT `viewId` acts on THAT tab. Re-arm the active tab's loading edge
            // first (the call above settled it), so a dispatch that quietly fell back to
            // the active tab would be caught rather than looking correct.
            note_tab_loading(active, true);
            nav_call(app, "nav.reloadOrStop", json!({ "viewId": other })).expect("must answer");
            let armed = armed_navs(app);
            assert_eq!(armed.get(&other).map(String::as_str), Some("about:blank"));
            assert!(
                !tab_is_loading(other),
                "the tab that was asked about must have its loading edge settled"
            );
            assert!(
                tab_is_loading(active),
                "an explicit viewId must not fall back to the active tab"
            );

            // A SETTLED tab reloads in place and arms no navigation at all. The table is
            // cleared first: nothing CONSUMES an entry without a real navigation, and the
            // mock has none, so the two arms above would still be sitting in it.
            app.state::<crate::redirect_guard::PendingNavs>()
                .0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .clear();
            note_tab_loading(active, true);
            note_tab_loading(active, false);
            nav_call(app, "nav.reloadOrStop", json!({ "viewId": active })).expect("must answer");
            assert!(
                !armed_navs(app).contains_key(&active),
                "a settled tab reloads in place; arming a navigation would make the guard \
                 treat a later redirect as app-initiated: {:?}",
                armed_navs(app)
            );

            forget_tab_loading(active);
            forget_tab_loading(other);
        });
    }

    /// Wave 6.10: the Android content WebView is a native `WebView`, so it does not
    /// go through `decide_navigation` — the scheme policy there is desktop-only. Kotlin
    /// has its own copy, `MainActivity.isLoadableUrl`, and for years nothing checked the
    /// two against each other, so they had drifted into DIFFERENT lists
    /// (`is_navigable` = http/https/about:blank, `isLoadableUrl` = http/https/ANY `about:`)
    /// while the main-frame `shouldOverrideUrlLoading` consulted NEITHER and let every
    /// non-`http` navigation proceed (`return false` = "let the WebView do it").
    ///
    /// There is no Kotlin test source set, so the drift is pinned from here: this test
    /// reads the Kotlin source and asserts the allowlist it spells is the same set this
    /// module enforces. It is a TEXT pin on purpose — it is the only thing that can catch
    /// a future Kotlin edit, and it fails the Rust suite if the two lists ever diverge
    /// again. (`script/`Kotlin half is compile-verified only; the behaviour still needs a
    /// device check.)
    fn kotlin_main_activity() -> String {
        let path = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt"
        );
        std::fs::read_to_string(path).unwrap_or_else(|e| panic!("cannot read {path}: {e}"))
    }

    /// The body of the Kotlin `fun isLoadableUrl`, from its opening brace to the one
    /// that closes it. Brace counting, not a line range, so inserting a line inside the
    /// function cannot silently narrow what this test looks at.
    fn kotlin_is_loadable_body(src: &str) -> String {
        let start = src.find("private fun isLoadableUrl(").expect(
            "MainActivity.kt no longer has a private fun isLoadableUrl — rename it and this test",
        );
        let open = src[start..]
            .find('{')
            .map(|i| start + i)
            .expect("isLoadableUrl has no opening brace");
        let mut depth = 0i32;
        for (i, c) in src[open..].char_indices() {
            match c {
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return src[open..=open + i].to_string();
                    }
                }
                _ => {}
            }
        }
        panic!("isLoadableUrl has no matching closing brace");
    }

    #[test]
    fn the_android_scheme_allowlist_is_the_same_set_this_module_enforces() {
        let body = kotlin_is_loadable_body(&kotlin_main_activity());
        // Every scheme this module accepts must be named in the Kotlin allowlist …
        for scheme in ["http", "https", "about"] {
            assert!(
                body.contains(&format!("scheme == \"{scheme}\"")),
                "Android's isLoadableUrl no longer names {scheme:?}; this module accepts it, so \
                 the two lists have diverged. Body was:\n{body}"
            );
        }
        // … and Kotlin must not have grown a scheme this module refuses.
        for refused in [
            "data",
            "file",
            "content",
            "blob",
            "javascript",
            "intent",
            "ftp",
        ] {
            assert!(
                !body.contains(&format!("scheme == \"{refused}\"")),
                "Android's isLoadableUrl now accepts {refused:?}, which nav::is_navigable \
                 refuses — the drift this test exists to catch. Body was:\n{body}"
            );
        }
        // The `about:` case is narrowed to `about:blank`, matching `u.path() == "blank"`
        // here. Asserted as a PROPERTY (a Kotlin `about:` that is not blank-and-only is
        // what drifted) rather than by string-matching the whole expression.
        assert!(
            body.contains("uri.path == \"blank\""),
            "Android's isLoadableUrl no longer restricts `about:` to about:blank; this module \
             refuses about:config, so the lists have diverged. Body was:\n{body}"
        );
    }

    #[test]
    fn the_android_main_frame_navigation_no_longer_bypasses_the_allowlist() {
        let src = kotlin_main_activity();
        // The bypass was `if (!raw.startsWith("http")) return false`, and `false` is
        // WebView's "carry on" answer. Its return value cannot be asserted from here (no
        // device), so the pin is on the *decision*: the override must now consult the
        // allowlist, and no non-http prefix test may hand the WebView a green light.
        let start = src
            .find("override fun shouldOverrideUrlLoading(")
            .expect("MainActivity.kt no longer overrides shouldOverrideUrlLoading");
        let body = &src[start..start + 1400];
        // The function's own comment QUOTES the bypass it replaced, so the negative
        // assert below has to look at CODE. Comment-only lines are dropped; a `//` in
        // column 0 vs an indented one is the only distinction Kotlin offers here, and
        // this file indents every `//` consistently inside the class body.
        let code: String = body
            .lines()
            .filter(|l| !l.trim_start().starts_with("//"))
            .collect::<Vec<_>>()
            .join("\n");
        assert!(
            code.contains("isLoadableUrl(raw)"),
            "the main-frame shouldOverrideUrlLoading must gate on isLoadableUrl, not on an \
             http prefix test — a page-initiated data:/file:/content: navigation is still \
             being allowed through. Snippet was:\n{code}"
        );
        assert!(
            !code.contains("!raw.startsWith(\"http\")) return false"),
            "the `!raw.startsWith(\"http\") -> return false` bypass is back: `false` tells \
             WebView to proceed, so every non-http scheme a page navigates to is allowed. \
             Snippet was:\n{code}"
        );
    }
}
