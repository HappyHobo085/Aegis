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
    let s: TabsState = app.state::<Tabs>().reg.lock().unwrap().tabs_state();
    serde_json::to_value(s).unwrap_or(Value::Null)
}

/// Emit `tabs.state` + persist the session.
fn emit_and_persist<R: Runtime>(app: &AppHandle<R>) {
    crate::emit_event(app, "tabs.state", state_value(app));
    persist(app);
}

fn record_nav<R: Runtime>(app: &AppHandle<R>, id: u32, url: &str, title: &str) {
    {
        let tabs = app.state::<Tabs>();
        let mut reg = tabs.reg.lock().unwrap();
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
pub fn on_tab_url<R: Runtime>(app: &AppHandle<R>, id: u32, url: &str) {
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg.lock().unwrap().record_nav(id, url);
    }
    emit_and_persist(app);
}

/// Record a tab's page title (from the WebKit title-changed signal). Updates the
/// strip + persists it so restored "asleep" tabs show their title.
#[allow(dead_code)] // only called from the Linux WebKit title-changed signal (linux_layout)
pub fn on_tab_title<R: Runtime>(app: &AppHandle<R>, id: u32, title: &str) {
    if let Some(s) = app.try_state::<Tabs>() {
        s.reg.lock().unwrap().set_title(id, title.to_string());
    }
    emit_and_persist(app);
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
                eprintln!("[aegis] spawn_tab({id}) failed: {e}");
                return;
            }
            let app_layout = app.clone();
            let _ = app.run_on_main_thread(move || crate::view::apply_inset(&app_layout));
        });
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = crate::nav::spawn_tab(app, id, u, private);
    }
}

/// Whether tab `id` is a private (incognito) tab. Defaults to false for an unknown id.
pub fn is_private<R: Runtime>(app: &AppHandle<R>, id: u32) -> bool {
    app.try_state::<Tabs>()
        .and_then(|s| s.reg.lock().unwrap().is_private(id))
        .unwrap_or(false)
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
            let url = payload
                .get("url")
                .and_then(Value::as_str)
                .map(str::to_string);
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
                .unwrap()
                .create_private(url, background, now, private);
            spawn(app, id, &u, private);
            crate::view::apply_inset(app); // show the active tab (unchanged when background)
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.activate" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let to_spawn = app.state::<Tabs>().reg.lock().unwrap().activate(id, now);
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
            let out = app.state::<Tabs>().reg.lock().unwrap().close(id, now);
            if out.closed_live {
                close_webview(app, id);
            }
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
            let reopened = app.state::<Tabs>().reg.lock().unwrap().reopen_closed(now);
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
                .unwrap()
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
            app.state::<Tabs>().reg.lock().unwrap().reorder(&ids);
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
            app.state::<Tabs>().reg.lock().unwrap().set_title(id, title);
            emit_and_persist(app);
            Some(Ok(state_value(app)))
        }
        "tabs.recordNav" => {
            let id = payload.get("id").and_then(Value::as_u64).unwrap_or(0) as u32;
            let url = payload.get("url").and_then(Value::as_str).unwrap_or("");
            let title = payload.get("title").and_then(Value::as_str).unwrap_or("");
            record_nav(app, id, url, title);
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
        // Neighbor respawn: private tabs are exempt from the idle sweep, so any
        // discarded neighbor is always non-private; read from registry for safety.
        let private = is_private(app, nid);
        spawn(app, nid, &u, private);
    }
    crate::nav::forget_tab_content(id);
    crate::view::apply_inset(app);
    emit_and_persist(app);
}

/// Open a URL in a new BACKGROUND tab (from on_new_window / Ctrl-click). Spawns
/// the webview, emits state + persists, but does NOT change the active tab.
/// A popup from a private tab inherits privateness (`private = true`).
pub fn open_background(app: &AppHandle, url: &str, private: bool) {
    let now = now_ms(app);
    let (id, u) = app.state::<Tabs>().reg.lock().unwrap().create_private(
        Some(url.to_string()),
        true,
        now,
        private,
    );
    spawn(app, id, &u, private);
    emit_and_persist(app);
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
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(30));
        let timeout_ms = crate::settings::tab_idle_timeout_min(&app).saturating_mul(60_000);
        if timeout_ms == 0 {
            continue;
        }
        let now = now_ms(&app);
        let victims = match app.try_state::<Tabs>() {
            Some(s) => s.reg.lock().unwrap().sweep_idle(now, timeout_ms),
            None => continue,
        };
        if victims.is_empty() {
            continue;
        }
        let app2 = app.clone();
        let _ = app.run_on_main_thread(move || {
            for id in &victims {
                close_webview(&app2, *id);
            }
            emit_and_persist(&app2); // strip re-renders the discarded tabs as "asleep"
        });
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
                let mut reg = tabs.reg.lock().unwrap();
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
                let reg = tabs.reg.lock().unwrap();
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
                let mut reg = tabs.reg.lock().unwrap();
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
            let reg = state.reg.lock().unwrap();
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
                let mut reg = tabs.reg.lock().unwrap();
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
                let mut reg = tabs.reg.lock().unwrap();
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
                let mut reg = tabs.reg.lock().unwrap();
                let (id, _) = reg.create(Some("https://b.test/".into()), false, 0);
                id
            };

            // Reorder to [id2, 1].
            {
                let tabs = app.state::<Tabs>();
                let mut reg = tabs.reg.lock().unwrap();
                reg.reorder(&[id2, 1]);
            }

            let state = app.state::<Tabs>();
            let reg = state.reg.lock().unwrap();
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
                let mut reg = tabs.reg.lock().unwrap();
                // create_private(url, background, now_ms, private=true)
                reg.create_private(Some("https://private.test/".into()), false, 0, true);
            }

            // is_private returns true for the new tab; we check by inspecting the registry.
            let private_id = {
                let tabs = app.state::<Tabs>();
                let reg = tabs.reg.lock().unwrap();
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
}
