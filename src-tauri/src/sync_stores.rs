//! The merge seam the sync engine (F2b) consumes. F2a freezes this contract:
//!   - `SYNCABLE` — the array stores that sync (each a `load_synced` JSON array of records
//!     carrying `uuid`/`hlc`/`deleted`). `downloads` is intentionally NOT here — its
//!     `savePath` is device-specific (it gets the envelope for delete-hygiene only; §9.4)
//!     The two special projections sync through their own modules: per-key settings
//!     (`settings::sync_records` / `apply_synced`) and the single custom-filter record
//!     (`customfilters`).
//!   - `read_all(app, name)` — the FULL local array incl. tombstones.
//!   - `merge_into(app, name, remote)` — per-uuid HLC last-writer-wins: insert new uuids,
//!     replace when the remote HLC dominates (incl. flipping `deleted`), observe every
//!     remote clock. Returns the changed uuids so the caller can emit a TARGETED
//!     `sync.changed` (never a full reload). An allowlist merge also re-seeds the engine.
// This whole module is the frozen contract the F2b (Phase 3) sync engine consumes; until
// then nothing calls read_all/merge_into/SYNCABLE, which reads as dead code on the Android
// cdylib build (unused pub items warn there, unlike the host rlib).
#![allow(dead_code)]

use serde_json::Value;
use tauri::{AppHandle, Runtime};

/// Array stores that participate in sync. History is intentionally absent — it is NOT
/// syncable (product decision): it stays device-local with plain hard-delete storage, so a
/// "clear history" actually removes the URLs rather than leaving tombstones on disk.
/// Downloads are absent too (device-specific savePath; envelope only for delete-hygiene).
pub const SYNCABLE: &[&str] = &["favorites", "saved", "allowlist"];

/// Every ARRAY store whose records carry an `hlc`, which the boot-time HLC-clock seed reads.
///
/// Deliberately a SUPERSET of [`SYNCABLE`]. Only the synced stores can lose data to a peer's
/// stamp (they are the ones LWW-merged against remote records), but the HLC's own contract —
/// "never goes backwards even if the wall clock does" — is about every record this device
/// stamps, synced or not. Including `history`/`downloads`/`subs` costs three small JSON reads
/// that boot already performs for other reasons, and it means a stamp written to a local-only
/// store can never be undercut by a later local edit.
///
/// `permissions` is NOT here: it uses plain `jsonstore::load`/`save` rather than
/// `load_synced`, so its records carry no `hlc` at all. `fp-allowlist` is host-keyed with no
/// HLC either. Both were verified by reading their modules, not assumed.
///
/// The two NON-array projections (the per-key settings projection and the single
/// custom-filter record) are read separately by [`seed_hlc_clock`], because their files do not
/// live in the `jsonstore` array layout.
pub const HLC_CARRIERS: &[&str] = &[
    "favorites",
    "history",
    "downloads",
    "saved",
    "subs",
    "allowlist",
];

/// Seed the process-global HLC clock from what is already on disk. Call ONCE at boot, from
/// `lib.rs`'s `setup()`, before any tab can be edited and before any sync pass runs.
///
/// ## Why
/// The HLC clock is a process-global that starts at `(0, 0)` on every launch and was never
/// persisted, so after a restart the first local stamp is `(now_ms, 0)` — which loses
/// last-writer-wins to any record already on disk that was stamped above `now_ms`, and is then
/// silently reverted by the next merge. See [`crate::sync_envelope::seed_clock`] for the full
/// failure mode. This function supplies the missing lower bound.
///
/// ## Contract
/// READ-ONLY. It must not write, and it must not touch the clock except through
/// [`crate::sync_envelope::seed_clock`] (which only ever moves it forward). Two traps make that
/// non-obvious and both are why the readers below are the `_readonly` variants:
///   * `settings::sync_records` lazily PERSISTS `settings-sync.json`;
///   * `customfilters::sync_record` calls `sync_envelope::tick` when the sidecar is missing,
///     which would advance the very clock this function is seeding.
///
/// Plain `jsonstore::load` (not `load_synced`) is used for the array stores, which skips the
/// `ensure_sync_meta` migration write. That migration is idempotent and runs on every read
/// anyway, so skipping it here only means it happens on the first real read instead.
pub fn seed_hlc_clock<R: Runtime>(app: &AppHandle<R>) {
    let mut max: Option<(i64, u32)> = None;
    let mut consider = |records: &[Value]| {
        if let Some(m) = crate::sync_envelope::max_hlc(records) {
            max = Some(match max {
                Some(cur) if cur >= m => cur,
                _ => m,
            });
        }
    };
    for name in HLC_CARRIERS {
        consider(&crate::jsonstore::load(app, name));
    }
    consider(&crate::settings::sync_records_readonly(app));
    if let Some(rec) = crate::customfilters::sync_record_readonly(app) {
        consider(std::slice::from_ref(&rec));
    }
    if let Some(m) = max {
        crate::sync_envelope::seed_clock(m);
    }
}

/// The full local array (incl. tombstones), lazily migrated to carry sync metadata.
pub fn read_all<R: Runtime>(app: &AppHandle<R>, name: &str) -> Vec<Value> {
    crate::jsonstore::load_synced(app, name)
}

/// HLC-LWW merge: fold `remote` into `local`, returning the merged array + the
/// uuids that changed. Advances the global HLC clock by observing each remote stamp
/// (so a later local edit dominates a record we just received).
fn merge_records(
    mut local: Vec<Value>,
    remote: &[Value],
    node: &str,
    now_ms: i64,
) -> (Vec<Value>, Vec<String>) {
    let mut changed = Vec::new();
    for r in remote {
        let Some(ruuid) = crate::jsonstore::uuid_of(r) else {
            continue; // a record without a uuid can't be merged
        };
        let Some(rhlc) = crate::sync_envelope::from_value(r) else {
            continue; // nor one without a well-formed hlc
        };
        crate::sync_envelope::observe(node, now_ms, &rhlc);
        // The merge identity is `uuid` (globally unique). The integer `id` is DEVICE-LOCAL
        // (next_id = max+1), so two devices independently assign 1,2,3…; the renderer keys
        // its mutations by `id`, so the merged array must stay id-unique or a `remove {id}`
        // would hit the wrong record. We therefore preserve the LOCAL id on replace and
        // re-key an inserted remote record to a fresh local id — ALWAYS, including when the
        // remote record carries no `id` (allowlist rows are host-keyed, but a missing id is
        // what made `remove`'s `Option` comparison match every row at once).
        match local
            .iter_mut()
            .find(|l| crate::jsonstore::uuid_of(l) == Some(ruuid))
        {
            Some(l) => {
                // Replace only if the remote strictly dominates (or local lacks an hlc).
                let remote_wins = crate::sync_envelope::from_value(l)
                    .map(|lh| rhlc > lh)
                    .unwrap_or(true);
                if remote_wins {
                    let local_id = l.get("id").cloned();
                    *l = r.clone();
                    if let (Some(id), Some(obj)) = (local_id, l.as_object_mut()) {
                        obj.insert("id".into(), id); // keep the device-local id
                    }
                    changed.push(ruuid.to_string());
                }
            }
            None => {
                let mut incoming = r.clone();
                // ALWAYS assign a device-local id — the previous `if incoming.get("id").is_some()`
                // guard left a remotely-inserted record with NO id at all, and that is far worse
                // than an id collision. The renderer keys every mutation by `id`, and
                // `places::saved.remove` matched with `id_of(it) == id`, which compares
                // `Option<i64>`s: a payload with a missing/non-integer `id` yields `None`, and
                // `None == None` is true for EVERY id-less row. One such call therefore
                // tombstoned the user's entire saved-pages list in a single pass — 104 records,
                // one `wall_ms`, counters marching from the node's current value. The store is
                // gone on every device the moment that propagates, because the tombstones sync.
                // Assigning an id here closes the root cause (the renderer can no longer be
                // handed a row whose `id` is `undefined`); the `None`-rejection in `places.rs`
                // is the backstop that stops one bad payload from wiping a store.
                //
                // NOT `next_id_optimized`: that helper answers from a process-global cache keyed
                // by store name and ignores the `items` argument entirely on a cache hit.
                // `local` here is an in-memory Vec that never goes through `load`/`save`, so the
                // cache still holds the value computed from the PRE-merge array for the whole
                // loop — which handed two remote records arriving in one batch the SAME fresh
                // id, so `remove {id}`/`update {id}` hit both. The O(n) scan sees each record as
                // it is pushed, so consecutive inserts get consecutive ids.
                let fresh = crate::jsonstore::next_id(&local);
                if let Some(obj) = incoming.as_object_mut() {
                    obj.insert("id".into(), Value::from(fresh));
                }
                local.push(incoming);
                changed.push(ruuid.to_string());
            }
        }
    }
    (local, changed)
}

/// Merge `remote` into the local `name` store (HLC-LWW), persist if anything changed, and
/// return the changed uuids. An allowlist merge re-seeds the in-memory allowlist + engine.
pub fn merge_into<R: Runtime>(app: &AppHandle<R>, name: &str, remote: &[Value]) -> Vec<String> {
    // Hold the per-store write lock across the WHOLE read-modify-write. This runs on the
    // background sync thread and races the UI's own `places::dispatch` arms on the very
    // same file (`favorites.json`, `saved.json`, …). Without the lock, a `favorites.add`
    // that lands between our `read_all` and our `save` is silently overwritten — the user's
    // just-made favorite disappears, and because `save` succeeded the file looks perfectly
    // healthy so nothing reports the loss. `jsonstore::write_atomic` only guarantees that no
    // individual WRITE is lost, never that a read-modify-write is atomic.
    crate::jsonstore::with_store_lock(name, || merge_into_locked(app, name, remote))
}

/// The body of [`merge_into`]; runs with `name`'s store lock already held.
fn merge_into_locked<R: Runtime>(app: &AppHandle<R>, name: &str, remote: &[Value]) -> Vec<String> {
    let node = crate::sync_identity::node_id(app);
    let local = read_all(app, name);
    let (mut merged, mut changed) = merge_records(local, remote, &node, crate::jsonstore::now_ms());
    // Collapse cross-device duplicates (same normalized url/host): tombstone the losers so the
    // deletion converges across devices. Idempotent — tombstoned losers are skipped next pass.
    let losers = duplicate_losers(&merged, key_field_for(name));
    if !losers.is_empty() {
        crate::jsonstore::tombstone(
            &mut merged,
            |it| {
                crate::jsonstore::uuid_of(it)
                    .map(|u| losers.iter().any(|l| l == u))
                    .unwrap_or(false)
            },
            app,
        );
        for u in losers {
            if !changed.contains(&u) {
                changed.push(u);
            }
        }
    }
    if !changed.is_empty() {
        // A failed write here is NOT cosmetic: `save` is the only thing that puts the merged
        // rows on disk, and `jsonstore`'s cache is only refreshed after a successful
        // `write_atomic`. So swallowing the error returned `Ok`-shaped success to the sync
        // engine, which then reported the namespace as synced and cleared its dirty flag —
        // while neither disk nor cache moved. The peer's rows would be re-fetched and
        // re-merged every pass and never stick, with nothing anywhere reporting why. Unlike
        // the local mutators (see `jsonstore::add_host`) there is no "the user watches the
        // row" feedback path here at all, so the log line is the ONLY signal.
        if let Err(e) = crate::jsonstore::save(app, name, &merged) {
            eprintln!("[aegis] failed to persist merged {name} from sync: {e}");
        }
        if name == "allowlist" {
            // The allowlist drives the engine policy → refresh the cache + engine.
            crate::adblock::seed_from_disk(app);
            crate::adblock_refresh::refresh(app);
        }
    }
    changed
}

/// Age at which a local tombstone is garbage-collected after a successful sync.
///
/// WHY A HORIZON AND NOT "DELETE IT ONCE PUSHED": a tombstone exists so that a delete made
/// on one device reaches every OTHER device. A client cannot know when the last other device
/// has seen it, so the only sound local rule is time-based: keep the tombstone at least as
/// long as any peer could plausibly have been offline, then drop it. Thirty days is far beyond
/// any realistic offline window — a device gone longer than that is re-syncing from scratch
/// anyway, and the server's own `TOMBSTONE_RETENTION_PER_NS` bound applies in parallel.
///
/// This is deliberately a *bound*, not a proof: it makes the effective tombstone lifetime
/// shorter than "until every peer has seen it". The alternative — never GC'ing — is what let
/// today's incident leave 104 dead rows in `saved` indefinitely. Callers MUST only invoke this
/// after a pass that PUSHED as well as pulled; dropping a tombstone that never reached the
/// server loses the delete permanently and lets the record reappear from a peer.
pub const TOMBSTONE_GC_AGE_MS: i64 = 30 * 24 * 60 * 60 * 1000;

/// Reap tombstones in `name` whose HLC is older than `TOMBSTONE_GC_AGE_MS`, returning the count.
///
/// Split out from [`merge_into_locked`] and deliberately NOT called from it: `merge_into`
/// runs on the PULL path, and a pull can succeed while the push that should have carried a
/// fresh local tombstone to the server failed. Collecting there would silently discard a delete
/// the server never heard about. The caller is responsible for invoking this only once the
/// namespace's push AND pull have both succeeded.
pub fn gc_tombstones<R: Runtime>(app: &AppHandle<R>, name: &str, now_ms: i64) -> usize {
    let cutoff = now_ms.saturating_sub(TOMBSTONE_GC_AGE_MS);
    crate::jsonstore::with_store_lock(name, || {
        let mut items = crate::jsonstore::load_synced(app, name);
        let before = items.len();
        items.retain(|it| {
            if !crate::jsonstore::is_deleted(it) {
                return true;
            }
            // A tombstone with no parseable HLC is kept: we cannot prove it is old, and
            // dropping an undatable one is exactly the silent-delete we are avoiding.
            // NOTE: unreachable via this call path — `load_synced` above runs
            // `ensure_sync_meta`, which stamps an HLC onto anything missing one. Defence in
            // depth, kept deliberately; see `gc_keeps_a_tombstone_that_arrives_without_an_hlc`
            // for the probe that proves it is not load-bearing.
            match crate::sync_envelope::from_value(it) {
                Some(h) => h.wall_ms >= cutoff,
                None => true,
            }
        });
        let reaped = before - items.len();
        if reaped > 0 {
            if let Err(e) = crate::jsonstore::save(app, name, &items) {
                // Same reasoning as the merge's own save: swallowing this reports a clean
                // namespace while nothing moved, and there is no user-visible surface here.
                eprintln!("[aegis] failed to persist {name} tombstone GC: {e}");
                return 0;
            }
        }
        reaped
    })
}

/// Normalize a favorites/saved URL for dup detection: drop the #fragment and trailing
/// slashes, trim whitespace. Path + query preserved, no case-folding (so `?id=1` ≠ `?id=2`).
fn normalize_url(u: &str) -> String {
    let no_frag = u.split('#').next().unwrap_or("");
    no_frag.trim().trim_end_matches('/').to_string()
}

/// The dedup key for a record, by namespace field: `"host"` (allowlist) is lowercased; any
/// other field (`"url"`) is URL-normalized.
fn dedup_key(rec: &Value, key_field: &str) -> Option<String> {
    let raw = rec.get(key_field).and_then(Value::as_str)?;
    let key = if key_field == "host" {
        raw.trim().to_lowercase()
    } else {
        normalize_url(raw)
    };
    // A record whose key normalizes to nothing (empty / "#" / "/" / whitespace) is
    // unidentifiable — treat it like a missing key so distinct junk records never group
    // together and get tombstoned.
    if key.is_empty() {
        None
    } else {
        Some(key)
    }
}

/// Which record field identifies a duplicate, per namespace.
fn key_field_for(name: &str) -> &'static str {
    if name == "allowlist" {
        "host"
    } else {
        "url"
    }
}

/// Among LIVE records, group by normalized key; for each group of >1, keep the deterministic
/// survivor: the highest HLC (`wall_ms`, `counter`, `node` — and `node` is a per-device id, so
/// it almost always decides a cross-device tie); only on a FULL HLC tie does the smaller uuid
/// win. Returns the loser uuids. Pure + convergent: every device computes the same survivor
/// from replicated fields, independent of record order.
fn duplicate_losers(records: &[Value], key_field: &str) -> Vec<String> {
    use std::collections::HashMap;
    let mut groups: HashMap<String, Vec<(String, Option<crate::sync_envelope::Hlc>)>> =
        HashMap::new();
    for r in records {
        if crate::jsonstore::is_deleted(r) {
            continue;
        }
        let (Some(key), Some(uuid)) = (dedup_key(r, key_field), crate::jsonstore::uuid_of(r))
        else {
            continue;
        };
        groups
            .entry(key)
            .or_default()
            .push((uuid.to_string(), crate::sync_envelope::from_value(r)));
    }
    let mut losers = Vec::new();
    for (_key, members) in groups {
        if members.len() < 2 {
            continue;
        }
        // Survivor = max by HLC; on an HLC tie the smaller uuid wins (so it ranks as "max").
        let survivor = members
            .iter()
            .enumerate()
            .max_by(|(_, (ua, ha)), (_, (ub, hb))| match ha.cmp(hb) {
                std::cmp::Ordering::Equal => ub.cmp(ua),
                other => other,
            })
            .map(|(i, _)| i)
            .unwrap();
        for (i, (uuid, _)) in members.into_iter().enumerate() {
            if i != survivor {
                losers.push(uuid);
            }
        }
    }
    losers
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn drec(uuid: &str, key: &str, key_field: &str, wall: i64, deleted: bool) -> Value {
        json!({
            "uuid": uuid,
            key_field: key,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "n" },
            "deleted": deleted,
        })
    }

    #[test]
    fn dedup_keeps_latest_hlc_survivor() {
        let recs = vec![
            drec("a", "http://x/p", "url", 10, false),
            drec("b", "http://x/p", "url", 20, false),
        ];
        assert_eq!(duplicate_losers(&recs, "url"), vec!["a".to_string()]);
    }

    #[test]
    fn dedup_hlc_tie_smaller_uuid_survives() {
        let recs = vec![
            drec("b", "http://x/p", "url", 10, false),
            drec("a", "http://x/p", "url", 10, false),
        ];
        assert_eq!(duplicate_losers(&recs, "url"), vec!["b".to_string()]);
    }

    #[test]
    fn dedup_normalizes_slash_and_fragment() {
        let recs = vec![
            drec("a", "http://x/p/", "url", 10, false),
            drec("b", "http://x/p", "url", 20, false),
            drec("c", "http://x/p#frag", "url", 30, false),
        ];
        let mut losers = duplicate_losers(&recs, "url");
        losers.sort();
        assert_eq!(losers, vec!["a".to_string(), "b".to_string()]); // survivor = c
    }

    #[test]
    fn dedup_distinct_query_not_merged() {
        let recs = vec![
            drec("a", "http://x/p?id=1", "url", 10, false),
            drec("b", "http://x/p?id=2", "url", 20, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_allowlist_host_case_insensitive() {
        let recs = vec![
            drec("a", "Example.com", "host", 10, false),
            drec("b", "example.com", "host", 20, false),
        ];
        assert_eq!(duplicate_losers(&recs, "host"), vec!["a".to_string()]);
    }

    #[test]
    fn dedup_ignores_tombstones_and_singletons() {
        let recs = vec![
            drec("a", "http://x/p", "url", 10, true),
            drec("b", "http://x/p", "url", 20, false),
            drec("c", "http://y", "url", 5, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_skips_empty_normalized_keys() {
        // empty / "#frag" / "/" all normalize to "" → unidentifiable → never grouped or deleted.
        let recs = vec![
            drec("a", "", "url", 10, false),
            drec("b", "#frag", "url", 20, false),
            drec("c", "/", "url", 30, false),
        ];
        assert!(duplicate_losers(&recs, "url").is_empty());
    }

    #[test]
    fn dedup_node_decides_tie_before_uuid() {
        // Equal wall_ms + counter but different node: the higher node wins (node is compared
        // before the uuid fallback), regardless of which uuid is smaller.
        let recs = vec![
            json!({ "uuid": "aaa", "url": "http://x/p", "deleted": false,
                    "hlc": { "wall_ms": 10, "counter": 0, "node": "zzz" } }),
            json!({ "uuid": "zzz", "url": "http://x/p", "deleted": false,
                    "hlc": { "wall_ms": 10, "counter": 0, "node": "aaa" } }),
        ];
        // node "zzz" > "aaa" → record "aaa" survives; "zzz" (smaller node) is the loser.
        assert_eq!(duplicate_losers(&recs, "url"), vec!["zzz".to_string()]);
    }

    fn rec(uuid: &str, wall: i64, deleted: bool, payload: &str) -> Value {
        json!({
            "uuid": uuid,
            "hlc": { "wall_ms": wall, "counter": 0, "node": "remote" },
            "deleted": deleted,
            "payload": payload,
        })
    }

    #[test]
    fn merge_inserts_new_uuids() {
        let local = vec![rec("a", 1, false, "local-a")];
        let remote = vec![rec("b", 1, false, "remote-b")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["b".to_string()]);
        assert_eq!(merged.len(), 2);
    }

    /// THE probe for the never-persisted HLC clock.
    ///
    /// `sync_envelope`'s `CLOCK` starts at `(0, 0)` on every launch. With nothing seeding it,
    /// the first local stamp after a restart is `(now_ms, 0)` — and if any record already on
    /// disk was stamped ABOVE `now_ms`, the new edit loses last-writer-wins to it, is silently
    /// reverted by the next merge, and (because the losing stamp is itself persisted) can never
    /// be won back. The realistic way a record ends up above `now_ms` is a peer within the
    /// accepted 60 s `MAX_REMOTE_SKEW_MS` window: observing it pushes this device's clock into
    /// the future, and every record stamped afterwards inherits that wall.
    ///
    /// The assertion is on the OBSERVABLE consequence (does a fresh local tick dominate the
    /// persisted record?) rather than on the clock's internals, so it would still hold if the
    /// seeding mechanism changed.
    #[test]
    fn a_local_edit_after_a_restart_dominates_a_record_already_stamped_ahead() {
        crate::test_support::with_tmp_app(|app| {
            let now = crate::jsonstore::now_ms();
            let ahead = now + 30_000;
            crate::jsonstore::save(
                app,
                "favorites",
                &[serde_json::json!({
                    "id": 1,
                    "url": "https://ahead.test/",
                    "uuid": "u-ahead",
                    "hlc": { "wall_ms": ahead, "counter": 4, "node": "peer" },
                    "deleted": false
                })],
            )
            .expect("the simulated previous session's record must save");

            // Exactly what `lib.rs`'s `setup()` runs at boot.
            crate::sync_stores::seed_hlc_clock(app);

            let t = crate::sync_envelope::tick("local", now);
            // Compare the whole (wall, counter) pair: that is what `Hlc: Ord` — and therefore
            // every LWW merge — orders on. Asserting on `wall_ms` alone would be both weaker
            // (a tie on the wall decided by counter is a win) and, on a shared global clock
            // another test already seeded, spuriously strict.
            let mine = (t.wall_ms, t.counter);
            let theirs = (ahead, 4u32);
            assert!(
                mine > theirs,
                "a local edit after a restart must dominate a record already on disk stamped \
                 30s ahead at {theirs:?}, but it got {mine:?} — the HLC clock was never seeded \
                 from disk, so the edit loses LWW and the next merge silently reverts it"
            );
            assert!(
                t.wall_ms > now,
                "the seeded clock must not leave the local wall below real time, got {t:?}"
            );
        });
    }

    /// The seed must be READ-ONLY and must never move the clock BACKWARDS.
    ///
    /// The "adopts a floor" half is deliberately NOT asserted here. `CLOCK` is process-global
    /// and already sitting at real time (~1.7e12), so asserting a floor of 5,000 against it
    /// passes whether or not the seed ran — a vacuous test. That half is covered instead by
    /// `a_local_edit_after_a_restart_dominates_a_record_already_stamped_ahead` (a floor above
    /// real time, which the clock cannot already be past) and by the pure `merge_clock` unit
    /// test in `sync_envelope`.
    ///
    /// What is worth asserting HERE is the read-only contract, because both obvious readers are
    /// in fact writers: a clock seeded through a reader that persists, or that ticks, is seeded
    /// from a state it just changed.
    #[test]
    fn seeding_writes_nothing_to_disk() {
        use tauri::Manager;
        crate::test_support::with_tmp_app(|app| {
            crate::jsonstore::save(
                app,
                "favorites",
                &[serde_json::json!({
                    "id": 1, "url": "https://a.test/", "uuid": "u1",
                    "hlc": { "wall_ms": 5_000, "counter": 9, "node": "peer" },
                    "deleted": false
                })],
            )
            .expect("save");
            let favorites = app
                .path()
                .app_data_dir()
                .expect("data dir")
                .join("favorites.json");
            let before = std::fs::read_to_string(&favorites).expect("favorites.json exists");

            // Far-future stamp, so any seeding path that ticks the clock would be visible.
            crate::jsonstore::save(
                app,
                "subs",
                &[serde_json::json!({
                    "id": 1, "url": "https://b.test", "uuid": "u2",
                    "hlc": { "wall_ms": crate::jsonstore::now_ms() + 30_000, "counter": 0, "node": "peer" },
                    "deleted": false
                })],
            )
            .expect("save");
            crate::sync_stores::seed_hlc_clock(app);

            assert_eq!(
                std::fs::read_to_string(&favorites).expect("favorites.json"),
                before,
                "the HLC scan must be read-only: it writes nothing to any store"
            );
            // `settings::sync_records` and `customfilters::sync_record` are the two readers that
            // DO have side effects; assert the projection they would create is still absent, so
            // the boot seed cannot have gone through either of them.
            let data = app.path().app_data_dir().expect("data dir");
            assert!(
                !data.join("settings-sync.json").exists(),
                "the HLC scan must not lazily create the settings sync projection — that write \
                 belongs to the first real sync, not to a clock read"
            );
            assert!(
                !data.join("custom-filters.sync.json").exists(),
                "the HLC scan must not synthesize the custom-filter sync record: that path calls \
                 `sync_envelope::tick`, so it would seed the clock from a stamp it just invented"
            );
        });
    }

    /// A record whose `counter` does not fit the client's `u32` must be skipped, not treated as
    /// the maximum and not allowed to abort the scan. The pure half of this lives in
    /// `sync_envelope::tests::max_hlc_skips_unreadable_stamps_without_aborting`; this is the
    /// integration half — a boot scan that hit such a record must still adopt the other stores'
    /// stamps rather than leaving the clock unseeded.
    #[test]
    fn a_record_with_an_unreadable_hlc_does_not_stop_the_boot_scan() {
        crate::test_support::with_tmp_app(|app| {
            let now = crate::jsonstore::now_ms();
            // One poisoned store (a counter no client can deserialize) and one good store.
            crate::jsonstore::save(
                app,
                "history",
                &[serde_json::json!({
                    "id": 1, "url": "https://poison.test/", "uuid": "u-poison",
                    "hlc": { "wall_ms": 1_000i64, "counter": (u32::MAX as u64) + 1, "node": "b" },
                    "deleted": false
                })],
            )
            .expect("save");
            crate::jsonstore::save(
                app,
                "favorites",
                &[serde_json::json!({
                    "id": 1, "url": "https://ok.test/", "uuid": "u-ok",
                    "hlc": { "wall_ms": now + 30_000, "counter": 3, "node": "peer" },
                    "deleted": false
                })],
            )
            .expect("save");

            crate::sync_stores::seed_hlc_clock(app);

            let t = crate::sync_envelope::tick("local", now);
            assert!(
                (t.wall_ms, t.counter) > (now + 30_000, 3u32),
                "an unreadable stamp in one store must not stop the scan adopting the others', \
                 got {t:?}"
            );
        });
    }

    #[test]
    fn merge_replaces_only_when_remote_hlc_dominates() {
        // Remote newer → replace (and the payload updates).
        let local = vec![rec("a", 1, false, "old")];
        let remote = vec![rec("a", 5, false, "new")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["a".to_string()]);
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("new")
        );

        // Older remote → ignored (no change).
        let local = vec![rec("a", 9, false, "keep")];
        let remote = vec![rec("a", 2, false, "stale")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert!(changed.is_empty());
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("keep")
        );
    }

    #[test]
    fn merge_propagates_a_remote_tombstone_when_newer() {
        // A newer remote tombstone deletes a live local record.
        let local = vec![rec("a", 1, false, "live")];
        let remote = vec![rec("a", 5, true, "live")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["a".to_string()]);
        assert!(crate::jsonstore::is_deleted(&merged[0]));
        // live() then hides it.
        assert!(crate::jsonstore::live(merged).is_empty());
    }

    #[test]
    fn merge_rekeys_an_inserted_remote_id_to_avoid_collision() {
        // Both devices independently assigned id:1 to DIFFERENT records (different uuids).
        let local = vec![json!({
            "id": 1, "uuid": "local-uuid",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "a" }, "deleted": false
        })];
        let remote = vec![json!({
            "id": 1, "uuid": "remote-uuid",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "b" }, "deleted": false
        })];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["remote-uuid".to_string()]);
        assert_eq!(merged.len(), 2);
        // The two records keep distinct ids so a renderer `remove {id}` can't hit both.
        let ids: Vec<i64> = merged
            .iter()
            .filter_map(|r| r.get("id").and_then(Value::as_i64))
            .collect();
        assert_eq!(ids.len(), 2);
        assert_ne!(
            ids[0], ids[1],
            "the inserted remote id must be re-keyed: {ids:?}"
        );
    }

    /// The single-insert test above cannot see the bug this one exists for: `next_id_optimized`
    /// answers from a process-global cache keyed by store name and ignores its `items`
    /// argument, and inside `merge_records` the local array never round-trips through
    /// `load`/`save` — so the cache stayed pinned at the value computed before the loop and the
    /// SECOND insert in the same batch was handed the id the first one had just taken. Two
    /// favorites sharing an id means `remove {id}` tombstones both and `update {id}` rewrites
    /// both.
    ///
    /// Driven through the real `merge_into` seam, NOT `merge_records` directly: the bug only
    /// reproduces when `NEXT_ID_CACHE` is warm, and it is `read_all` → `load` that warms it, in
    /// production and here alike. A test that called `merge_records` with a hand-built array
    /// would leave the cache cold, take the O(n) fallback, and pass against the broken code.
    #[test]
    fn two_remote_inserts_in_one_batch_get_distinct_ids() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            let remote = vec![
                json!({
                    "id": 7, "uuid": "remote-a", "url": "https://a.test/",
                    "hlc": { "wall_ms": 2, "counter": 0, "node": "b" }, "deleted": false
                }),
                json!({
                    "id": 7, "uuid": "remote-b", "url": "https://b.test/",
                    "hlc": { "wall_ms": 3, "counter": 0, "node": "b" }, "deleted": false
                }),
            ];
            merge_into(app, "favorites", &remote);

            let merged = crate::jsonstore::load_synced(app, "favorites");
            assert_eq!(merged.len(), 2, "both remote records must land: {merged:?}");

            let mut ids: Vec<i64> = merged
                .iter()
                .filter_map(|r| r.get("id").and_then(Value::as_i64))
                .collect();
            ids.sort_unstable();
            assert_eq!(
                ids.len(),
                2,
                "each inserted record needs its own local id or remove/update hit both: {ids:?}"
            );
            assert_ne!(ids[0], ids[1], "batch inserts collided: {ids:?}");
        });
    }

    /// The regression guard for the 2026-09-26 data-loss incident: a remotely-inserted record
    /// MUST be given a device-local `id`, even when the wire record carries none.
    ///
    /// Wire records only ever carry `uuid / hlc / deleted / ord? / nonce / ct` — no `id` — so
    /// the old `if incoming.get("id").is_some()` guard was false for essentially every pulled
    /// record and it was stored with **no id at all**. Two things then went wrong at once: the
    /// renderer got rows whose `row.id` was `undefined` (so tapping delete sent
    /// `{ id: undefined }`), and `places.rs`'s `id_of(it) == id` predicate compared
    /// `None == None` — true for every id-less row — so ONE `saved.remove` tombstoned the entire
    /// store. That is exactly what happened: 104 `saved` tombstones sharing one `wall_ms`.
    #[test]
    fn a_pulled_record_with_no_id_is_given_a_fresh_local_id() {
        use crate::test_support::with_tmp_app;
        with_tmp_app(|app| {
            // A record exactly as the server hands it over: no `id` key at all.
            let remote = vec![json!({
                "uuid": "remote-no-id",
                "url": "https://no-id.test/",
                "hlc": { "wall_ms": 5, "counter": 0, "node": "b" },
                "deleted": false
            })];
            merge_into(app, "saved", &remote);

            let merged = crate::jsonstore::load_synced(app, "saved");
            assert_eq!(merged.len(), 1, "the record must land: {merged:?}");
            assert_eq!(
                merged[0].get("id").and_then(Value::as_i64),
                Some(0),
                "a merged record with no local id is the data-loss bug: {merged:?}"
            );
        });
    }

    #[test]
    fn merge_preserves_local_id_on_replace() {
        // Same uuid on both devices but different local ids; remote dominates by HLC.
        let local = vec![json!({
            "id": 7, "uuid": "u", "payload": "old",
            "hlc": { "wall_ms": 1, "counter": 0, "node": "a" }, "deleted": false
        })];
        let remote = vec![json!({
            "id": 99, "uuid": "u", "payload": "new",
            "hlc": { "wall_ms": 5, "counter": 0, "node": "b" }, "deleted": false
        })];
        let (merged, _) = merge_records(local, &remote, "n", 100);
        assert_eq!(
            merged[0].get("payload").and_then(Value::as_str),
            Some("new")
        );
        assert_eq!(
            merged[0].get("id").and_then(Value::as_i64),
            Some(7),
            "local id preserved"
        );
    }

    #[test]
    fn merge_skips_records_missing_uuid_or_hlc() {
        let local: Vec<Value> = vec![];
        let remote = vec![json!({ "payload": "no-meta" }), rec("ok", 1, false, "x")];
        let (merged, changed) = merge_records(local, &remote, "n", 100);
        assert_eq!(changed, vec!["ok".to_string()]); // only the well-formed one
        assert_eq!(merged.len(), 1);
    }

    // ---- local tombstone GC -------------------------------------------------
    //
    // The 2026-09-26 incident left 104 dead `saved` rows that would otherwise sit in every
    // client's store forever. `gc_tombstones` is the reaper; these pin both halves of the
    // safety rule — old tombstones go, and nothing that still carries information stays.

    /// Deliberately in the PAST relative to the real clock.
    ///
    /// `gc_tombstones` reads through `load_synced`, which calls `ensure_sync_meta` and so
    /// STAMPS A FRESH HLC (from the real clock, i.e. "now") onto any record that lacks one.
    /// If this constant were set in the future, that fresh stamp would fall *before* the
    /// cutoff and the record would be reaped — which is exactly how the
    /// "no parseable HLC is kept" test first failed (`left: 1, right: 0`). A past constant
    /// keeps a freshly-stamped row comfortably on the young side of the horizon.
    const NOW: i64 = 1_700_000_000_000i64;

    #[test]
    fn gc_reaps_a_tombstone_older_than_the_horizon() {
        crate::test_support::with_tmp_app(|app| {
            let old = json!({
                "uuid": "aaaa", "url": "https://a.test/",
                "hlc": { "wall_ms": NOW - TOMBSTONE_GC_AGE_MS - 1, "counter": 0, "node": "n" },
                "deleted": true,
            });
            let keep = json!({
                "uuid": "bbbb", "url": "https://b.test/",
                "hlc": { "wall_ms": NOW - TOMBSTONE_GC_AGE_MS + 60_000, "counter": 0, "node": "n" },
                "deleted": true,
            });
            let live = json!({
                "uuid": "cccc", "url": "https://c.test/",
                "hlc": { "wall_ms": NOW - TOMBSTONE_GC_AGE_MS - 1, "counter": 0, "node": "n" },
                "deleted": false,
            });
            crate::jsonstore::save(app, "saved", &[old, keep, live]).expect("seed the saved store");

            let reaped = gc_tombstones(app, "saved", NOW);
            assert_eq!(reaped, 1, "exactly the expired tombstone should be reaped");
            let left = crate::jsonstore::load(app, "saved");
            let uuids: Vec<&str> = left
                .iter()
                .filter_map(|v| v.get("uuid").and_then(Value::as_str))
                .collect();
            assert_eq!(
                uuids,
                vec!["bbbb", "cccc"],
                "the recent tombstone AND the live row must both survive"
            );
        });
    }

    #[test]
    fn gc_keeps_a_tombstone_exactly_at_the_cutoff() {
        // The retain test is `h.wall_ms >= cutoff`, so a tombstone landing exactly on the
        // cutoff is KEPT. That is the conservative side: reaping it would need the horizon
        // to be one millisecond larger, and a clock that reads a hair differently on two
        // devices must not decide that a delete is old enough to forget.
        crate::test_support::with_tmp_app(|app| {
            let at_cutoff = json!({
                "uuid": "dddd", "url": "https://d.test/",
                "hlc": { "wall_ms": NOW - TOMBSTONE_GC_AGE_MS, "counter": 0, "node": "n" },
                "deleted": true,
            });
            crate::jsonstore::save(app, "saved", &[at_cutoff]).expect("seed the saved store");
            assert_eq!(gc_tombstones(app, "saved", NOW), 0);
            assert_eq!(crate::jsonstore::load(app, "saved").len(), 1);
        });
    }

    #[test]
    fn gc_keeps_a_tombstone_that_arrives_without_an_hlc() {
        // A record with no `hlc` is the case the `None =>` arm defends. It is NOT reachable
        // through this entry point: `gc_tombstones` reads via `load_synced`, and
        // `ensure_sync_meta` stamps a fresh HLC on anything missing one, so by the time the
        // retain runs the record is datable and young. Probing `None => false` (i.e. reaping
        // the undatable case) leaves this test GREEN — proof the arm is defence-in-depth
        // rather than load-bearing, and that this test pins the *outcome* (a tombstone with
        // no HLC of its own is kept) rather than that specific branch.
        //
        // The arm is kept anyway: it is one line, it is the safe direction, and a future
        // change to the read path must not silently turn "undatable" into "delete".
        crate::test_support::with_tmp_app(|app| {
            let undatable = json!({
                "uuid": "eeee", "url": "https://e.test/", "deleted": true,
            });
            crate::jsonstore::save(app, "saved", &[undatable]).expect("seed the saved store");
            assert_eq!(gc_tombstones(app, "saved", NOW), 0);
            assert_eq!(crate::jsonstore::load(app, "saved").len(), 1);
        });
    }

    #[test]
    fn gc_is_idempotent_and_never_reports_a_reap_it_did_not_persist() {
        crate::test_support::with_tmp_app(|app| {
            let old = json!({
                "uuid": "ffff", "url": "https://f.test/",
                "hlc": { "wall_ms": NOW - TOMBSTONE_GC_AGE_MS - 1, "counter": 0, "node": "n" },
                "deleted": true,
            });
            crate::jsonstore::save(app, "saved", &[old]).expect("seed the saved store");
            assert_eq!(gc_tombstones(app, "saved", NOW), 1);
            // A second pass has nothing left to do and must not claim otherwise, otherwise the
            // `[aegis-sync] reaped N` log line becomes a lie the user cannot act on.
            assert_eq!(gc_tombstones(app, "saved", NOW), 0);
            assert!(crate::jsonstore::load(app, "saved").is_empty());
        });
    }

    #[test]
    fn key_field_for_picks_host_only_for_allowlist() {
        assert_eq!(key_field_for("allowlist"), "host");
        assert_eq!(key_field_for("favorites"), "url");
        assert_eq!(key_field_for("saved"), "url");
    }
}
