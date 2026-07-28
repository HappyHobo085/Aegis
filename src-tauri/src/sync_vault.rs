// src-tauri/src/sync_vault.rs — Vault namespace for E2E sync.
//
// The vault stores sealed ciphertext in `vault.json` — records are individually
// sealed with XChaCha20-Poly1305 under the "pwvault" namespace. For sync we
// treat those sealed records as opaque blobs: read them, send them to the
// server, and merge remote records back by uuid + updatedAt (HLC-LWW).
//
// This module is the bridge between `vault.rs` (domain logic) and `sync.rs`
// (the pull/merge/push engine). It does NOT decrypt — sync never sees
// plaintext credentials.
#![allow(dead_code)]

use serde_json::{json, Value};
use tauri::{AppHandle, Runtime};

use crate::vault;

/// Read vault records for sync export. Returns the sealed wire records
/// (`{uuid, updatedAt, nonce, ct}`) as a JSON array. Empty vec if the
/// vault file doesn't exist or has no records.
pub fn read_for_sync<R: Runtime>(app: &AppHandle<R>) -> Vec<Value> {
    let Some(file) = vault::read_file(app) else {
        return Vec::new();
    };
    file.get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
}

/// Apply remote vault records received from sync. Records are merged
/// using the same updatedAt-based HLC-LWW strategy as other sync stores:
/// - New uuids are inserted.
/// - Existing uuids are replaced if the remote `updatedAt` is strictly newer.
///
/// Changed uuids are returned so the caller can emit a targeted event.
/// The vault file on disk is re-written after merge (only when changes exist).
pub fn apply_synced<R: Runtime>(app: &AppHandle<R>, remote: &[Value]) -> Vec<String> {
    let mut changed = Vec::new();
    let Some(mut file) = vault::read_file(app) else {
        return changed;
    };
    let local_records = file
        .get("records")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let mut merged = local_records;

    for r in remote {
        let Some(uuid) = r.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        let remote_ts = r.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
        match merged.iter_mut().find(|l| {
            l.get("uuid")
                .and_then(Value::as_str)
                .map(|u| u == uuid)
                .unwrap_or(false)
        }) {
            Some(local) => {
                let local_ts = local.get("updatedAt").and_then(Value::as_i64).unwrap_or(0);
                if remote_ts > local_ts {
                    *local = r.clone();
                    changed.push(uuid.to_string());
                }
            }
            None => {
                changed.push(uuid.to_string());
                merged.push(r.clone());
            }
        }
    }

    if !changed.is_empty() {
        // Preserve salt/verifier/kdf from the existing file, just replace records.
        if let Some(obj) = file.as_object_mut() {
            obj.insert("records".into(), Value::Array(merged));
        } else {
            file = json!({ "records": merged });
        }
        if let Some(p) = vault::vault_path(app) {
            if let Ok(txt) = serde_json::to_string_pretty(&file) {
                let _ = crate::jsonstore::write_atomic(&p, txt.as_bytes());
            }
        }
    }

    changed
}

/// Check whether vault sync is enabled. Currently hardcoded to `true` when the
/// sync engine is active — will be wired to a user-facing toggle in a follow-up.
pub fn is_sync_enabled<R: Runtime>(app: &AppHandle<R>) -> bool {
    let _ = app;
    // Vault sync is enabled when the general sync engine is running.
    // Phase B initial wire: always-on (the sync module's own start() gates on
    // keychain availability). A dedicated toggle will be added in the settings UI.
    true
}

// ─── Tests ───────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    #[test]
    fn read_for_sync_empty_when_no_vault() {
        with_tmp_app(|app| {
            let records = read_for_sync(app);
            assert!(records.is_empty());
        });
    }

    #[test]
    fn apply_synced_empty_when_no_vault() {
        with_tmp_app(|app| {
            let changed = apply_synced(app, &[]);
            assert!(changed.is_empty());
        });
    }

    /// read_for_sync returns sealed records after vault is created and populated.
    #[test]
    fn read_for_sync_returns_records_after_add() {
        with_tmp_app(|app| {
            crate::vault::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "github.com", "username": "alice", "password": "p1", "notes": ""}}),
            )
            .unwrap()
            .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "google.com", "username": "bob", "password": "p2", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            let records = read_for_sync(app);
            assert_eq!(records.len(), 2, "must return both sealed records");
            // Each record must have uuid, updatedAt, nonce, ct (sealed wire shape).
            for r in &records {
                assert!(
                    r.get("uuid").and_then(Value::as_str).is_some(),
                    "missing uuid"
                );
                assert!(
                    r.get("updatedAt").and_then(Value::as_i64).is_some(),
                    "missing updatedAt"
                );
                assert!(r.get("nonce").is_some(), "missing nonce");
                assert!(r.get("ct").is_some(), "missing ct");
            }
        });
    }

    /// apply_synced inserts new remote records with unknown uuids.
    #[test]
    fn apply_synced_inserts_new_records() {
        with_tmp_app(|app| {
            // Create a vault with one local record.
            crate::vault::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "local.com", "username": "u1", "password": "p1", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            let local_count = read_for_sync(app).len();
            assert_eq!(local_count, 1, "should start with one local record");

            // Apply a remote record with a new uuid.
            let remote = vec![json!({
                "uuid": "remote-uuid-1",
                "updatedAt": 9_000_000_000_000i64,
                "nonce": "aabb",
                "ct": "ccdd",
            })];
            let changed = apply_synced(app, &remote);
            assert_eq!(changed.len(), 1, "must report the new uuid as changed");
            assert_eq!(changed[0], "remote-uuid-1");

            // Now read_for_sync should return both records.
            let records = read_for_sync(app);
            assert_eq!(records.len(), 2, "must have local + remote record");
        });
    }

    /// apply_synced replaces a local record when the remote has a newer updatedAt.
    #[test]
    fn apply_synced_replaces_with_newer_timestamp() {
        with_tmp_app(|app| {
            // Create a vault with a local record.
            crate::vault::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "old.com", "username": "old-user", "password": "old-pw", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            // Get the local record's uuid so we can craft a remote replacement.
            let local = read_for_sync(app);
            let uuid = local[0]["uuid"].as_str().unwrap().to_string();
            let local_ts = local[0]["updatedAt"].as_i64().unwrap();

            // Remote record with the same uuid but a strictly newer timestamp.
            let remote = vec![json!({
                "uuid": uuid,
                "updatedAt": local_ts + 1000,
                "nonce": "eeff",
                "ct": "1122",
            })];
            let changed = apply_synced(app, &remote);
            assert_eq!(changed.len(), 1, "must report the replaced uuid");
            assert_eq!(changed[0], uuid);

            // Verify the on-disk record was replaced (nonce changed).
            let records = read_for_sync(app);
            assert_eq!(records.len(), 1, "still one record");
            assert_eq!(records[0]["nonce"], json!("eeff"), "nonce must be replaced");
            assert_eq!(records[0]["ct"], json!("1122"), "ct must be replaced");
        });
    }

    /// apply_synced skips a remote record when the local updatedAt is equal or newer.
    #[test]
    fn apply_synced_skips_older_or_equal_timestamp() {
        with_tmp_app(|app| {
            // Create a vault with a local record.
            crate::vault::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "current.com", "username": "u", "password": "p", "notes": ""}}),
            )
            .unwrap()
            .unwrap();

            let local = read_for_sync(app);
            let uuid = local[0]["uuid"].as_str().unwrap().to_string();
            let local_ts = local[0]["updatedAt"].as_i64().unwrap();

            // Remote with OLDER timestamp — must be skipped.
            let remote_older = vec![json!({
                "uuid": uuid,
                "updatedAt": local_ts - 1000,
                "nonce": "aaaa",
                "ct": "bbbb",
            })];
            let changed = apply_synced(app, &remote_older);
            assert!(changed.is_empty(), "older remote must not replace local");
            let records = read_for_sync(app);
            assert_eq!(
                records[0]["nonce"], local[0]["nonce"],
                "local nonce must be preserved"
            );

            // Remote with EQUAL timestamp — must also be skipped (strictly greater required).
            let remote_equal = vec![json!({
                "uuid": uuid,
                "updatedAt": local_ts,
                "nonce": "cccc",
                "ct": "dddd",
            })];
            let changed2 = apply_synced(app, &remote_equal);
            assert!(
                changed2.is_empty(),
                "equal-timestamp remote must not replace local"
            );
        });
    }

    /// apply_synced with empty remote returns no changes.
    #[test]
    fn apply_synced_empty_remote_is_noop() {
        with_tmp_app(|app| {
            crate::vault::dispatch(app, "vault.create", &json!({"masterPassword": "long-pw!"}))
                .unwrap()
                .unwrap();
            crate::vault::dispatch(
                app,
                "vault.add",
                &json!({"input": {"site": "x.com", "username": "u", "password": "p", "notes": ""}}),
            )
            .unwrap()
            .unwrap();
            let before = read_for_sync(app).len();
            let changed = apply_synced(app, &[]);
            assert!(changed.is_empty());
            assert_eq!(
                read_for_sync(app).len(),
                before,
                "records must be unchanged"
            );
        });
    }
}
