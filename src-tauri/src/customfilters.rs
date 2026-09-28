//! User custom filter rules (customFilters.* IPC). Persisted as text in the app
//! data dir and folded into the ad-block engine alongside EasyList (see
//! install_adblock), so the user's rules actually block.
use std::path::PathBuf;

use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Runtime};

fn path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("custom-filters.txt"))
}

/// Sidecar holding the SINGLE sync record for the custom-filter text: `{uuid, text, hlc,
/// deleted}`. The plain `.txt` stays the source of truth for the engine; this projection
/// (kept in sync by `write`) is what the sync layer ships, so the renderer-visible text
/// format is untouched. F2b merges this single record specially (not via the array merge).
fn sync_path<R: Runtime>(app: &AppHandle<R>) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("custom-filters-sync.json"))
}

/// The user's custom filter-list text (empty if none). Plain text, not JSON, so a
/// corrupt/empty primary falls back to custom-filters.txt.bak (no structural check).
pub fn load<R: Runtime>(app: &AppHandle<R>) -> String {
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
fn stamp_sync_record<R: Runtime>(app: &AppHandle<R>, text: &str) {
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
    if let Err(e) = crate::jsonstore::write_atomic(&p, txt.as_bytes()) {
        eprintln!("[aegis] failed to persist custom filter sync record: {e}");
    }
}

/// The single custom-filter sync record (synthesized from the current text with a FLOOR
/// HLC if none exists yet, so any genuine edit on any device dominates the migration seed).
/// Read by the sync engine for the `customFilters` namespace.
pub fn sync_record<R: Runtime>(app: &AppHandle<R>) -> Value {
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

/// The persisted custom-filter sync record, or `None` if there is no sidecar yet.
///
/// [`sync_record`] SYNTHESIZES one when the sidecar is missing — and the fresh-install branch
/// calls `sync_envelope::tick`, so it ADVANCES the process-global HLC clock. That is correct
/// for the sync path and fatal for the boot-time HLC-clock seed
/// (`sync_stores::seed_hlc_clock`): the scan would perturb the clock it is scanning, so a device
/// with no custom-filter record would seed itself from a stamp invented by the scan itself.
/// Returning `None` instead is exactly right — no sidecar means no stamp has ever been written.
pub fn sync_record_readonly<R: Runtime>(app: &AppHandle<R>) -> Option<Value> {
    sync_path(app)
        .and_then(|p| crate::jsonstore::read_with_backup(&p))
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
}

/// Merge a remote custom-filter record (single-record HLC last-writer-wins). On a win, write
/// the `.txt` to the remote's text (empty if tombstoned), persist the remote record verbatim
/// (keeping its HLC — do NOT re-stamp), and re-apply ad-block. Returns whether it changed.
pub fn merge_remote<R: Runtime>(app: &AppHandle<R>, remote: &Value) -> bool {
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
    // The `.txt` FIRST, and the record only once it landed. The record is what says "we have
    // this peer's HLC", so persisting it after a failed `.txt` write told the next merge the
    // text was already here when it is not — and the peer's own text then lost to that stale
    // HLC on every later pull, in both directions, forever. Order matters as much as checking.
    if let Some(p) = path(app) {
        if let Err(e) = crate::jsonstore::write_atomic(&p, text.as_bytes()) {
            eprintln!(
                "[aegis] custom filters did not land, leaving the sync record where it was: {e}"
            );
            return false;
        }
    }
    if let Some(sp) = sync_path(app) {
        if let Ok(t) = serde_json::to_string_pretty(remote) {
            if let Err(e) = crate::jsonstore::write_atomic(&sp, t.as_bytes()) {
                // The `.txt` DID change, so this must still count as a change (reporting `false`
                // would tell the sync engine nothing happened when the engine's rules just
                // changed). The only cost is that the next pull re-applies the same text, which
                // is idempotent — the self-healing direction again.
                eprintln!("[aegis] failed to persist custom filter sync record: {e}");
            }
        }
    }
    crate::adblock_refresh::refresh(app);
    true
}

/// Overwrite the custom filters file + refresh its sync record. Durable (atomic
/// temp→rename + .bak). The single write path for custom filters: the `set` dispatch,
/// data-import, and the element picker all go through here, so all of them stamp the sync
/// record.
///
/// Returns whether the `.txt` holds `text`. It USED to return nothing and only `eprintln!` a
/// failure, then stamp the sync record UNCONDITIONALLY — so a write that never happened was
/// recorded as a fresh, winning, local HLC. Every later peer record then lost to a stamp for
/// text this device does not have, in both directions, with no error anywhere. The stamp is
/// now the second step, not the second half of an unconditional pair.
pub fn write<R: Runtime>(app: &AppHandle<R>, text: &str) -> Result<(), String> {
    if let Some(p) = path(app) {
        crate::jsonstore::write_atomic(&p, text.as_bytes()).map_err(|e| {
            eprintln!("[aegis] failed to persist custom filters: {e}");
            e.to_string()
        })?;
    }
    stamp_sync_record(app, text);
    Ok(())
}

// Generic over `R: Runtime` so the `MockRuntime` app `test_support::with_tmp_app`
// builds can drive it — every other module's dispatcher is generic for this reason.
pub fn dispatch<R: Runtime>(
    app: &AppHandle<R>,
    channel: &str,
    payload: &Value,
) -> Option<Result<Value, String>> {
    match channel {
        "customFilters.get" => Some(Ok(json!(load(app)))),
        "customFilters.set" => {
            let text = payload.get("text").and_then(Value::as_str).unwrap_or("");
            // write() persists the .txt durably AND stamps the sync record. It reports whether
            // the `.txt` landed, because this arm echoing the text back as `Ok` is the renderer
            // saying "saved": returning `Ok(json!(text))` for a file that does not contain it
            // is a lie the user finds out about only after a restart loses the rules.
            match write(app, text) {
                Ok(()) => {
                    // Re-apply ad-block so the new rules take effect — on every platform.
                    crate::adblock_refresh::refresh(app);
                    Some(Ok(json!(text)))
                }
                Err(e) => Some(Err(format!("could not save custom filters: {e}"))),
            }
        }
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::test_support::with_tmp_app;

    /// A remote record shaped the way the sync layer ships one.
    fn remote(wall_ms: i64, text: &str) -> Value {
        json!({
            "uuid": CUSTOM_FILTERS_UUID,
            "text": text,
            "hlc": json!({ "wall_ms": wall_ms, "counter": 0u32, "node": "peer" }),
            "deleted": false,
        })
    }

    fn remote_tombstone(wall_ms: i64) -> Value {
        json!({
            "uuid": CUSTOM_FILTERS_UUID,
            "text": "",
            "hlc": json!({ "wall_ms": wall_ms, "counter": 0u32, "node": "peer" }),
            "deleted": true,
        })
    }

    fn hlc_of(app: &AppHandle<tauri::test::MockRuntime>) -> crate::sync_envelope::Hlc {
        crate::sync_envelope::from_value(&sync_record(app)).expect("record must carry a valid HLC")
    }

    // ── the plain .txt: the engine's source of truth ──────────────────────

    #[test]
    fn load_is_empty_on_a_fresh_install() {
        with_tmp_app(|app| assert_eq!(load(app), ""));
    }

    #[test]
    fn write_then_load_round_trips_the_rules_verbatim() {
        with_tmp_app(|app| {
            // A realistic multi-line rule list: cosmetics, hosts, and an exception.
            let text =
                "||ads.example.com^\n##.ad-banner\nexample.org##.promo\n@@||cdn.example.com^\n";
            write(app, text).expect("filter/settings fixture write");
            assert_eq!(load(app), text);
        });
    }

    #[test]
    fn write_overwrites_rather_than_appends() {
        with_tmp_app(|app| {
            write(app, "||first.test^\n").expect("filter/settings fixture write");
            write(app, "||second.test^\n").expect("filter/settings fixture write");
            assert_eq!(load(app), "||second.test^\n");
        });
    }

    #[test]
    fn write_with_empty_text_clears_the_list() {
        with_tmp_app(|app| {
            write(app, "||gone.test^\n").expect("filter/settings fixture write");
            write(app, "").expect("filter/settings fixture write");
            assert_eq!(load(app), "");
        });
    }

    // ── the sync sidecar: one record, fixed identity ──────────────────────

    #[test]
    fn write_stamps_the_sync_record_so_picks_up_the_change() {
        with_tmp_app(|app| {
            write(app, "||a.test^\n").expect("filter/settings fixture write");
            let rec = sync_record(app);
            assert_eq!(rec["text"], json!("||a.test^\n"));
            // A deterministic, device-independent id: HLC-LWW must dedup every
            // device's copy into ONE server record, not one orphan per device.
            assert_eq!(rec["uuid"], json!(CUSTOM_FILTERS_UUID));
            assert_eq!(rec["deleted"], json!(false));
            assert!(crate::sync_envelope::from_value(&rec).is_some());
        });
    }

    #[test]
    fn a_fresh_install_synthesizes_a_floor_hlc_so_a_real_edit_dominates_it() {
        with_tmp_app(|app| {
            // No sidecar on disk: the synthesized record's HLC must be at the floor
            // (wall_ms 0) or it would beat a genuine edit from a peer.
            let rec = sync_record(app);
            let hlc = crate::sync_envelope::from_value(&rec).expect("valid HLC");
            assert_eq!(hlc.wall_ms, 0);
            assert_eq!(hlc.counter, 0);
            // …and it still carries the local text, so the seed is not a blanking write.
            assert_eq!(rec["text"], json!(""));
        });
    }

    #[test]
    fn a_synthesized_record_seeds_from_the_existing_txt() {
        with_tmp_app(|app| {
            // Write ONLY the .txt, bypassing `write`'s stamping, to reproduce a
            // migration: text on disk, no sidecar.
            let p = path(app).expect("app data dir");
            crate::jsonstore::write_atomic(&p, b"||legacy.test^\n").unwrap();
            let rec = sync_record(app);
            assert_eq!(rec["text"], json!("||legacy.test^\n"));
            assert_eq!(crate::sync_envelope::from_value(&rec).unwrap().wall_ms, 0);
        });
    }

    #[test]
    fn write_bumps_the_hlc_so_a_later_local_edit_wins_over_the_seed() {
        with_tmp_app(|app| {
            let first = hlc_of(app);
            write(app, "||one.test^\n").expect("filter/settings fixture write");
            let second = hlc_of(app);
            assert!(
                second > first,
                "a genuine edit must dominate the migration seed ({second:?} !> {first:?})"
            );
        });
    }

    // ── merge_remote: single-record HLC last-writer-wins ──────────────────

    #[test]
    fn merge_remote_applies_a_newer_peer_record() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            let before = hlc_of(app);
            assert!(merge_remote(
                app,
                &remote(before.wall_ms + 10_000, "||theirs.test^\n")
            ));
            assert_eq!(load(app), "||theirs.test^\n");
        });
    }

    #[test]
    fn merge_remote_rejects_an_older_peer_record_and_keeps_local_text() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            let mine = hlc_of(app);
            assert!(
                !merge_remote(app, &remote(mine.wall_ms - 10_000, "||stale.test^\n")),
                "an older remote must lose last-writer-wins"
            );
            assert_eq!(load(app), "||mine.test^\n");
        });
    }

    // With no local record at all there is nothing to compare against, so the peer
    // MUST win — otherwise a joining device would never receive the shared filter list.
    #[test]
    fn merge_remote_wins_when_there_is_no_local_record() {
        with_tmp_app(|app| {
            assert!(merge_remote(
                app,
                &remote(1_700_000_000_000, "||joined.test^\n")
            ));
            assert_eq!(load(app), "||joined.test^\n");
        });
    }

    #[test]
    fn a_tombstoned_peer_record_clears_the_local_rules() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            let before = hlc_of(app);
            assert!(merge_remote(
                app,
                &remote_tombstone(before.wall_ms + 10_000)
            ));
            assert_eq!(
                load(app),
                "",
                "a delete must actually delete, not be ignored"
            );
        });
    }

    #[test]
    fn a_stale_tombstone_does_not_delete_a_newer_local_edit() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            let mine = hlc_of(app);
            assert!(!merge_remote(app, &remote_tombstone(mine.wall_ms - 1)));
            assert_eq!(load(app), "||mine.test^\n");
        });
    }

    // Re-stamping on merge would give the record a FRESH hlc, so a re-push would look
    // like a new edit and the peer that legitimately won would lose its own record.
    #[test]
    fn merge_remote_persists_the_remote_record_verbatim_without_re_stamping() {
        with_tmp_app(|app| {
            let remote_hlc = 1_700_000_000_000i64;
            assert!(merge_remote(app, &remote(remote_hlc, "||theirs.test^\n")));
            let stored = sync_record(app);
            assert_eq!(stored["hlc"]["wall_ms"], json!(remote_hlc));
            assert_eq!(stored["hlc"]["node"], json!("peer"));
            assert_eq!(stored["text"], json!("||theirs.test^\n"));
        });
    }

    #[test]
    fn merge_remote_rejects_a_record_with_no_usable_hlc() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            // No `hlc` key at all: the record cannot be placed in the order, so it
            // must be ignored rather than applied blindly.
            let broken = json!({ "uuid": CUSTOM_FILTERS_UUID, "text": "||evil.test^\n" });
            assert!(!merge_remote(app, &broken));
            assert_eq!(load(app), "||mine.test^\n");
        });
    }

    // A merge_remote that lost must not leave the local sidecar rewritten either, or
    // the next push would ship a record the user never created.
    #[test]
    fn a_losing_merge_leaves_the_local_sync_record_untouched() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            let mine = hlc_of(app);
            let before = sync_record(app);
            assert!(!merge_remote(
                app,
                &remote(mine.wall_ms - 1, "||stale.test^\n")
            ));
            assert_eq!(sync_record(app), before);
            assert_eq!(hlc_of(app).wall_ms, mine.wall_ms);
        });
    }

    #[test]
    fn merging_converges_under_replay_whatever_the_order() {
        with_tmp_app(|app| {
            let older = remote(1_000, "||old.test^\n");
            let newer = remote(2_000, "||new.test^\n");
            // Newer first, then the older one: the result must be the newer text
            // either way round, which is what makes a retry loop safe.
            assert!(merge_remote(app, &newer));
            assert!(!merge_remote(app, &older));
            assert_eq!(load(app), "||new.test^\n");
            assert!(!merge_remote(app, &older));
            assert_eq!(load(app), "||new.test^\n");
        });
    }

    #[test]
    fn a_local_edit_after_a_merge_beats_the_peer_it_merged_from() {
        with_tmp_app(|app| {
            assert!(merge_remote(
                app,
                &remote(1_700_000_000_000, "||theirs.test^\n")
            ));
            assert_eq!(load(app), "||theirs.test^\n");
            // The user edits locally; `write` stamps a new HLC, which must dominate the
            // record the peer just won.
            write(app, "||mine.test^\n").expect("filter/settings fixture write");
            assert_eq!(load(app), "||mine.test^\n");
            assert!(
                hlc_of(app).wall_ms >= 1_700_000_000_000,
                "the local stamp must not go backwards"
            );
        });
    }

    // ── dispatch ──────────────────────────────────────────────────────────

    #[test]
    fn dispatch_get_returns_the_current_text() {
        with_tmp_app(|app| {
            write(app, "||x.test^\n").expect("filter/settings fixture write");
            let out = dispatch(app, "customFilters.get", &json!({}))
                .expect("channel is handled")
                .expect("ok");
            assert_eq!(out, json!("||x.test^\n"));
        });
    }

    #[test]
    fn dispatch_set_persists_and_echoes_the_text() {
        with_tmp_app(|app| {
            let out = dispatch(app, "customFilters.set", &json!({ "text": "||y.test^\n" }))
                .expect("channel is handled")
                .expect("ok");
            assert_eq!(out, json!("||y.test^\n"));
            assert_eq!(load(app), "||y.test^\n");
            // `set` goes through `write`, so it must stamp the sync record too —
            // otherwise a peer's filters and a locally-edited set would never merge.
            assert_eq!(sync_record(app)["text"], json!("||y.test^\n"));
        });
    }

    #[test]
    fn dispatch_set_with_a_non_string_text_falls_back_to_empty() {
        with_tmp_app(|app| {
            let _ = dispatch(app, "customFilters.set", &json!({ "text": 42 })).expect("handled");
            assert_eq!(load(app), "");
        });
    }

    #[test]
    fn dispatch_ignores_an_unknown_channel() {
        with_tmp_app(|app| {
            assert!(dispatch(app, "customFilters.nope", &json!({})).is_none());
        });
    }

    // ── a write that did not land must not be recorded as having landed ──

    /// `write` used to `eprintln!` a failed `.txt` write and stamp the sync record anyway, so
    /// the record advertised text this device does not have at a FRESH, ticking, winning HLC.
    /// Every later peer record then lost to that invented stamp — in BOTH directions, forever,
    /// with no error anywhere. The record must keep describing the file that is on disk.
    #[test]
    fn a_filter_write_that_fails_does_not_stamp_the_sync_record() {
        with_tmp_app(|app| {
            write(app, "||first.test^\n").expect("seed");
            let first = hlc_of(app);

            let _blocked = crate::test_support::block_store_file(app, "custom-filters.txt");
            assert!(
                write(app, "||second.test^\n").is_err(),
                "precondition: the .txt write must actually fail for this test to test anything"
            );

            let rec = sync_record(app);
            assert_eq!(
                rec.get("text").and_then(Value::as_str),
                Some("||first.test^\n"),
                "the record must still describe the .txt that is on disk, not the one that failed"
            );
            assert_eq!(
                hlc_of(app),
                first,
                "a write that did not land must not tick a new winning HLC"
            );
        });
    }

    /// The mirror image on the pull side: a peer's record that WINS the merge but cannot be
    /// written must not be persisted verbatim either, or the same permanent bidirectional loss
    /// happens from the other end. Not persisting it is also the self-healing direction — the
    /// peer's record wins again on the next pass.
    #[test]
    fn a_peer_filter_write_that_fails_leaves_the_record_alone_so_the_peer_retries() {
        with_tmp_app(|app| {
            write(app, "||mine.test^\n").expect("seed");
            let mine = hlc_of(app);
            // Relative to the LOCAL HLC, matching this file's other merge tests. An absolute
            // wall clock is useless here: `now_ms()` is ~1.8e12, so a small constant like 9e9
            // is an ANCIENT record, the merge loses before ever reaching the write, and every
            // assertion below would pass for the wrong reason.
            let peer = remote(mine.wall_ms + 10_000, "||theirs.test^\n");

            let blocked = crate::test_support::block_store_file(app, "custom-filters.txt");
            assert!(
                !merge_remote(app, &peer),
                "a write that did not land is not a change — reporting true would tell the sync \
                 engine the rules changed when they did not"
            );
            assert_eq!(
                hlc_of(app),
                mine,
                "the peer's HLC must not be recorded as applied when its text never landed"
            );

            crate::test_support::unblock_store_file(&blocked);
            assert!(
                merge_remote(app, &peer),
                "the same record must win again once the write can land"
            );
            assert_eq!(load(app), "||theirs.test^\n");
        });
    }

    /// The user-visible half: the `set` arm echoed the text back as `Ok`, which the renderer
    /// renders as "saved". Returning `Ok` for a file that does not contain the text meant the
    /// user found out only after a restart lost the rules.
    #[test]
    fn the_set_channel_reports_a_write_that_did_not_land() {
        with_tmp_app(|app| {
            let _blocked = crate::test_support::block_store_file(app, "custom-filters.txt");
            let reply = dispatch(app, "customFilters.set", &json!({ "text": "||x.test^\n" }))
                .expect("customFilters.set is handled")
                .expect_err("a write that did not land must not read as saved");
            assert!(
                reply.contains("custom filters"),
                "the message must name what failed, so the user is not left guessing — got {reply:?}"
            );
        });
    }
}
