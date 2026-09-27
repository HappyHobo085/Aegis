// Find-in-page dispatcher (PLACE 2). Routes `find.*` channels to per-platform
// native find implementations. Returns `None` for non-find channels.
// Real implementations: Task 6 (Linux), Task 7 (Windows), Task 8 (macOS).

use serde_json::Value;
#[cfg(any(windows, test))]
use std::collections::HashMap;
#[cfg(any(windows, test))]
use std::sync::{Mutex, OnceLock};
use tauri::{AppHandle, Manager};

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
pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
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
pub(crate) fn emit_state(
    app: &AppHandle,
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
fn start(app: &AppHandle, id: u32, query: &str, case_sensitive: bool) {
    #[cfg(target_os = "linux")]
    crate::find_linux::start(app, id, query, case_sensitive);
    #[cfg(target_os = "windows")]
    crate::find_win::start(app, id, query, case_sensitive);
    #[cfg(target_os = "macos")]
    crate::find_mac::start(app, id, query, case_sensitive);
    // Suppress "unused" warnings on platforms where cfg blocks don't expand.
    let _ = (app, id, query, case_sensitive);
}

fn next(app: &AppHandle, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::next(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::next(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::next(app, id);
    let _ = (app, id);
}

fn prev(app: &AppHandle, id: u32) {
    #[cfg(target_os = "linux")]
    crate::find_linux::prev(app, id);
    #[cfg(target_os = "windows")]
    crate::find_win::prev(app, id);
    #[cfg(target_os = "macos")]
    crate::find_mac::prev(app, id);
    let _ = (app, id);
}

fn close(app: &AppHandle, id: u32) {
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
