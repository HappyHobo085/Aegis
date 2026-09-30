//! Page zoom (zoom.* IPC). v1 is SESSION-ONLY: the factor is held in an in-memory
//! per-tab map (NOT persisted, NOT per-origin — see the design doc §"persistence
//! decision"). The core owns the canonical value so a discarded→reloaded tab keeps
//! its zoom (replayed at spawn via `apply_to_tab`). v2 (per-origin) can layer a disk
//! store + a main-frame-origin re-apply hook WITHOUT changing this IPC surface.
use std::collections::HashMap;
use std::sync::Mutex;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

pub const ZOOM_MIN: f64 = 0.5;
pub const ZOOM_MAX: f64 = 3.0;

#[derive(Default)]
pub struct ZoomStore(pub Mutex<HashMap<u32, f64>>);

/// Drop tab `id`'s stored zoom factor. Called from `tabs::forget_closed_tab`, the one
/// cleanup that runs on every platform, so this per-tab table cannot hand a REUSED id
/// another tab's zoom.
///
/// `ZoomStore` is the SEVENTH table keyed by tab id (after `nav::TABS_WITH_CONTENT`,
/// `nav::TABS_LOADING`, `redirect_guard::NavActions`, `redirect_guard::Chains`,
/// `adblock::PAGE_BLOCKED` and `find::FIND_QUERIES`), and the last one nothing ever
/// removed an entry from. Its cost is visible rather than a slow leak: `apply_to_tab`
/// REPLAYS the stored factor at `nav::spawn_tab`, and `alloc_tab_id` only skips ids
/// still in the registry, so a hand-edited `tabs.json` or a restored backup can hand back
/// a reused id and the reusing tab would open zoomed to the dead tab's factor — with no
/// way for the user to see why.
pub(crate) fn forget_zoom_on_close<R: Runtime>(app: &AppHandle<R>, id: u32) {
    if let Some(s) = app.try_state::<ZoomStore>() {
        s.0.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    }
}

/// Clamp to [ZOOM_MIN, ZOOM_MAX]; non-finite → 1.0. Pure (testable without Tauri).
pub fn clamp(f: f64) -> f64 {
    if !f.is_finite() {
        return 1.0;
    }
    // Use explicit max/min rather than f64::clamp: clamp() propagates NaN (returns NaN
    // if the input is NaN), whereas we already handled non-finite above and want the
    // bounds to be strictly [ZOOM_MIN, ZOOM_MAX]. clippy::manual_clamp is suppressed
    // because the NaN-guard above makes the semantics intentionally different.
    #[allow(clippy::manual_clamp)]
    {
        f.max(ZOOM_MIN).min(ZOOM_MAX)
    }
}

/// The stored factor for tab `id`, or 1.0 if unset.
pub fn factor_of<R: Runtime>(app: &AppHandle<R>, id: u32) -> f64 {
    app.try_state::<ZoomStore>()
        .map(|s| {
            *s.0.lock()
                .unwrap_or_else(|e| e.into_inner())
                .get(&id)
                .unwrap_or(&1.0)
        })
        .unwrap_or(1.0)
}

/// Store + apply a factor to a tab, then emit zoom.changed. Shared by set/reset.
fn put<R: Runtime>(app: &AppHandle<R>, id: u32, factor: f64) -> Value {
    let f = clamp(factor);
    if let Some(s) = app.try_state::<ZoomStore>() {
        s.0.lock().unwrap_or_else(|e| e.into_inner()).insert(id, f);
    }
    apply_native(app, id, f);
    let state = json!({ "viewId": id, "factor": f });
    crate::emit_event(app, "zoom.changed", state.clone());
    state
}

/// Re-apply a tab's stored factor to its (re)spawned webview. Called at the end of
/// `nav::spawn_tab` so a discard→reload keeps the user's zoom. No-op at 1.0.
// On Android the native Kotlin WebView is not reached via spawn_tab (Android uses
// its own bridge); suppress the dead_code lint only for that target.
#[cfg_attr(target_os = "android", allow(dead_code))]
pub fn apply_to_tab<R: Runtime>(app: &AppHandle<R>, id: u32) {
    let f = factor_of(app, id);
    if (f - 1.0).abs() > f64::EPSILON {
        apply_native(app, id, f);
    }
}

/// Per-platform fan-out to the live webview. Each engine's setter is gated; the
/// non-matching arms are no-ops so the lib compiles for every target.
#[allow(unused_variables)]
fn apply_native<R: Runtime>(app: &AppHandle<R>, id: u32, factor: f64) {
    let _ = (app, id, factor); // silence unused on platforms with no setter (none today)
    let label = crate::nav::content_label(id);

    #[cfg(target_os = "linux")]
    crate::linux_layout::set_zoom_level_label(app, &label, factor);

    #[cfg(target_os = "windows")]
    if let Some(content) = app.get_webview(&label) {
        let _ = content.with_webview(move |pw| crate::zoom_win::set(&pw, factor));
    }

    #[cfg(target_os = "macos")]
    if let Some(content) = app.get_webview(&label) {
        let _ = content.with_webview(move |pw| crate::zoom_mac::set(&pw, factor));
    }
    // Android applies in MainActivity (native WebView the Rust core can't reach);
    // the chrome routes zoom.set through the AegisAndroid bridge instead of this dispatch.
}

/// Handle `zoom.*` channels. Returns `None` if not a zoom channel.
///
/// PLACE 2 of the three-place rule: the channel names live in `shared/types.ts`
/// and the renderer calls them through `ipcClient`. The target tab is the
/// payload's `viewId`, defaulting to the ACTIVE tab, so `zoom.get`/`set` are per-tab and
/// a `view.setFullscreen`-style tab switch keeps each tab's own level. Resetting is not a
/// third channel: the renderer sends `zoom.set` with a factor of 1.0.
///
/// Generic over `R: Runtime` so all three arms — the `viewId` defaulting, the
/// `factor` default, and the clamp the chrome relies on — are reachable from a
/// `MockRuntime` test. The only production caller is `lib.rs`'s `ipc()`, which
/// infers `Wry`. The native half (`apply_native`) is honestly unreachable from a
/// test: every platform's setter needs a real content webview, which a mock app
/// does not have, so the observables asserted here are the STORE and the
/// `zoom.changed` event the chrome re-renders from.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    let active = || {
        app.try_state::<crate::tabs::Tabs>()
            .map(|s| s.reg.lock().unwrap_or_else(|e| e.into_inner()).active_id())
            .unwrap_or(1)
    };
    let id = payload
        .get("viewId")
        .and_then(Value::as_u64)
        .map(|n| n as u32)
        .unwrap_or_else(active);
    match channel {
        "zoom.get" => Some(Ok(json!({ "viewId": id, "factor": factor_of(app, id) }))),
        "zoom.set" => {
            let f = payload.get("factor").and_then(Value::as_f64).unwrap_or(1.0);
            Some(Ok(put(app, id, f)))
        }
        // There is deliberately NO `zoom.reset` arm. The renderer's `aegis.zoom.reset`
        // delegates to `zoom.set(viewId, 1.0)` so the clamp lives in exactly one place,
        // so a `zoom.reset` channel had no caller at all: it was declared in
        // `shared/types.ts`, dispatched here, documented, and unit-tested, and nothing in the
        // product could ever emit it. `shared/ipcCatalog.drift.test.ts` direction 5 now fails
        // if a request channel is declared and never named by a renderer source.
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clamp_bounds_and_nonfinite() {
        assert_eq!(clamp(0.1), ZOOM_MIN);
        assert_eq!(clamp(9.0), ZOOM_MAX);
        assert_eq!(clamp(1.25), 1.25);
        assert_eq!(clamp(f64::NAN), 1.0);
        assert_eq!(clamp(f64::INFINITY), 1.0);
    }

    use crate::test_support::with_tmp_app;
    use serde_json::json;
    use tauri::{Listener, Manager};

    /// Route a channel through the dispatcher. Panics naming the channel if the
    /// module DECLINES it, so a test can never quietly pass by getting `None`
    /// for a channel `zoom` owns.
    fn zoom_call<R: Runtime>(app: &AppHandle<R>, channel: &str, payload: &Value) -> Value {
        dispatch(app, channel, payload)
            .unwrap_or_else(|| panic!("zoom::dispatch declined the channel it owns: {channel}"))
            .expect("the arm answers Ok")
    }

    /// The value actually sitting in the per-tab store — read past `factor_of`,
    /// so a test can tell "stored" from "fell back to the 1.0 default".
    fn stored<R: Runtime>(app: &AppHandle<R>, id: u32) -> Option<f64> {
        app.try_state::<ZoomStore>()
            .expect("ZoomStore is managed")
            .0
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .get(&id)
            .copied()
    }

    /// The id the chrome would be talking about: the ACTIVE tab.
    fn active_id<R: Runtime>(app: &AppHandle<R>) -> u32 {
        app.try_state::<crate::tabs::Tabs>()
            .expect("tabs::Tabs is managed")
            .reg
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .active_id()
    }

    #[test]
    fn dispatch_declines_every_channel_it_does_not_own() {
        with_tmp_app(|app| {
            for name in [
                "zoom",
                "zoom.Get", // case matters
                "zoom.getState",
                "zoom.changed", // the EVENT name, not a channel
                "zoom.setAll",
                "view.getState",
                "nav.getState",
                "tabs.list",
            ] {
                assert!(
                    dispatch(app, name, &json!({ "factor": 2.0 })).is_none(),
                    "{name} is not a zoom channel and must be declined so the next \
                     dispatch arm can claim it"
                );
            }
            // A declined channel must not have touched the store on its way out.
            assert_eq!(stored(app, active_id(app)), None);
        });
    }

    #[test]
    fn a_zoom_call_acts_on_the_tab_it_names_and_on_the_active_tab_by_default() {
        with_tmp_app(|app| {
            let active = active_id(app);
            assert_eq!(
                zoom_call(app, "zoom.get", &json!({}))
                    .pointer("/viewId")
                    .and_then(Value::as_u64),
                Some(active as u64),
                "with no viewId the call must answer for the ACTIVE tab"
            );
            // A tab that has never been zoomed reads 100%, which is what `factor_of`
            // promises for an id with no stored row.
            assert_eq!(
                zoom_call(app, "zoom.get", &json!({ "viewId": 4242 }))
                    .pointer("/factor")
                    .and_then(Value::as_f64),
                Some(1.0)
            );
            // Naming another tab must not touch the active one: zoom is PER-TAB, and a
            // router that ignored `viewId` would zoom the tab the user is looking at.
            zoom_call(app, "zoom.set", &json!({ "viewId": 4242, "factor": 1.5 }));
            assert_eq!(stored(app, 4242), Some(1.5));
            assert_eq!(stored(app, active), None);
            assert_eq!(
                zoom_call(app, "zoom.get", &json!({}))
                    .pointer("/factor")
                    .and_then(Value::as_f64),
                Some(1.0),
                "the active tab kept 100% while another tab was zoomed"
            );
        });
    }

    /// Collect the `zoom.changed` events. The wire name carries no dots, and the
    /// `Listener` callback runs synchronously inside `emit`, so a collector
    /// registered before the call is already filled when it returns.
    fn watch_changed<R: Runtime>(app: &AppHandle<R>) -> std::sync::mpsc::Receiver<Value> {
        let (tx, rx) = std::sync::mpsc::channel();
        let _id = app.listen("zoom:changed", move |e| {
            let _ = tx.send(serde_json::from_str(e.payload()).expect("event payload is JSON"));
        });
        rx
    }

    #[test]
    fn a_zoom_set_is_clamped_before_it_is_stored() {
        with_tmp_app(|app| {
            let id = active_id(app);
            for (asked, stored_f) in [(0.1, ZOOM_MIN), (9.0, ZOOM_MAX), (1.25, 1.25)] {
                let answered = zoom_call(app, "zoom.set", &json!({ "factor": asked }));
                assert_eq!(
                    answered.pointer("/factor").and_then(Value::as_f64),
                    Some(stored_f),
                    "{asked} must be clamped to {stored_f} in the ANSWER"
                );
                assert_eq!(
                    stored(app, id),
                    Some(stored_f),
                    "{asked} must be clamped in the STORE, not only in the reply"
                );
            }
            // A missing or non-numeric factor is the renderer's default, not a
            // refusal: the tab must end at 100%, not at NaN or its previous level.
            for payload in [json!({}), json!({ "factor": "big" })] {
                zoom_call(app, "zoom.set", &payload);
                assert_eq!(stored(app, id), Some(1.0), "{payload} must land on 100%");
            }
        });
    }

    #[test]
    fn a_zoom_change_is_told_to_the_chrome_with_the_value_that_was_stored() {
        with_tmp_app(|app| {
            let id = active_id(app);
            let rx = watch_changed(app);
            for asked in [0.1, 2.0, 1.0] {
                zoom_call(app, "zoom.set", &json!({ "factor": asked }));
            }
            // One event per set, each carrying the CLAMPED value and the tab it was for.
            for asked in [0.1, 2.0, 1.0] {
                let ev = rx
                    .recv_timeout(std::time::Duration::from_secs(5))
                    .expect("zoom.set emits zoom.changed");
                let f = ev
                    .pointer("/factor")
                    .and_then(Value::as_f64)
                    .expect("factor");
                assert_eq!(f, clamp(asked), "the event must report the STORED value");
                assert_eq!(
                    ev.pointer("/viewId").and_then(Value::as_u64),
                    Some(id as u64)
                );
            }
            assert!(
                rx.try_recv().is_err(),
                "exactly one event per set, not one per layout pass"
            );
        });
    }

    /// Resetting zoom is `zoom.set` with a factor of 1.0, and it is the path the product
    /// actually takes: `aegis.zoom.reset` in `ipcClient.ts` delegates to `set`. This used to
    /// be asserted through a `zoom.reset` channel that no renderer could emit, so the test
    /// passed while proving nothing about the app; it now drives the channel that is sent,
    /// and still checks what the old one checked — the chrome's indicator has to come back
    /// to 100% without a page reload.
    #[test]
    fn a_zoom_set_to_100_percent_is_told_to_the_chrome_like_any_other_change() {
        with_tmp_app(|app| {
            let id = active_id(app);
            let rx = watch_changed(app);
            zoom_call(app, "zoom.set", &json!({ "factor": 2.0 }));
            let _ = rx.recv_timeout(std::time::Duration::from_secs(5));
            // Exactly what `aegis.zoom.reset(viewId)` sends.
            zoom_call(app, "zoom.set", &json!({ "viewId": id, "factor": 1.0 }));
            let ev = rx
                .recv_timeout(std::time::Duration::from_secs(5))
                .expect("the reset the chrome sends is announced like any other change");
            assert_eq!(ev.pointer("/factor").and_then(Value::as_f64), Some(1.0));
            assert_eq!(
                ev.pointer("/viewId").and_then(Value::as_u64),
                Some(id as u64)
            );
        });
    }

    /// What the old `a_zoom_reset_returns_the_tab_to_100_percent` test checked, re-pointed
    /// at the channel the chrome really sends. Kept as its own test because the store write
    /// is the part that matters: the reply is easy, the tab's own level is what the toolbar
    /// re-renders from, and only one of the two is guaranteed by the answer.
    #[test]
    fn setting_a_tab_to_100_percent_writes_the_store_not_just_the_answer() {
        with_tmp_app(|app| {
            let id = active_id(app);
            zoom_call(app, "zoom.set", &json!({ "factor": 2.0 }));
            assert_eq!(stored(app, id), Some(2.0));
            let answered = zoom_call(app, "zoom.set", &json!({ "viewId": id, "factor": 1.0 }));
            assert_eq!(
                answered.pointer("/factor").and_then(Value::as_f64),
                Some(1.0)
            );
            assert_eq!(
                stored(app, id),
                Some(1.0),
                "reset must write 100% into the store, not just answer it"
            );
            // Idempotent, and still scoped to the tab it was aimed at.
            zoom_call(app, "zoom.set", &json!({ "viewId": 4242, "factor": 1.0 }));
            zoom_call(app, "zoom.set", &json!({ "viewId": 4242, "factor": 1.0 }));
            assert_eq!(stored(app, 4242), Some(1.0));
        });
    }

    /// The hook removes exactly ONE tab's factor, leaves another alone, is idempotent,
    /// and tolerates an unknown id. The OTHER half — that `tabs::forget_closed_tab`, the
    /// one definition both close paths share, actually calls it — is `tabs::tests`'
    /// business, and the split is deliberate: deleting the call in `forget_closed_tab`
    /// must leave THIS test green and turn that one red.
    #[test]
    fn the_tab_close_hook_removes_the_recorded_zoom() {
        with_tmp_app(|app| {
            zoom_call(app, "zoom.set", &json!({ "viewId": 5150, "factor": 2.0 }));
            zoom_call(app, "zoom.set", &json!({ "viewId": 5151, "factor": 0.75 }));
            assert_eq!(stored(app, 5150), Some(2.0), "precondition: 5150 is zoomed");
            assert_eq!(
                stored(app, 5151),
                Some(0.75),
                "precondition: 5151 is zoomed"
            );

            super::forget_zoom_on_close(app, 5150);

            assert_eq!(
                stored(app, 5150),
                None,
                "a closed id left in the zoom store is replayed at spawn, so the reusing \
                 tab opens zoomed to the dead tab's factor"
            );
            assert_eq!(
                stored(app, 5151),
                Some(0.75),
                "closing one tab must not clear another tab's zoom"
            );
            // Idempotent, and an id that was never zoomed is harmless.
            super::forget_zoom_on_close(app, 5150);
            super::forget_zoom_on_close(app, 999_999);
            assert_eq!(stored(app, 5150), None);
        });
    }
}
