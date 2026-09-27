//! Tauri integration for tabs: managed registry state + tabs.* dispatch. Applies
//! the registry's (id,url) "spawn" / id "close" decisions to real child webviews,
//! emits `tabs.state`, persists, and runs the idle-sweep thread (Task 13).
use std::sync::Mutex;
use std::time::Instant;

use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime, Url};

use crate::tab_registry::{Registry, TabsState};

pub struct Tabs {
    pub reg: Mutex<Registry>,
    pub start: Instant,
}

/// The inert URL a tab falls back to when its real target is refused. Deliberately NOT
/// `create_private(None, …)`: that substitutes the user's *home page*, so refusing a
/// `window.open('file:///…')` would have silently navigated them to their homepage
/// because a page asked. `about:blank` is inert, and `nav::is_navigable` allows it.
const INERT_TAB_URL: &str = "about:blank";

impl Tabs {
    pub fn from_registry(reg: Registry) -> Self {
        Tabs {
            reg: Mutex::new(reg),
            start: Instant::now(),
        }
    }
}

/// Monotonic ms since app start (matches the registry's `now_ms` clock).
pub fn now_ms<R: Runtime>(app: &AppHandle<R>) -> u64 {
    app.try_state::<Tabs>()
        .map(|s| s.start.elapsed().as_millis() as u64)
        .unwrap_or(0)
}

fn state_value<R: Runtime>(app: &AppHandle<R>) -> Value {
    let s: TabsState = state_tabs(app);
    serde_json::to_value(s).unwrap_or(Value::Null)
}

fn state_tabs<R: Runtime>(app: &AppHandle<R>) -> TabsState {
    app.state::<Tabs>()
        .reg
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .tabs_state()
}

fn workspace_state_value<R: Runtime>(app: &AppHandle<R>) -> Value {
    let tabs = app.state::<Tabs>();
    let reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
    let workspaces = reg.workspace_list();
    let active_id = reg.active_workspace_id().to_string();
    serde_json::json!({
        "workspaces": workspaces,
        "activeWorkspaceId": active_id,
    })
}

/// Emit `tabs.state` + persist the session. Also emits `workspace.state` so the
/// chrome's workspace tab counts stay in sync after tab mutations.
fn emit_and_persist<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "tabs.state", state_value(app));
    persist(app);
    emit_workspace_and_persist(app);
}

/// Emit `workspace.state` so the chrome's workspace tab counts stay in sync.
fn emit_workspace_and_persist<R: Runtime>(app: &AppHandle<R>) {
    let value = workspace_state_value(app);
    crate::emit_event(app, "workspace.state", &value);
}

fn record_nav<R: Runtime>(app: &AppHandle<R>, id: u32, url: &str, title: &str) {
    {
        let tabs = app.state::<Tabs>();
        let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
        if !url.is_empty() {
            reg.record_nav(id, url);
        }
        if !title.is_empty() {
            reg.set_title(id, title.to_string());
        }
    }
    emit_and_persist(app);
}

/// Record a tab's current URL (called from nav.rs on_page_load) for restore.
///
/// This is the SECOND writer of the persisted url, and it is the one that runs
/// on every single page load — the `tabs.recordNav` channel validates its input
/// with `parse_navigable` and its comment calls itself "the last point at which
/// a non-navigable scheme can be caught before it is written to tabs.json".
/// That claim was false, because this function also writes to tabs.json (via
/// `emit_and_persist`) and validated nothing: a `file:` load was recorded, and
/// session restore re-spawns tabs FROM tabs.json on the next launch, so a
/// single non-web navigation became a durable local-file read on every
/// subsequent launch — exactly what `is_navigable` exists to prevent.
///
/// Refused the same way the sibling channel refuses: the previous url stays,
/// the load itself is `nav::decide_navigation`'s problem to cancel, and no
/// persist happens because nothing changed.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn on_tab_url<R: Runtime>(app: &AppHandle<R>, id: u32, url: &str) {
    if !url.is_empty() {
        if let Err(e) = crate::nav::parse_navigable(url) {
            eprintln!("[aegis] not recording a non-navigable url for tab {id}: {e}");
            return;
        }
    }
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .record_nav(id, url);
    }
    emit_and_persist(app);
}

/// Record a tab's page title (from the WebKit title-changed signal). Updates the
/// strip + persists it so restored "asleep" tabs show their title.
#[allow(dead_code)] // only called from the Linux WebKit title-changed signal (linux_layout)
pub fn on_tab_title<R: Runtime>(app: &AppHandle<R>, id: u32, title: &str) {
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .set_title(id, title.to_string());
    }
    emit_and_persist(app);
}

/// A content webview could not be created for tab `id`. Returns whether a live registry
/// row was found and rolled back.
///
/// The registry marks a tab `live` the moment it hands the URL to `spawn`, and `activate`
/// only respawns a tab that is NOT live. So a failed spawn that leaves the flag set
/// produces a tab the strip lists and the user can click, with no webview behind it and no
/// way to retry: activating it in place is a no-op (it is already active) and switching
/// away and back arms no respawn. Worse, the row is persisted by `emit_and_persist`, so
/// session restore re-spawns it on the next launch and fails the same way. Rolling the
/// flag back costs nothing and makes the tab retry the next time it is activated.
pub fn on_spawn_failed<R: Runtime>(app: &AppHandle<R>, id: u32, err: &str) -> bool {
    eprintln!("[aegis] spawn_tab({id}) failed: {err}");
    app.try_state::<Tabs>()
        .map(|s| {
            s.reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .mark_spawn_failed(id)
        })
        .unwrap_or(false)
}

fn spawn(app: &AppHandle, id: u32, url: &str, private: bool) {
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
            if let Err(e) = crate::nav::spawn_tab(&app, id, u, private) {
                // The row is already live and already persisted, so it must be rolled
                // back here or the tab is a permanently dead entry in the strip.
                on_spawn_failed(&app, id, &e.to_string());
                return;
            }
            let app_layout = app.clone();
            let _ = app.run_on_main_thread(move || crate::view::apply_inset(&app_layout));
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        if let Err(e) = crate::nav::spawn_tab(app, id, u, private) {
            on_spawn_failed(app, id, &e.to_string());
        }
    }
}

/// Whether tab `id` is a private (incognito) tab. Defaults to false for an unknown id.
pub fn is_private<R: Runtime>(app: &AppHandle<R>, id: u32) -> bool {
    app.try_state::<Tabs>()
        .and_then(|s| {
            s.reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_private(id)
        })
        .unwrap_or(false)
}

/// Desktop: tear down the tab's child webview. Mobile is single-webview (tabs are a
/// no-op stub there — see `nav::spawn_tab`), so there's no child webview to close.
#[cfg(desktop)]
fn close_webview(app: &AppHandle, id: u32) {
    // Get the webview once to ensure we operate on the same instance throughout
    let label = crate::nav::content_label(id);
    let Some(webview) = app.get_webview(&label) else {
        return;
    };

    // On Linux, remove the webview from the container before closing to avoid dangling pointers.
    #[cfg(target_os = "linux")]
    {
        crate::linux_layout::remove_webview_label(app, &label);
    }

    // Close the webview (this should not fail even if already closed)
    let _ = webview.close();
}

#[cfg(mobile)]
fn close_webview(_app: &AppHandle, _id: u32) {}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    let now = now_ms(app);
    match channel {
        "tabs.list" => Some(Ok(state_value(app))),
        "tabs.create" => {
            let url = match payload.get("url").and_then(Value::as_str) {
                // No url = a fresh tab; the registry seeds it with about:blank.
                None => None,
                Some(raw) => {
                    // Checked HERE, not at the webview, because `create_private`
                    // persists the url into tabs.json. A `file:` target accepted once
                    // would be re-spawned as a tab on every later launch, turning a
                    // single bad navigation into a durable local-file read.
                    if let Err(e) = crate::nav::parse_navigable(raw) {
                        return Some(Err(e));
                    }
                    Some(raw.to_string())
                }
            };
            // background = true opens the tab without switching the active tab (target=_blank
            // / window.open on mobile; matches on_new_window's open_background on desktop).
            let background = payload
                .get("background")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let private = payload
                .get("private")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            let (id, u) = app
                .state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .create_private(url, background, now, private);
            if !background {
                spawn(app, id, &u, private);
            }
            crate::view::apply_inset(app); // show the active tab (unchanged when background)
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.activate" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let to_spawn = app
                .state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .activate(id, now);
            if let Some(u) = to_spawn {
                // Read privateness from the registry: only non-private discarded tabs
                // are ever respawned (private tabs are exempt from the idle sweep).
                let private = is_private(app, id);
                spawn(app, id, &u, private);
            }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.close" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let out = app
                .state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .close(id, now);
            if out.closed_live {
                close_webview(app, id);
            }
            // Unconditional, like the programmatic path: the id is gone from the
            // registry either way, and both side tables are keyed by id.
            forget_closed_tab(id);
            if let Some((nid, u)) = out.spawn {
                // Neighbor respawn: read privateness from the registry (private tabs are
                // exempt from the idle sweep, so any discarded neighbor is always non-private).
                let private = is_private(app, nid);
                spawn(app, nid, &u, private);
            }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.reopenClosed" => {
            let reopened = app
                .state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reopen_closed(now);
            if let Some((id, u)) = reopened {
                // Reopened tabs are always non-private (reopen_closed creates non-private tabs).
                spawn(app, id, &u, false);
            }
            crate::view::apply_inset(app);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.setPinned" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let pinned = payload
                .get("pinned")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            app.state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set_pinned(id, pinned);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.reorder" => {
            let ids: Vec<u32> = payload
                .get("ids")
                .and_then(Value::as_array)
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as u32))
                        .collect()
                })
                .unwrap_or_default();
            app.state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .reorder(&ids);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.setTitle" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let title = payload
                .get("title")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            app.state::<Tabs>()
                .reg
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .set_title(id, title);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.recordNav" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            let title = payload.get("title").and_then(Value::as_str).unwrap_or("");
            // The renderer reports what the content webview actually loaded, so this
            // is the last point at which a non-navigable scheme can be caught before it
            // is written to tabs.json — and tabs.json is what session restore re-spawns
            // from on the next launch. Refuse loudly rather than persisting it.
            if !url.is_empty() {
                if let Err(e) = crate::nav::parse_navigable(url) {
                    return Some(Err(e));
                }
            }
            record_nav(app, id, url, title);
            Some(Ok(state_value(app)))
        }
        // ── workspace dispatch ────────────────────────────────────────────────
        "workspace.list" => Some(Ok(workspace_state_value(app))),
        "workspace.create" => {
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let color = payload
                .get("color")
                .and_then(Value::as_str)
                .unwrap_or("slate");
            let ws = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.create_workspace(name, color)
            };
            emit_workspace_and_persist(app);
            Some(Ok(serde_json::to_value(ws).unwrap()))
        }
        "workspace.switch" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let success = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.switch_workspace(id)
            };
            if success {
                crate::view::apply_inset(app);
            }
            emit_and_persist(app);
            emit_workspace_and_persist(app);
            Some(Ok(workspace_state_value(app)))
        }
        "workspace.rename" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let name = payload
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("Untitled");
            let result = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.rename_workspace(id, name)
            };
            emit_workspace_and_persist(app);
            match result {
                Some(ws) => Some(Ok(serde_json::to_value(ws).unwrap())),
                None => Some(Err("workspace not found".into())),
            }
        }
        "workspace.setColor" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let color = payload
                .get("color")
                .and_then(Value::as_str)
                .unwrap_or("slate");
            let result = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.set_workspace_color(id, color)
            };
            emit_workspace_and_persist(app);
            match result {
                Some(ws) => Some(Ok(serde_json::to_value(ws).unwrap())),
                None => Some(Err("workspace not found".into())),
            }
        }
        "workspace.remove" => {
            let id = payload.get("id").and_then(Value::as_str).unwrap_or("");
            let success = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.remove_workspace(id)
            };
            if success {
                emit_and_persist(app);
            }
            emit_workspace_and_persist(app);
            if success {
                Some(Ok(workspace_state_value(app)))
            } else {
                Some(Err("cannot remove workspace".into()))
            }
        }
        "workspace.reorder" => {
            let ids: Vec<String> = payload
                .get("ids")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .filter_map(|v| v.as_str().map(String::from))
                        .collect()
                })
                .unwrap_or_default();
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.reorder_workspaces(&ids);
            }
            emit_workspace_and_persist(app);
            Some(Ok(workspace_state_value(app)))
        }
        _ => None,
    }
}

/// Close tab `id` programmatically (e.g. nav.rs auto-closing a pop-under shell whose
/// only navigation was a blocked ad). Applies the same registry + webview + neighbour-
/// respawn steps as the `tabs.close` IPC. No-op if the id is unknown.
#[allow(dead_code)] // desktop-only caller (nav::on_navigation); the mobile build stubs spawn_tab
/// Side-table state a closed tab must not leave behind, for EVERY close path.
///
/// Two process-global sets are keyed by tab id, and both are suppression flags
/// rather than bookkeeping: the content flag is what stops the pop-under
/// auto-close in `nav::decide_navigation` from closing a tab that has real
/// content, and the loading flag is what makes `nav.reloadOrStop` answer Stop
/// instead of Reload. A closed id left in either set therefore suppresses a
/// behaviour for whatever tab is later given that id — and ids DO get reused,
/// because `alloc_tab_id` only skips ids still in the registry, so a hand-edited
/// `tabs.json` (or a restored backup) can hand back an id that is free.
///
/// One definition, called by both writers — the programmatic `close_tab` and the
/// `tabs.close` IPC arm — because the two used to disagree, and the arm is the
/// one users actually press.
fn forget_closed_tab(id: u32) {
    crate::nav::forget_tab_content(id);
    crate::nav::forget_tab_loading(id);
}

pub fn close_tab(app: &AppHandle, id: u32) {
    let now = now_ms(app);
    let out = app
        .state::<Tabs>()
        .reg
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .close(id, now);
    if out.closed_live {
        close_webview(app, id);
    }
    if let Some((nid, u)) = out.spawn {
        // Neighbor respawn: private tabs are exempt from the idle sweep, so any
        // discarded neighbor is always non-private; read from registry for safety.
        let private = is_private(app, nid);
        spawn(app, nid, &u, private);
    }
    forget_closed_tab(id);
    crate::view::apply_inset(app);
    emit_and_persist(app);
}

/// Open a URL in a new BACKGROUND tab (from on_new_window / Ctrl-click). Does NOT spawn
/// the webview until the tab is activated. Emits state + persists, but does NOT change the
/// active tab.
/// A popup from a private tab inherits privateness (`private = true`).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn open_background(app: &AppHandle, url: &str, private: bool) {
    open_redirect_background(app, url, private);
}

/// Open a URL in a new background tab and return its id. Used by the redirect blocker
/// which needs the id for the auto-close timer.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn open_redirect_background(app: &AppHandle, url: &str, private: bool) -> u32 {
    let now = now_ms(app);
    // Last gate before a background tab's url is PERSISTED. `on_new_window` already
    // refuses a page-supplied non-navigable scheme, but this function is also the
    // redirect-blocker's spawn point, and it cannot return an error — so substitute
    // about:blank (an inert tab) rather than creating one that would load the URL on
    // every future launch.
    let safe = match tauri::Url::parse(url) {
        Ok(u) if crate::nav::is_navigable(&u) => url.to_string(),
        _ => {
            log::warn!("[aegis] refusing to open background tab at non-navigable url {url:?}");
            INERT_TAB_URL.to_string()
        }
    };
    let (id, _u) = app
        .state::<Tabs>()
        .reg
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .create_private(Some(safe), true, now, private);
    emit_and_persist(app);
    id
}

fn session_path<R: Runtime>(app: &AppHandle<R>) -> Option<std::path::PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("tabs.json"))
}

/// Persist the session to tabs.json.
pub fn persist<R: Runtime>(app: &AppHandle<R>) {
    let Some(p) = session_path(app) else {
        return;
    };
    let session = match app.try_state::<Tabs>() {
        Some(s) => s
            .reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .to_persisted(),
        None => return,
    };
    if let Ok(txt) = serde_json::to_string_pretty(&session) {
        // Durable write (atomic temp→rename + .bak) — tabs.json is rewritten on every
        // tab/nav change, so a crash mid-write must not truncate it and lose the session.
        if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
            eprintln!("[aegis] failed to persist tab session: {e}");
        }
    }
}

/// Load a saved session, if any. Recovers from tabs.json.bak if the primary is corrupt.
pub fn load_session<R: Runtime>(
    app: &AppHandle<R>,
) -> Option<crate::tab_registry::PersistedSession> {
    let p = session_path(app)?;
    let txt = crate::jsonstore::read_with_backup(&p)?;
    serde_json::from_str(&txt).ok()
}

/// Start the idle-sweep thread: every 30s, discard tabs idle past the timeout.
pub fn start_idle_sweep(app: &AppHandle) {
    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            std::thread::sleep(std::time::Duration::from_secs(30));
            let timeout_ms = crate::settings::tab_idle_timeout_min(&app).saturating_mul(60_000);
            if timeout_ms == 0 {
                continue;
            }
            let bg_timeout_ms = crate::settings::background_tab_timeout_ms(&app);
            let aggressive_threshold = crate::settings::aggressive_sweep_threshold(&app);
            let now = now_ms(&app);
            let victims = match app.try_state::<Tabs>() {
                Some(s) => s.reg.lock().unwrap_or_else(|e| e.into_inner()).sweep_idle(
                    now,
                    timeout_ms,
                    bg_timeout_ms,
                    aggressive_threshold,
                ),
                None => continue,
            };
            if victims.is_empty() {
                continue;
            }
            let app2 = app.clone();
            let _ = app.run_on_main_thread(move || {
                // Close the victims' webviews. The registry ROWS STAY: a swept tab is still a
                // tab the user can see and click, and `activate` respawns its webview on the
                // next activation. Deleting the rows here made background tabs disappear from
                // the strip entirely after `tabIdleTimeout` minutes (30 by default) with no
                // visual indication, and — since they never reached `closed_stack` — left them
                // un-reopenable with Ctrl+Shift+T.
                for id in &victims {
                    close_webview(&app2, *id);
                }
                // `sweep_idle` already flipped each victim to `live: false`, so the strip
                // re-renders them as "asleep".
                emit_and_persist(&app2);
            });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    // ── session persistence ───────────────────────────────────────────────────

    /// persist() serialises the managed registry to tabs.json; load_session() reads
    /// it back.  Roundtrip must preserve tab count, active id, and next_id.
    #[test]
    fn session_round_trips_through_the_app_data_dir() {
        with_tmp_app(|app| {
            // Seed the managed registry with an extra tab so the persisted session
            // has 2 tabs (the boot tab + the new one).
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.create(Some("https://a.test/".into()), false, 0);
            }

            // Write the session via the production persist() helper.
            persist(app);

            // The session file must exist under the temp data dir.
            let data_dir = app.path().app_data_dir().expect("data dir resolves");
            let session_file = data_dir.join("tabs.json");
            assert!(
                session_file.exists(),
                "tabs.json must exist after persist()"
            );

            // Read it back.
            let loaded = load_session(app).expect("load_session must succeed after persist()");

            // Capture the expected values from the registry.
            let expected = {
                let tabs = app.state::<Tabs>();
                let reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.to_persisted()
            };

            assert_eq!(
                loaded.tabs.len(),
                expected.tabs.len(),
                "tab count must match"
            );
            assert_eq!(
                loaded.active_id, expected.active_id,
                "active_id must round-trip"
            );
            assert_eq!(loaded.next_id, expected.next_id, "next_id must round-trip");

            // The extra tab's URL must survive the roundtrip.
            let found = loaded.tabs.iter().any(|t| t.url == "https://a.test/");
            assert!(found, "persisted tab URL must be present after load");
        });
    }

    /// load_session() with no tabs.json returns None — callers fall back to a fresh
    /// single-tab registry.
    #[test]
    fn missing_session_file_returns_none() {
        with_tmp_app(|app| {
            // No tabs.json written — load_session must return None, not panic.
            let loaded = load_session(app);
            assert!(
                loaded.is_none(),
                "load_session with no file must return None"
            );
        });
    }

    /// A persist() / load_session() roundtrip preserves tab titles and pinned state.
    #[test]
    fn session_preserves_title_and_pinned() {
        with_tmp_app(|app| {
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                // Create a pinned tab with a title.
                let (id, _) = reg.create(Some("https://pinned.test/".into()), false, 0);
                reg.set_pinned(id, true);
                reg.set_title(id, "Pinned Page".into());
            }

            persist(app);
            let loaded = load_session(app).expect("load_session must succeed");

            let pinned_tab = loaded
                .tabs
                .iter()
                .find(|t| t.url == "https://pinned.test/")
                .expect("pinned tab must be in the session");

            assert!(pinned_tab.pinned, "pinned flag must survive the roundtrip");
            assert_eq!(
                pinned_tab.title, "Pinned Page",
                "title must survive the roundtrip"
            );
        });
    }

    // ── tabs_state from the managed registry ──────────────────────────────────

    /// The managed registry's tabs_state() returns a well-formed TabsState:
    /// at least one tab and a non-zero activeId.  This covers the same surface as
    /// `tabs.list` without calling the non-generic dispatch() function.
    #[test]
    fn managed_registry_tabs_state_is_well_formed() {
        with_tmp_app(|app| {
            let state = app.state::<Tabs>();
            let reg = state.reg.lock().unwrap_or_else(|e| e.into_inner());
            let ts = reg.tabs_state();

            assert!(
                !ts.tabs.is_empty(),
                "tabs_state must have at least the boot tab"
            );
            assert!(ts.active_id > 0, "active_id must be non-zero");

            // activeId must correspond to a tab in the list.
            let found = ts.tabs.iter().any(|t| t.id == ts.active_id);
            assert!(found, "active_id must correspond to a tab in the tabs list");
        });
    }

    // ── is_private ───────────────────────────────────────────────────────────

    /// is_private returns false for the boot tab (always non-private) and false for
    /// an unknown id.
    #[test]
    fn is_private_false_for_normal_tab_and_unknown_id() {
        with_tmp_app(|app| {
            // Boot tab id is 1.
            assert!(!is_private(app, 1), "boot tab must not be private");
            // Unknown id: must return false, not panic.
            assert!(!is_private(app, 9999), "unknown id must return false");
        });
    }

    // ── pure-state registry mutations ─────────────────────────────────────────

    /// set_title updates the title in the managed registry; persist + load_session
    /// preserve it (end-to-end Tauri-layer test without webview spawn).
    #[test]
    fn set_title_persists_through_session_roundtrip() {
        with_tmp_app(|app| {
            // Mutate via the registry directly (same code dispatch("tabs.setTitle") calls).
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.set_title(1, "Hello".into());
            }

            persist(app);
            let loaded = load_session(app).expect("load_session must succeed");

            let boot_tab = loaded
                .tabs
                .iter()
                .find(|t| t.id == 1)
                .expect("boot tab must be in session");
            assert_eq!(
                boot_tab.title, "Hello",
                "title must survive persist/load roundtrip"
            );
        });
    }

    #[test]
    fn record_nav_persists_url_and_title() {
        with_tmp_app(|app| {
            record_nav(app, 1, "https://restored.example/path", "Restored");

            let loaded = load_session(app).expect("load_session must succeed");
            let boot_tab = loaded
                .tabs
                .iter()
                .find(|t| t.id == 1)
                .expect("boot tab must be in session");
            assert_eq!(boot_tab.url, "https://restored.example/path");
            assert_eq!(boot_tab.title, "Restored");
        });
    }

    /// set_pinned updates the pinned flag in the managed registry; persist + load_session
    /// preserve it.
    #[test]
    fn set_pinned_persists_through_session_roundtrip() {
        with_tmp_app(|app| {
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.set_pinned(1, true);
            }

            persist(app);
            let loaded = load_session(app).expect("load_session must succeed");

            let boot_tab = loaded
                .tabs
                .iter()
                .find(|t| t.id == 1)
                .expect("boot tab must be in session");
            assert!(
                boot_tab.pinned,
                "pinned flag must survive persist/load roundtrip"
            );
        });
    }

    /// reorder changes the tab order in the managed registry; tabs_state() reflects it.
    #[test]
    fn reorder_changes_tab_order_in_managed_registry() {
        with_tmp_app(|app| {
            // Create a second tab so we have ids [1, 2].
            let id2 = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                let (id, _) = reg.create(Some("https://b.test/".into()), false, 0);
                id
            };

            // Reorder to [id2, 1].
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.reorder(&[id2, 1]);
            }

            let state = app.state::<Tabs>();
            let reg = state.reg.lock().unwrap_or_else(|e| e.into_inner());
            let ts = reg.tabs_state();

            assert!(ts.tabs.len() >= 2, "must have at least 2 tabs after create");
            // After reorder, id2 should appear before tab 1.
            let pos_id2 = ts
                .tabs
                .iter()
                .position(|t| t.id == id2)
                .expect("id2 must be present");
            let pos_1 = ts
                .tabs
                .iter()
                .position(|t| t.id == 1)
                .expect("tab 1 must be present");
            assert!(
                pos_id2 < pos_1,
                "id2 must appear before tab 1 after reorder"
            );
        });
    }

    // ── persist + session path ────────────────────────────────────────────────

    /// persist() is idempotent: calling it twice with the same state produces the
    /// same file content.
    #[test]
    fn persist_is_idempotent() {
        with_tmp_app(|app| {
            persist(app);
            let first = load_session(app).expect("first persist must be loadable");
            persist(app);
            let second = load_session(app).expect("second persist must be loadable");

            assert_eq!(first.tabs.len(), second.tabs.len());
            assert_eq!(first.active_id, second.active_id);
            assert_eq!(first.next_id, second.next_id);
        });
    }

    /// Private tabs are excluded from the persisted session.
    #[test]
    fn private_tabs_are_excluded_from_persisted_session() {
        with_tmp_app(|app| {
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                // create_private(url, background, now_ms, private=true)
                reg.create_private(Some("https://private.test/".into()), false, 0, true);
            }

            // is_private returns true for the new tab; we check by inspecting the registry.
            let private_id = {
                let tabs = app.state::<Tabs>();
                let reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                let ts = reg.tabs_state();
                // The private tab is the most recently created (active, id > 1).
                ts.active_id
            };
            assert!(
                is_private(app, private_id),
                "newly created private tab must be private"
            );

            persist(app);
            let loaded = load_session(app).expect("load_session must succeed");

            // The private tab's URL must NOT appear in the persisted session.
            let found = loaded.tabs.iter().any(|t| t.url == "https://private.test/");
            assert!(
                !found,
                "private tab must be excluded from the persisted session"
            );
        });
    }

    /// A failed content-webview spawn must not leave a permanently dead tab.
    ///
    /// The registry half is pure (see `tab_registry`'s
    /// `a_tab_whose_spawn_failed_can_be_activated_again`); this test covers the
    /// app-facing half — that the report actually reaches the managed registry, and
    /// that an unknown tab is reported rather than panicking. The remaining surface,
    /// `spawn`'s `if let Err(e) = … { on_spawn_failed(…) }`, needs a real webview
    /// (or a Wry `AppHandle`), so it is the one untested line here — the same
    /// honest limit every boot/call-site wiring in this crate carries.
    #[test]
    fn a_spawn_failure_rolls_the_tab_back_so_it_can_be_respawned() {
        use crate::test_support::with_tmp_app;
        use tauri::Manager;
        with_tmp_app(|app| {
            // Two tabs: `id` and its neighbour, which stays active so switching to
            // `id` is a real switch (and not the "already active" no-op).
            let (id, url) = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                let (id, url) =
                    reg.create_private(Some("https://zombie.test/".into()), false, 0, false);
                reg.create_private(Some("https://other.test/".into()), false, 0, false);
                (id, url)
            };

            // A tab whose spawn failed is reported…
            assert!(
                super::on_spawn_failed(app, id, "test failure"),
                "a live tab must be rolled back when its spawn fails"
            );

            // …and is respawnable, which is the user-visible property.
            let to_spawn = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.activate(id, 1)
            };
            assert_eq!(
                to_spawn.as_deref(),
                Some(url.as_str()),
                "a tab whose spawn failed must be respawnable, or it is dead for the \
                 session and every later launch"
            );

            // A report for a tab that does not exist is reported, not fatal: a late
            // failure can arrive after the tab was closed.
            assert!(
                !super::on_spawn_failed(app, 9_999_001, "late failure"),
                "an unknown tab must be reported, not panic"
            );
        });
    }

    /// The per-page-load writer of the persisted url. Its sibling channel
    /// (`tabs.recordNav`) validates with `parse_navigable` and calls itself the
    /// last point before `tabs.json`; this one ran on EVERY page load and
    /// validated nothing, so a `file:` load was recorded and — because session
    /// restore re-spawns tabs *from* `tabs.json` — became a local-file read on
    /// every later launch.
    #[test]
    fn a_page_load_of_a_non_web_scheme_is_not_persisted_as_the_tabs_url() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            let url = "https://real.test/";
            let (id, _) = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.create(Some(url.to_string()), false, 0)
            };
            super::on_tab_url(app, id, "file:///etc/passwd");

            let (persisted, history) = {
                let tabs = app.state::<Tabs>();
                let reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                (
                    reg.url_of(id).map(str::to_string),
                    reg.to_persisted()
                        .tabs
                        .into_iter()
                        .find(|t| t.id == id)
                        .map(|t| t.url),
                )
            };
            assert_eq!(
                persisted.as_deref(),
                Some(url),
                "a non-web load must not become the tab's url — that is what \
                 session restore re-spawns from on the next launch"
            );
            assert_eq!(
                history.as_deref(),
                Some(url),
                "…nor may it enter the history, or Back walks the user into it"
            );
        });
    }

    /// Anti-over-fix: real navigation still records, including `about:blank`
    /// (what a new tab and a Stop both load) and an empty string (what a
    /// load event with no url reports).
    #[test]
    fn ordinary_page_loads_are_still_recorded() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            let (id, _) = {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
                reg.create(Some("https://home.test/".into()), false, 0)
            };
            super::on_tab_url(app, id, "https://next.test/page");
            super::on_tab_url(app, id, "about:blank");
            let tabs = app.state::<Tabs>();
            let reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
            assert_eq!(reg.url_of(id), Some("about:blank"));
            assert!(reg.can_go_back(id), "the real page must stay in history");
        });
    }

    /// 6(10): one definition of the side-table forget, so the two close paths cannot
    /// disagree again.
    ///
    /// HONEST LIMIT — read this before treating the IPC-arm fix as tested. Both close
    /// writers (`close_tab` and `tabs::dispatch`) are concrete `&AppHandle`
    /// (tauri::Wry), so neither can be driven on the mock runtime: driving them would
    /// mean genericising `close_webview` / `view::apply_inset` / `emit_and_persist`,
    /// which is the same cascade that blocked `spawn` (6(3)) and `decide_navigation`
    /// (6(9)). So what is pinned here is the FORGET, and the new call site in the arm
    /// is compile-verified only. The deduplication is the load-bearing part: one
    /// function, two call sites, both visible in the diff.
    #[test]
    fn forgetting_a_closed_tab_clears_both_side_tables() {
        crate::nav::mark_tab_has_content(4242);
        crate::nav::note_tab_loading(4242, true);
        assert!(
            crate::nav::tab_has_content(4242),
            "precondition: content flag set"
        );
        assert!(
            crate::nav::tab_is_loading(4242),
            "precondition: loading flag set"
        );

        super::forget_closed_tab(4242);

        assert!(
            !crate::nav::tab_has_content(4242),
            "a closed id left in the content set suppresses the pop-under auto-close \
             for whatever tab is later given that id"
        );
        assert!(
            !crate::nav::tab_is_loading(4242),
            "a closed id left in the loading set makes reloadOrStop answer Stop \
             forever on whatever tab is later given that id"
        );
    }

    /// Idempotent: a close can be requested twice for the same tab (the IPC arm plus a
    /// sweep, or two clicks), and a forget of an absent id must be a no-op.
    #[test]
    fn forgetting_a_tab_twice_is_harmless() {
        crate::nav::mark_tab_has_content(4243);
        super::forget_closed_tab(4243);
        super::forget_closed_tab(4243);
        super::forget_closed_tab(999_999);
        assert!(!crate::nav::tab_has_content(4243));
    }
}
