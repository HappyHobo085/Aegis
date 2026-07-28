//! Split-view state machine. Manages a multi-pane layout (2-4 content webviews
//! side-by-side) with equal-width initial sizing, resize, and focus tracking.
//!
//! The actual webview positioning is platform-specific and currently only
//! implemented on Windows (`view.rs`). Linux and macOS have no split layout
//! code — entering a split on those platforms updates the state but leaves
//! webviews overlapping. Android does not support split-view.
//! The layout is driven by the `split.state` event. This module owns only the
//! data model and the IPC dispatch.

use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager, Runtime};

/// One pane in the split layout.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct SplitPane {
    pub tab_id: u32,
    pub width: f64,
    pub height: f64,
    pub x: f64,
    pub y: f64,
}

/// The full split layout. Empty `panes` means split mode is inactive.
#[derive(Clone, Debug, Serialize, Deserialize, Default, PartialEq)]
pub struct SplitLayout {
    pub panes: Vec<SplitPane>,
    pub focused_pane_id: u32,
}

/// Managed state: wraps the current split layout in a `Mutex`.
pub struct SplitState {
    pub inner: Mutex<SplitLayout>,
}

impl Default for SplitState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(SplitLayout::default()),
        }
    }
}

/// Serialize the current layout to a JSON value. `Value::Null` when no split
/// is active (empty panes).
fn state_value(state: &SplitState) -> Value {
    let inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
    if inner.panes.is_empty() {
        Value::Null
    } else {
        serde_json::to_value(&*inner).unwrap_or(Value::Null)
    }
}

/// Enter split-view mode. `tab_ids` must contain exactly 2-4 tab ids.
/// Panes are laid out as equal-width vertical columns (full available height).
/// The first pane is focused.
fn enter<R: Runtime>(app: &AppHandle<R>, tab_ids: &[u32]) -> Result<Value, String> {
    if tab_ids.len() < 2 || tab_ids.len() > 4 {
        return Err("split.enter requires 2 to 4 tab ids".into());
    }

    // Check for duplicate tab ids.
    let mut seen = std::collections::HashSet::new();
    for &id in tab_ids {
        if !seen.insert(id) {
            return Err(format!("duplicate tab id {id} in split.enter"));
        }
    }

    let pane_count = tab_ids.len() as f64;
    let width = 1.0 / pane_count; // fraction of available content width

    let panes: Vec<SplitPane> = tab_ids
        .iter()
        .enumerate()
        .map(|(i, &tab_id)| SplitPane {
            tab_id,
            width,
            height: 1.0, // full height
            x: i as f64 / pane_count,
            y: 0.0,
        })
        .collect();

    let focused_pane_id = tab_ids[0];

    {
        let state = app.state::<SplitState>();
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        *inner = SplitLayout {
            panes,
            focused_pane_id,
        };
    }

    let state = app.state::<SplitState>();
    let payload = state_value(&state);
    crate::emit_event(app, "split.state", &payload);

    Ok(payload)
}

/// Exit split-view mode, returning to a single-pane layout.
fn exit<R: Runtime>(app: &AppHandle<R>) -> Result<Value, String> {
    {
        let state = app.state::<SplitState>();
        let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());
        *inner = SplitLayout::default();
    }

    let state = app.state::<SplitState>();
    let payload = state_value(&state);
    crate::emit_event(app, "split.state", &payload);

    Ok(payload)
}

/// Resize a pane. The `pane_id` is the tab id of the pane to resize.
/// Width and height are fractions of the available content area (0.0-1.0).
fn resize<R: Runtime>(
    app: &AppHandle<R>,
    pane_id: u32,
    width: f64,
    height: f64,
) -> Result<Value, String> {
    let state = app.state::<SplitState>();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    if inner.panes.is_empty() {
        return Err("no active split layout to resize".into());
    }

    let pane = inner
        .panes
        .iter_mut()
        .find(|p| p.tab_id == pane_id)
        .ok_or_else(|| format!("pane with tab id {pane_id} not found in split layout"))?;

    pane.width = width.clamp(0.05, 0.95);
    pane.height = height.clamp(0.05, 1.0);

    // Normalize widths so they sum to 1.0 — after clamping, the total may drift
    // (e.g. resizing one pane to 0.95 + the other at 0.5 = 1.45, which leaves a
    // gap or overlap). Scale every pane proportionally so no layout gap/overlap.
    let total_w: f64 = inner.panes.iter().map(|p| p.width).sum();
    if total_w > 0.0 && (total_w - 1.0).abs() > f64::EPSILON {
        let scale = 1.0 / total_w;
        for p in &mut inner.panes {
            p.width *= scale;
        }
    }

    // Recompute x positions so panes stay contiguous after a resize.
    let mut x = 0.0;
    for p in &mut inner.panes {
        p.x = x;
        x += p.width;
    }

    drop(inner);

    let state = app.state::<SplitState>();
    let payload = state_value(&state);
    crate::emit_event(app, "split.state", &payload);

    Ok(payload)
}

/// Focus a specific pane (identified by its tab id).
fn focus<R: Runtime>(app: &AppHandle<R>, pane_id: u32) -> Result<Value, String> {
    let state = app.state::<SplitState>();
    let mut inner = state.inner.lock().unwrap_or_else(|e| e.into_inner());

    if inner.panes.is_empty() {
        return Err("no active split layout to focus".into());
    }

    if !inner.panes.iter().any(|p| p.tab_id == pane_id) {
        return Err(format!(
            "pane with tab id {pane_id} not found in split layout"
        ));
    }

    inner.focused_pane_id = pane_id;

    drop(inner);

    let state = app.state::<SplitState>();
    let payload = state_value(&state);
    crate::emit_event(app, "split.state", &payload);

    Ok(payload)
}

/// IPC dispatch for `split.*` channels.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "split.enter" => {
            let ids: Vec<u32> = payload
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|v| v.as_u64().map(|n| n as u32))
                        .collect()
                })
                .unwrap_or_default();
            Some(enter(app, &ids))
        }
        "split.exit" => Some(exit(app)),
        "split.resize" => {
            let pane_id = payload.get("paneId").and_then(Value::as_u64).unwrap_or(0) as u32;
            let width = payload.get("width").and_then(Value::as_f64).unwrap_or(0.5);
            let height = payload.get("height").and_then(Value::as_f64).unwrap_or(1.0);
            Some(resize(app, pane_id, width, height))
        }
        "split.focus" => {
            let pane_id = payload.get("paneId").and_then(Value::as_u64).unwrap_or(0) as u32;
            Some(focus(app, pane_id))
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn test_enter_and_exit() {
        with_tmp_app(|app| {
            // Enter split with 2 tabs.
            let result = enter(app, &[1, 2]);
            assert!(result.is_ok(), "enter with 2 tabs should succeed");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            assert_eq!(inner.panes.len(), 2, "should have 2 panes");
            assert_eq!(inner.focused_pane_id, 1, "first pane should be focused");
            assert_eq!(inner.panes[0].tab_id, 1);
            assert_eq!(inner.panes[1].tab_id, 2);
            // Equal width split: each pane gets 0.5 of the width.
            assert!((inner.panes[0].width - 0.5).abs() < f64::EPSILON);
            assert!((inner.panes[1].width - 0.5).abs() < f64::EPSILON);
            // X positions: first at 0, second at 0.5.
            assert!((inner.panes[0].x).abs() < f64::EPSILON);
            assert!((inner.panes[1].x - 0.5).abs() < f64::EPSILON);
            drop(inner);

            // Exit split.
            let result = exit(app);
            assert!(result.is_ok(), "exit should succeed");
            assert!(result.unwrap() == Value::Null, "exit should return null");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            assert!(inner.panes.is_empty(), "panes should be empty after exit");
        });
    }

    #[test]
    fn test_resize() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();

            let result = resize(app, 1, 0.3, 1.0);
            assert!(result.is_ok(), "resize should succeed");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            // After normalization, widths sum to 1.0 and proportions are preserved.
            // pane1: 0.3/0.8 = 0.375, pane2: 0.5/0.8 = 0.625
            let total_w: f64 = inner.panes.iter().map(|p| p.width).sum();
            assert!(
                (total_w - 1.0).abs() < f64::EPSILON,
                "widths must sum to 1.0"
            );
            let pane = inner.panes.iter().find(|p| p.tab_id == 1).unwrap();
            assert!((pane.width - 0.375).abs() < f64::EPSILON);
            assert!((pane.height - 1.0).abs() < f64::EPSILON);
            // X positions recomputed: pane 1 at 0, pane 2 at 0.375.
            assert!((inner.panes[0].x).abs() < f64::EPSILON);
            assert!((inner.panes[1].x - 0.375).abs() < f64::EPSILON);
        });
    }

    #[test]
    fn test_focus() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();

            let result = focus(app, 2);
            assert!(result.is_ok(), "focus should succeed");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            assert_eq!(inner.focused_pane_id, 2);
        });
    }

    #[test]
    fn test_invalid_tab_count_too_few() {
        with_tmp_app(|app| {
            let result = enter(app, &[1]);
            assert!(result.is_err(), "enter with 1 tab should fail");
            assert!(result.unwrap_err().contains("2 to 4"));
        });
    }

    #[test]
    fn test_invalid_tab_count_too_many() {
        with_tmp_app(|app| {
            let result = enter(app, &[1, 2, 3, 4, 5]);
            assert!(result.is_err(), "enter with 5 tabs should fail");
            assert!(result.unwrap_err().contains("2 to 4"));
        });
    }

    #[test]
    fn test_empty_tab_list() {
        with_tmp_app(|app| {
            let result = enter(app, &[]);
            assert!(result.is_err(), "enter with 0 tabs should fail");
        });
    }

    #[test]
    fn test_duplicate_tab_ids() {
        with_tmp_app(|app| {
            let result = enter(app, &[1, 1]);
            assert!(result.is_err(), "enter with duplicate ids should fail");
            assert!(result.unwrap_err().contains("duplicate"));
        });
    }

    #[test]
    fn test_enter_three_panes() {
        with_tmp_app(|app| {
            let result = enter(app, &[1, 2, 3]);
            assert!(result.is_ok(), "enter with 3 tabs should succeed");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            assert_eq!(inner.panes.len(), 3);
            // Each pane gets 1/3 of the width.
            assert!((inner.panes[0].width - 1.0 / 3.0).abs() < f64::EPSILON);
            assert!((inner.panes[1].width - 1.0 / 3.0).abs() < f64::EPSILON);
            assert!((inner.panes[2].width - 1.0 / 3.0).abs() < f64::EPSILON);
        });
    }

    #[test]
    fn test_enter_four_panes() {
        with_tmp_app(|app| {
            let result = enter(app, &[10, 20, 30, 40]);
            assert!(result.is_ok(), "enter with 4 tabs should succeed");

            let state = app.state::<SplitState>();
            let inner = state.inner.lock().unwrap();
            assert_eq!(inner.panes.len(), 4);
            // Each pane gets 0.25 width.
            assert!((inner.panes[0].width - 0.25).abs() < f64::EPSILON);
            assert_eq!(inner.focused_pane_id, 10);
        });
    }

    #[test]
    fn test_dispatch_enter() {
        with_tmp_app(|app| {
            let payload = serde_json::json!([1, 2]);
            let result = dispatch(app, "split.enter", &payload);
            assert!(result.is_some());
            assert!(result.unwrap().is_ok());
        });
    }

    #[test]
    fn test_dispatch_exit() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();
            let result = dispatch(app, "split.exit", &Value::Null);
            assert!(result.is_some());
            assert!(result.unwrap().is_ok());
        });
    }

    #[test]
    fn test_dispatch_resize() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();
            let payload = serde_json::json!({"paneId": 1, "width": 0.4, "height": 0.8});
            let result = dispatch(app, "split.resize", &payload);
            assert!(result.is_some());
            assert!(result.unwrap().is_ok());
        });
    }

    #[test]
    fn test_dispatch_focus() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();
            let payload = serde_json::json!({"paneId": 2});
            let result = dispatch(app, "split.focus", &payload);
            assert!(result.is_some());
            assert!(result.unwrap().is_ok());
        });
    }

    #[test]
    fn test_dispatch_unknown_channel_returns_none() {
        with_tmp_app(|app| {
            let result = dispatch(app, "split.unknown", &Value::Null);
            assert!(result.is_none());
        });
    }

    #[test]
    fn test_focus_nonexistent_pane() {
        with_tmp_app(|app| {
            enter(app, &[1, 2]).unwrap();
            let result = focus(app, 999);
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("not found"));
        });
    }

    #[test]
    fn test_resize_no_active_layout() {
        with_tmp_app(|app| {
            let result = resize(app, 1, 0.5, 1.0);
            assert!(result.is_err());
            assert!(result.unwrap_err().contains("no active split"));
        });
    }
}
