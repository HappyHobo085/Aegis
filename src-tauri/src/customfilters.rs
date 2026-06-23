//! User custom filter rules (customFilters.* IPC). Persisted as text in the app
//! data dir and folded into the ad-block engine alongside EasyList (see
//! install_adblock), so the user's rules actually block.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("custom-filters.txt"))
}

/// Sidecar holding the SINGLE sync record for the custom-filter text: `{uuid, text, hlc,
/// deleted}`. The plain `.txt` stays the source of truth for the engine; this projection
/// (kept in sync by `write`) is what the sync layer ships, so the renderer-visible text
/// format is untouched. F2b merges this single record specially (not via the array merge).
fn sync_path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("custom-filters-sync.json"))
}

/// The user's custom filter-list text (empty if none). Plain text, not JSON, so a
/// corrupt/empty primary falls back to custom-filters.txt.bak (no structural check).
pub fn load(app: &AppHandle) -> String {
    path(app)
        .and_then(|p| crate::jsonstore::read_text_with_backup(&p))
        .unwrap_or_default()
}

/// Fixed sync identity for the single custom-filter record — deterministic so every
/// device's record shares ONE server identity (HLC-LWW dedups; no per-device orphans).
const CUSTOM_FILTERS_UUID: &str = "custom-filters";

/// Update the single sync record after the `.txt` is written, bumping its HLC so peers pick
/// up the change. Done in `write` (not just the `set` dispatch) so picker-added rules
/// (picker.rs calls `write`) and imports also sync.
fn stamp_sync_record(app: &AppHandle, text: &str) {
    let Some(p) = sync_path(app) else { return };
    let node = crate::sync_identity::node_id(app);
    let hlc = crate::sync_envelope::tick(&node, crate::jsonstore::now_ms());
    let rec = json!({
        "uuid": CUSTOM_FILTERS_UUID,
        "text": text,
        "hlc": serde_json::to_value(&hlc).unwrap_or(Value::Null),
        "deleted": false,
    });
    let txt = serde_json::to_string_pretty(&rec).unwrap_or_default();
    let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
}

/// The single custom-filter sync record (synthesized from the current text with a FLOOR
/// HLC if none exists yet, so any genuine edit on any device dominates the migration seed).
/// Read by the sync engine for the `customFilters` namespace.
pub fn sync_record(app: &AppHandle) -> Value {
    if let Some(rec) = sync_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
    {
        return rec;
    }
    let node = crate::sync_identity::node_id(app);
    json!({
        "uuid": CUSTOM_FILTERS_UUID,
        "text": load(app),
        "hlc": serde_json::to_value(crate::sync_envelope::Hlc::zero(&node)).unwrap_or(Value::Null),
        "deleted": false,
    })
}

/// Merge a remote custom-filter record (single-record HLC last-writer-wins). On a win, write
/// the `.txt` to the remote's text (empty if tombstoned), persist the remote record verbatim
/// (keeping its HLC — do NOT re-stamp), and re-apply ad-block. Returns whether it changed.
pub fn merge_remote(app: &AppHandle, remote: &Value) -> bool {
    let Some(rhlc) = crate::sync_envelope::from_value(remote) else {
        return false;
    };
    let node = crate::sync_identity::node_id(app);
    crate::sync_envelope::observe(&node, crate::jsonstore::now_ms(), &rhlc);
    let local = sync_record(app);
    let wins = crate::sync_envelope::from_value(&local)
        .map(|lh| rhlc > lh)
        .unwrap_or(true);
    if !wins {
        return false;
    }
    let deleted = remote
        .get("deleted")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let text = if deleted {
        ""
    } else {
        remote.get("text").and_then(Value::as_str).unwrap_or("")
    };
    if let Some(p) = path(app) {
        let _ = crate::jsonstore::write_atomic(&p, text.as_bytes());
    }
    if let Some(sp) = sync_path(app) {
        if let Ok(t) = serde_json::to_string_pretty(remote) {
            let _ = crate::jsonstore::write_atomic(&sp, t.as_bytes());
        }
    }
    crate::adblock_refresh::refresh(app);
    true
}

/// Overwrite the custom filters file + refresh its sync record. Durable (atomic
/// temp→rename + .bak). The single write path for custom filters: the `set` dispatch,
/// data-import, and the element picker all go through here, so all of them stamp the sync
/// record.
pub fn write(app: &AppHandle, text: &str) {
    if let Some(p) = path(app) {
        let _ = crate::jsonstore::write_atomic(&p, text.as_bytes());
    }
    stamp_sync_record(app, text);
}

pub fn dispatch(app: &AppHandle, channel: &str, payload: &Value) -> Option<Result<Value, String>> {
    match channel {
        "customFilters.get" => Some(Ok(json!(load(app)))),
        "customFilters.set" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            // write() persists the .txt durably AND stamps the sync record.
            write(app, text);
            // Re-apply ad-block so the new rules take effect — on every platform.
            crate::adblock_refresh::refresh(app);
            Some(Ok(json!(text)))
        }
        _ => None,
    }
}
