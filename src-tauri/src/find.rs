// Find-in-page dispatcher (PLACE 2). Routes `find.*` channels to per-platform
// native find implementations. Returns `None` for non-find channels.
// Real implementations: Task 6 (Linux), Task 7 (Windows), Task 8 (macOS).

use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::HashMap;
#[cfg(any(windows, test))]
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager, Runtime};

/// The live find query per tab, for platforms whose native find API cannot read
/// the term back.
///
/// The renderer treats `find.state` as an authoritative SNAPSHOT: `useFind`'s
/// `onState` does a whole-state `setState(s)`, not a merge. So every emit must
/// carry the query the user is actually typing, or it blanks the FindBar input.
///
/// Linux (`find_linux`) reads `search_text()` off the WebKit controller and
/// macOS (`find_mac`) keeps the owned query it was started with, so neither
/// needs this. **WebView2's `ICoreWebView2Find` is one-way** — it has `Stop`,
/// `FindNext`, `MatchCount` and `ActiveMatchIndex` but no term getter — so
/// `find_win` is the one platform that must remember the query itself, and its
/// two change handlers are installed ONCE at spawn, long before the query
/// exists. Hence the store lives here rather than in the windows-only module:
/// a store that only existed on one target would have no test that could ever
/// run on a Linux CI runner.
#[cfg(any(windows, test))]
static FIND_QUERIES: OnceLock<Mutex<HashMap<u32, String>>> = OnceLock::new();

#[cfg(any(windows, test))]
fn find_queries() -> &'static Mutex<HashMap<u32, String>> {
    FIND_QUERIES.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Record the live query for `id`, replacing any previous one.
#[cfg(any(windows, test))]
pub(crate) fn note_query(id: u32, query: &str) {
    let mut q = find_queries().lock().unwrap_or_else(|e| e.into_inner());
    q.insert(id, query.to_string());
}

/// The query a `find.state` emit for `id` must carry, or `""` when no find
/// session is running for that tab.
///
/// Empty for a tab with no recorded session is deliberate: it is exactly what
/// the emitting platform did before this store existed, so a change event that
/// arrives after the session was torn down degrades to the old behaviour
/// instead of resurrecting a stale term.
#[cfg(any(windows, test))]
pub(crate) fn live_query(id: u32) -> String {
    let q = find_queries().lock().unwrap_or_else(|e| e.into_inner());
    q.get(&id).cloned().unwrap_or_default()
}

/// Drop the recorded query for `id`. Called on `find.close` and when a
/// `find.start` with an empty query stops the session.
#[cfg(any(windows, test))]
pub(crate) fn forget_query(id: u32) {
    let mut q = find_queries().lock().unwrap_or_else(|e| e.into_inner());
    q.remove(&id);
}

/// Returns true iff `channel` is one of the four find channels.
/// AppHandle-free so it can be unit-tested directly.
#[allow(dead_code)] // pub fn called from platform find modules — lib-crate analysis can't trace cross-platform dispatch
pub fn is_find_channel(channel: &str) -> bool {
    matches!(
        channel,
        "find.start" | "find.next" | "find.prev" | "find.close"
    )
}

/// Handle `find.*` channels. Returns `None` if `channel` is not a find channel.
///
/// PLACE 2 of the three-place rule: the channel names live in
/// `shared/types.ts` and the renderer calls them through `ipcClient`, and
/// `lib.rs`'s `ipc()` is the only caller (`if let Some(result) =
/// find::dispatch(&app, &channel, &payload)`), which infers `R = Wry`.
///
/// Generic over `R: Runtime` **only** so the whole chain is drivable from a
/// `MockRuntime` test. Nothing in it is runtime-specific — every arm reaches
/// the page through `Manager::get_webview` (which returns `None` on the mock,
/// so the platform modules take their "no such webview" arm) and reports
/// through `emit_state`, which is a plain `Manager::emit`. The concrete
/// `&AppHandle` this replaced meant no test could call it at all, which is how
/// the target-tab resolution below went unexercised on every platform.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    // Resolve the target tab id (default = active), mirroring the pattern in nav::dispatch
    // (nav.rs lines 468-472: try_state::<Tabs>().map(active_id).unwrap_or(1)).
    let id = payload
        .get("viewId")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .unwrap_or_else(|| {
            app.try_state::<crate::tabs::Tabs>()
                .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
                .unwrap_or(1)
        });

    let res: Result<Value, String> = match channel {
        "find.start" => {
            let q = payload
                .get("query")
                .and_then(Value::as_str)
                .unwrap_or("")
                .to_string();
            let cs = payload
                .get("caseSensitive")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            start(app, id, &q, cs);
            Ok(Value::Null)
        }
        "find.next" => {
            next(app, id);
            Ok(Value::Null)
        }
        "find.prev" => {
            prev(app, id);
            Ok(Value::Null)
        }
        "find.close" => {
            close(app, id);
            Ok(Value::Null)
        }
        _ => return None,
    };
    Some(res)
}

/// Emit a find.state snapshot to the chrome (dotted name; emit_event rewrites .→:).
/// Called by Tasks 6-8 platform modules once native find delivers match counts.
// Linux: find_linux (Task 6). Windows: find_win (Task 7). macOS: find_mac (Task 8).
// Android: find is handled natively in Kotlin (no Rust caller), so dead_code is
// expected there; suppress it only on android, not on the three desktop targets.
///
/// # Contract: every emit must carry the LIVE query
///
/// `useFind`'s `onState` handler does a whole-state `setState(s)` — it REPLACES
/// the renderer state, it does not merge. `query` is a field of that snapshot,
/// so emitting `""` does not mean "I have no query to report", it means "clear
/// the text the user is typing". A platform whose change handlers fire
/// independently of `find.start` (WebView2's `MatchCountChanged`, ~120ms after
/// each keystroke) must therefore read the live query, not a hardcoded empty
/// string. See `live_query` (cfg: windows or test — its only callers are the
/// WebView2 change handlers).
#[cfg_attr(target_os = "android", allow(dead_code))]
pub(crate) fn emit_state<R: Runtime>(
    app: &AppHandle<R>,
    view_id: u32,
    query: &str,
    match_count: u32,
    active: u32,
) {
    crate::emit_event(
        app,
        "find.state",
        serde_json::json!({
            "viewId": view_id,
            "query": query,
            "matchCount": match_count,
            "activeMatchIndex": active,
        }),
    );
}

// Platform dispatch: each is a thin cfg-routed call into the per-platform module.
fn start<R: Runtime>(app: &AppHandle<R>, id: u32, query: &str, case_sensitive: bool) {
    #[cfg(target_os = "linux")]
    crate::find_linux::start(app, id, query, case_sensitive);
    #[cfg(target_os = "windows")]
    crate::find_win::start(app, id, query, case_sensitive);
    #[cfg(target_os = "macos")]
    crate::find_mac::start(app, id, query, case_sensitive);
    // Suppress "unused" warnings on platforms where cfg blocks don't expand.
    let _ = (app, id, query, case_sensitive);
}

fn next<R: Runtime>(app: &AppHandle<R>, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::next(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::next(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::next(app, id);
    let _ = (app, id);
}

fn prev<R: Runtime>(app: &AppHandle<R>, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::prev(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::prev(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::prev(app, id);
    let _ = (app, id);
}

fn close<R: Runtime>(app: &AppHandle<R>, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::close(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::close(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::close(app, id);
    let _ = (app, id);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;
    use serde_json::json;
    use std::sync::mpsc;
    use tauri::Listener;

    /// Drive one find channel and return what the dispatcher answered.
    fn find_call<R: Runtime>(app: &AppHandle<R>, channel: &str, payload: Value) -> Value {
        dispatch(app, channel, &payload)
            .unwrap_or_else(|| panic!("`{channel}` must be routed here, not fall through"))
            .unwrap_or_else(|e| panic!("`{channel}` must not fail, it reported: {e}"))
    }

    /// Collect every `find.state` the platform reports from here on. The Rust
    /// listener callback runs synchronously inside `emit`, so this is
    /// definitive the moment the call under test returns — no timeout needed.
    fn watch_states<R: Runtime>(app: &AppHandle<R>) -> mpsc::Receiver<Value> {
        let (tx, rx) = mpsc::channel();
        let _id = app.listen("find:state", move |e| {
            let _ = tx.send(
                serde_json::from_str::<Value>(e.payload()).expect("a find.state payload is JSON"),
            );
        });
        rx
    }

    fn next_state(rx: &mpsc::Receiver<Value>) -> Value {
        rx.try_recv()
            .expect("the platform must have reported a find.state")
    }

    /// Open a second tab and make it active, returning `(new, previous active)`.
    /// `with_tmp_app` hands out a single-tab registry, and a one-tab fixture
    /// cannot tell "honoured the viewId" from "always used the active tab".
    fn add_active_tab<R: Runtime>(app: &AppHandle<R>) -> (u32, u32) {
        let tabs = app.state::<crate::tabs::Tabs>();
        let mut reg = tabs.reg.lock().unwrap_or_else(|e| e.into_inner());
        let previous = reg.active_id();
        let (id, _) = reg.create(Some("https://second.test/".into()), false, 1);
        (id, previous)
    }

    #[test]
    fn find_dispatch_declines_every_channel_it_does_not_own() {
        with_tmp_app(|app| {
            for name in [
                "find",
                "find.",
                "find.startx",
                "findstate",
                // The EVENT name. Answering it here would let a `find.state`
                // round-trip look like a request the core had handled.
                "find.state",
                "find.Start",
                "nav.navigate",
                "settings.get",
                "",
            ] {
                assert!(
                    dispatch(app, name, &Value::Null).is_none(),
                    "`{name}` is not a find channel and must fall through to the next dispatcher"
                );
            }
        });
    }

    /// The dispatcher is a router: a match count is only ever real if the
    /// platform's change signal produced it. And the renderer REPLACES its whole
    /// find state on every event, so a `("", 0, 0)` invented here is not "no
    /// news" — it is "clear the term the user is typing".
    ///
    /// Honest limit: a `MockRuntime` has no content webview, so each platform
    /// module returns at its first line and the work itself is unreachable from
    /// this test. What is pinned is the invariant that lives in *this* file.
    #[test]
    fn the_dispatcher_never_invents_a_find_state_of_its_own() {
        with_tmp_app(|app| {
            let rx = watch_states(app);
            for channel in ["find.start", "find.next", "find.prev"] {
                let reply = find_call(
                    app,
                    channel,
                    json!({ "query": "needle", "caseSensitive": true }),
                );
                assert!(
                    reply.is_null(),
                    "`{channel}` answers no value of its own; the state arrives as an event"
                );
            }
            assert!(
                rx.try_recv().is_err(),
                "find.start/next/prev must report no state themselves — the count comes from \
                 the platform's found-text / MatchCountChanged handler, and a fabricated \
                 zero-match event would wipe the term in the FindBar"
            );
        });
    }

    /// The target tab. An explicit `viewId` must win, and its absence must mean
    /// the ACTIVE tab — which is not tab 1 once a second tab exists, so a
    /// hardcoded default could not pass this. Nothing pinned any of it: the
    /// concrete `&AppHandle` meant no test had ever resolved a target.
    #[test]
    fn a_find_channel_acts_on_the_tab_it_names_and_on_the_active_tab_by_default() {
        with_tmp_app(|app| {
            let (second, first) = add_active_tab(app);
            assert_ne!(
                first, second,
                "the fixture must be able to tell two tabs apart"
            );

            // No viewId: the ACTIVE tab.
            let rx = watch_states(app);
            find_call(app, "find.close", json!({}));
            assert_eq!(
                next_state(&rx)["viewId"],
                json!(second),
                "with no viewId a find channel acts on the ACTIVE tab, which here is the \
                 second tab — a hardcoded default would name the first"
            );
            assert!(rx.try_recv().is_err(), "one close reports one reset");

            // An explicit viewId: that tab, not the active one.
            let rx = watch_states(app);
            find_call(app, "find.close", json!({ "viewId": first }));
            let s = next_state(&rx);
            assert_eq!(
                s["viewId"],
                json!(first),
                "an explicit viewId must win over the active tab"
            );
            assert_eq!(
                s["query"],
                json!(""),
                "close is what clears the term, and the renderer replaces the whole state"
            );
            assert_eq!(s["matchCount"], json!(0));
            assert_eq!(s["activeMatchIndex"], json!(0));
            assert!(
                rx.try_recv().is_err(),
                "closing one tab must not reset another tab's FindBar"
            );

            // A viewId for a tab that does not exist is still what was asked for.
            let rx = watch_states(app);
            find_call(app, "find.close", json!({ "viewId": 4242 }));
            assert_eq!(
                next_state(&rx)["viewId"],
                json!(4242),
                "a stale viewId is honoured as given; silently redirecting it at the active \
                 tab would close a find session the user never asked to close"
            );

            // A viewId that is not a tab id at all falls back to the active tab.
            let rx = watch_states(app);
            find_call(app, "find.close", json!({ "viewId": "second" }));
            assert_eq!(
                next_state(&rx)["viewId"],
                json!(second),
                "a viewId that is not a number is not a tab id"
            );
        });
    }

    #[test]
    fn find_channels_recognized() {
        assert!(is_find_channel("find.start"));
        assert!(is_find_channel("find.next"));
        assert!(is_find_channel("find.prev"));
        assert!(is_find_channel("find.close"));
    }

    #[test]
    fn non_find_channel_rejected() {
        assert!(!is_find_channel("settings.get"));
        assert!(!is_find_channel("nav.navigate"));
        assert!(!is_find_channel("find."));
        assert!(!is_find_channel(""));
    }

    /// The store the one-way WebView2 find API forces us to keep: the query a
    /// change event must report is the one `find.start` recorded.
    #[test]
    fn a_change_event_reports_the_query_start_recorded_not_an_empty_one() {
        note_query(7, "needle");
        assert_eq!(live_query(7), "needle", "an emit must carry the live query");
        // Re-starting replaces, never appends — the store is a snapshot, like the
        // state the renderer replaces wholesale.
        note_query(7, "haystack");
        assert_eq!(live_query(7), "haystack");
    }

    /// Per-tab, because the two change handlers are installed per tab and
    /// `find.close` on a background tab must not disturb the active one.
    #[test]
    fn the_recorded_query_is_per_tab() {
        note_query(1, "alpha");
        note_query(2, "beta");
        assert_eq!(live_query(1), "alpha");
        assert_eq!(live_query(2), "beta");
        forget_query(1);
        assert_eq!(live_query(1), "", "a closed session reports nothing");
        assert_eq!(
            live_query(2),
            "beta",
            "closing one tab must not touch another"
        );
        forget_query(1); // idempotent: find.close can arrive twice
        forget_query(99); // unknown tab must not panic
    }

    /// A change event for a tab with no session must degrade to what the
    /// platform used to emit, not to a stale term from a torn-down session.
    #[test]
    fn a_tab_with_no_find_session_reports_an_empty_query() {
        assert_eq!(live_query(4242), "");
    }
}
