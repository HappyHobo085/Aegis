//! Tauri integration for tabs: managed registry state + tabs.* dispatch. Applies
//! the registry's (id,url) "spawn" / id "close" decisions to real child webviews,
//! emits `tabs.state`, persists, and runs the idle-sweep thread (Task 13).
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, Manager, Url};

use crate::tab_registry::{Registry, TabsState};

pub struct Tabs {
    pub reg: Mutex<Registry>,
    pub start: Instant,
}

impl Tabs {
    pub fn from_registry(reg: Registry) -> Self {
        Tabs { reg: Mutex::new(reg), start: Instant::now() }
    }
}

/// Monotonic ms since app start (matches the registry's `now_ms` clock).
pub fn now_ms(app: &AppHandle) -> u64 {
    app.try_state::<Tabs>().map(|s| s.start.elapsed().as_millis() as u64).unwrap_or(0)
}

fn state_value(app: &AppHandle) -> Value {
    let s: TabsState = app.state::<Tabs>().reg.lock().unwrap().tabs_state();
    serde_json::to_value(s).unwrap_or(Value::Null)
}

/// Emit `tabs.state` + persist the session.
fn emit_and_persist(app: &AppHandle) {
    let _ = crate::emit_event(app, "tabs.state", state_value(app));
    persist(app);
}

/// Record a tab's current URL (called from nav.rs on_page_load) for restore.
pub fn on_tab_url(app: &AppHandle, id: u32, url: &str) {
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg.lock().unwrap().record_nav(id, url);
    }
    emit_and_persist(app);
}

/// Record a tab's page title (from the WebKit title-changed signal). Updates the
/// strip + persists it so restored "asleep" tabs show their title.
#[allow(dead_code)] // only called from the Linux WebKit title-changed signal (linux_layout)
pub fn on_tab_title(app: &AppHandle, id: u32, title: &str) {
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg.lock().unwrap().set_title(id, title.to_string());
    }
    emit_and_persist(app);
}

fn spawn(app: &AppHandle, id: u32, url: &str) {
    let Ok(u) = Url::parse(url) else { return };
    // Windows: WebView2 DEADLOCKS the UI thread if a webview is created synchronously on
    // the event-loop thread — i.e. directly from the sync `ipc` command (see the Tauri
    // WebviewBuilder docs / wry#583: the async CreateCoreWebView2Controller can't complete
    // because the loop is blocked waiting on it). So create the webview on a SEPARATE
    // thread, then re-apply the content layout on the main thread once it exists.
    #[cfg(target_os = "windows")]
    {
        let app = app.clone();
        std::thread::spawn(move || {
            if let Err(e) = crate::nav::spawn_tab(&app, id, u) {
                eprintln!("[aegis] spawn_tab({id}) failed: {e}");
                return;
            }
            let app_layout = app.clone();
            let _ = app.run_on_main_thread(move || crate::view::apply_inset(&app_layout));
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = crate::nav::spawn_tab(app, id, u);
    }
}

/// Desktop: tear down the tab's child webview. Mobile is single-webview (tabs are a
/// no-op stub there — see `nav::spawn_tab`), so there's no child webview to close.
#[cfg(desktop)]
fn close_webview(app: &AppHandle, id: u32) {
    if let Some(w) = app.get_webview(&crate::nav::content_label(id)) {
        let _ = w.close();
    }
}

#[cfg(mobile)]
fn close_webview(_app: &AppHandle, _id: u32) {}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let now = now_ms(app);
    match channel {
        "tabs.list" => Some(Ok(state_value(app))),
        "tabs.create" => {
            let url = payload.get("url").and_then(Value::as_str).map(str::to_string);
            // background = true opens the tab without switching the active tab (target=_blank
            // / window.open on mobile; matches on_new_window's open_background on desktop).
            let background = payload.get("background").and_then(Value::as_bool).unwrap_or(false);
            let (id, u) = app.state::<Tabs>().reg.lock().unwrap().create(url, background, now);
            spawn(app, id, &u);
            crate::view::apply_inset(app); // show the active tab (unchanged when background)
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.activate" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let to_spawn = app.state::<Tabs>().reg.lock().unwrap().activate(id, now);
            if let Some(u) = to_spawn { spawn(app, id, &u); }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.close" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let out = app.state::<Tabs>().reg.lock().unwrap().close(id, now);
            if out.closed_live { close_webview(app, id); }
            if let Some((nid, u)) = out.spawn { spawn(app, nid, &u); }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.reopenClosed" => {
            let reopened = app.state::<Tabs>().reg.lock().unwrap().reopen_closed(now);
            if let Some((id, u)) = reopened { spawn(app, id, &u); }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.setPinned" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let pinned = payload.get("pinned").and_then(Value::as_bool).unwrap_or(false);
            app.state::<Tabs>().reg.lock().unwrap().set_pinned(id, pinned);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.reorder" => {
            let ids: Vec<u32> = payload.get("ids").and_then(Value::as_array)
                .map(|a| a.iter().filter_map(|v| v.as_u64().map(|n| n as u32)).collect())
                .unwrap_or_default();
            app.state::<Tabs>().reg.lock().unwrap().reorder(&ids);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.setTitle" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let title = payload.get("title").and_then(Value::as_str).unwrap_or("").to_string();
            app.state::<Tabs>().reg.lock().unwrap().set_title(id, title);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        _ => None,
    }
}

/// Close tab `id` programmatically (e.g. nav.rs auto-closing a pop-under shell whose
/// only navigation was a blocked ad). Applies the same registry + webview + neighbour-
/// respawn steps as the `tabs.close` IPC. No-op if the id is unknown.
#[allow(dead_code)] // desktop-only caller (nav::on_navigation); the mobile build stubs spawn_tab
pub fn close_tab(app: &AppHandle, id: u32) {
    let now = now_ms(app);
    let out = app.state::<Tabs>().reg.lock().unwrap().close(id, now);
    if out.closed_live {
        close_webview(app, id);
    }
    if let Some((nid, u)) = out.spawn {
        spawn(app, nid, &u);
    }
    crate::nav::forget_tab_content(id);
    crate::view::apply_inset(app);
    emit_and_persist(app);
}

/// Open a URL in a new BACKGROUND tab (from on_new_window / Ctrl-click). Spawns
/// the webview, emits state + persists, but does NOT change the active tab.
pub fn open_background(app: &AppHandle, url: &str) {
    let now = now_ms(app);
    let (id, u) = app.state::<Tabs>().reg.lock().unwrap().create(Some(url.to_string()), true, now);
    spawn(app, id, &u);
    emit_and_persist(app);
}

fn session_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("tabs.json"))
}

/// Persist the session to tabs.json.
pub fn persist(app: &AppHandle) {
    let Some(p) = session_path(app) else { return; };
    let session = match app.try_state::<Tabs>() {
        Some(s) => s.reg.lock().unwrap().to_persisted(),
        None => return,
    };
    if let Ok(txt) = serde_json::to_string_pretty(&session) {
        // Durable write (atomic temp→rename + .bak) — tabs.json is rewritten on every
        // tab/nav change, so a crash mid-write must not truncate it and lose the session.
        let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
    }
}

/// Load a saved session, if any. Recovers from tabs.json.bak if the primary is corrupt.
pub fn load_session(app: &AppHandle) -> Option<crate::tab_registry::PersistedSession> {
    let p = session_path(app)?;
    let txt = crate::jsonstore::read_with_backup(&p)?;
    serde_json::from_str(&txt).ok()
}

/// Start the idle-sweep thread: every 30s, discard tabs idle past the timeout.
pub fn start_idle_sweep(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let timeout_ms = crate::settings::tab_idle_timeout_min(&app).saturating_mul(60_000);
        if timeout_ms == 0 { continue; }
        let now = now_ms(&app);
        let victims = match app.try_state::<Tabs>() {
            Some(s) => s.reg.lock().unwrap().sweep_idle(now, timeout_ms),
            None => continue,
        };
        if victims.is_empty() { continue; }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            for id in &victims { close_webview(&app2, *id); }
            emit_and_persist(&app2); // strip re-renders the discarded tabs as "asleep"
        });
    });
}
