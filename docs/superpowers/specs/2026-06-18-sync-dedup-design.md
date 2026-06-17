# Automatic sync deduplication — design

**Date:** 2026-06-18
**Status:** Approved (brainstorming), pending implementation plan
**Topic:** Collapse duplicate records created by independent cross-device adds during sync

## Problem

Sync keys records by `uuid` with HLC last-writer-wins (`sync_stores::merge_records`). When the
same item is added independently on two devices it gets two different `uuid`s, so after syncing
it appears **twice**. Single-device adds already guard locally (`saved.add` checks
`live_has_url`); this is the cross-device case. Dedup collapses such duplicates automatically.

## Decision (from brainstorming)

Auto-merge on **normalized URL** (favorites/saved) / **host** (allowlist), during the sync
merge, with a deterministic survivor and tombstoned losers so all devices converge.
Normalization = ignore trailing `/` + `#fragment` (no path/query case-folding). Host lowercased.

## Where it runs

Inside `sync_stores::merge_into` (`sync_stores.rs`), **after** `merge_records` produces the
merged `Vec<Value>` and **before** `jsonstore::save`. Per namespace, every sync pull. `merge_into`
already owns the merged set, saves, returns `changed`, and re-seeds ad-block for the allowlist —
the dedup tombstones slot in there and are appended to `changed`.

## The decision — pure, unit-tested

`fn duplicate_losers(records: &[Value], key_field: &str) -> Vec<String>`:

1. Consider **live** records only (skip tombstones via `jsonstore::is_deleted`).
2. Group by **normalized key**:
   - `key_field = "url"` (favorites, saved): `normalize_url(u)` = strip from the first `#`,
     then trim one trailing `/`, then trim surrounding whitespace. Keep path + query, no case
     change (so `example.com/?id=1` and `example.com/?id=2` stay distinct).
   - `key_field = "host"` (allowlist): lowercase + trim.
3. For each group with **>1** live record, pick the **deterministic survivor** = the record
   with the **highest HLC** (`sync_envelope::from_value` + `Hlc` `Ord`; latest edit wins so a
   renamed favorite keeps its new name), tie-broken by the **lexicographically smallest `uuid`**.
4. Return the `uuid`s of all the **losers**.

This is a pure function of replicated fields (`hlc`, `uuid`) that are identical across devices,
so every device computes the same survivor → **convergent**. It is **idempotent**: losers are
tombstoned (no longer live) and thus excluded from the next pass.

## The effect — in `merge_into`

After `merge_records`: `let losers = duplicate_losers(&merged, key_field_for(name));` then
`jsonstore::tombstone(&mut merged, |it| losers.contains(uuid_of(it)), app)` (sets `deleted:true`
+ a fresh HLC that dominates the old record, so the deletion **propagates** on the next push).
Append `losers` to the returned `changed` list so they (a) get pushed and (b) trigger the UI
refetch (`emit_changed`) that drops the dupes. `key_field_for(name)`: `"url"` for
favorites/saved, `"host"` for allowlist.

## Scope

`favorites`, `saved`, `allowlist` (the full `SYNCABLE` set). Not settings / customFilters
(single-record / per-key — no dup concept). Not history (not synced).

## Convergence / tradeoff

Two favorites with the same normalized URL but different names merge into one (the
most-recently-edited survives). That is the intent of URL-based dedup — a conscious tradeoff.
No flip-flop: the survivor is a deterministic function of `(hlc, uuid)`; a device that sees a
partial group either picks the same survivor or defers until the tombstone arrives.

## Testing (cargo, mirroring `merge_records` tests in `sync_stores.rs`)

- Two live records, same `url` → the older-HLC one is in `losers`, the newest survives.
- HLC tie → smaller `uuid` survives (the other is a loser).
- `"http://h/a/"` vs `"http://h/a"` vs `"http://h/a#x"` treated as one group; `"...?id=1"` vs
  `"...?id=2"` are NOT.
- allowlist: `"Example.com"` vs `"example.com"` → one group.
- No duplicates → empty `losers` (no-op).
- A group whose extras are already tombstoned → empty `losers` (idempotent).
- Distinct URLs → untouched.
```
