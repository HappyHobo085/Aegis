//! Stable per-install device node id for the HLC `node` field. Persisted in
//! `sync-device.json` (a fresh v4 UUID on first run), cached in a `OnceLock`.
//!
//! NOTE (F2b coupling): when the Ed25519 device signing key lands (Phase 3), the node id
//! should become that key's public-key fingerprint and live in THIS file — pick one owner
//! so there aren't two device-id files. Today it's a plain UUID.
use std::path::PathBuf;
use std::sync::OnceLock;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

static NODE_ID: OnceLock<String> = OnceLock::new();

fn path(app: &AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("sync-device.json"))
}

/// This device's stable node id (read-or-create). The HLC `node` and (later) the sync
/// device identity key off this.
pub fn node_id(app: &AppHandle) -> String {
    NODE_ID
        .get_or_init(|| {
            if let Some(p) = path(app) {
                if let Some(id) = crate::jsonstore::read_with_backup(&p)
                    .and_then(|t| serde_json::from_str::<Value>(&t).ok())
                    .and_then(|v| v.get("nodeId").and_then(Value::as_str).map(String::from))
                    .filter(|id| !id.is_empty())
                {
                    return id;
                }
                let id = uuid::Uuid::new_v4().to_string();
                let txt = serde_json::to_string_pretty(&json!({ "nodeId": id })).unwrap_or_default();
                let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
                return id;
            }
            // No app data dir (shouldn't happen) — a random, non-persisted id.
            uuid::Uuid::new_v4().to_string()
        })
        .clone()
}
