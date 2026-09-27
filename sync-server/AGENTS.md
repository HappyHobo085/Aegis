# sync-server — project guide

A **standalone** Rust/axum crate (NOT a workspace member of the Tauri app — it builds and
deploys independently) implementing Aegis's self-hosted, end-to-end-encrypted sync server.
It stores **opaque ciphertext only**: it never holds encryption keys and cannot decrypt
bookmarks, saved items, or the allowlist.

## What it does

Implements the sync HTTP contract (see `README.md` for the table): HLC last-writer-wins
record upsert (`/v1/records`), device registration/listing/removal (`/v1/devices*`), and an
unauthenticated liveness probe (`/healthz`). Auth is the per-device Ed25519 `AegisSig` token;
device registration additionally requires an account-root signature, so only a holder of the
recovery phrase can register a device.

## Device ownership + revocation

Removal is **real** revocation, not a registry edit. The two facts that make it work:

- **Every device on an account derives the SAME account key** (`HKDF(root, "account-sign")`) from
  the recovery phrase. A self-hosted server therefore **cannot** tell the owner from a paired
  device using the account key alone — so a device you "removed" could simply re-register, and any
  paired device could evict any other, including the owner. Both were true before this shipped.
- **The missing state is held server-side** (the one place a removed device cannot write):
  `Store.revoked: HashSet<(account, deviceId)>` is a permanent deny-list consulted by
  `post_device` (`403` on a hit), and `Store.owner: HashMap<account, deviceId>` records the
  **first** device to register, set with `or_insert_with` and deliberately **never cleared by
  `remove_device`** (clearing it would hand the role to whoever acted next). Removing *another*
  device requires being the owner; removing *yourself* is always allowed — that is sign-out, and
  it correctly ends in revocation.
- **The last device cannot be removed** (`409`). Revocation is permanent by design, so allowing it
  would lock the account out of its own server with no in-band recovery.
- Both maps are **persisted** (`Snapshot.revoked` / `.owners`, all `#[serde(default)]`, written
  sorted so an unchanged store rewrites an identical file). In-memory-only would have made
  revocation a speed bump that a restart undoes.
- **Operator recovery for a lost owner device:** the operator — who owns the data file, and is the
  root of trust for a self-hosted server — deletes that account's `owner` entry from
  `aegis-sync.json` and restarts. This is deliberately out-of-band: there is no in-app path, because
  an in-app path would be reachable by the very device being recovered from.

## Hardening (replay + quotas)

- **Replay defense:** `verify_auth` records each spent `(device, nonce)` pair (after the
  signature verifies) and rejects a repeat — a captured `Authorization` header can't be
  replayed. The set is bounded by the token TTL (expired entries are swept) and is in-memory
  (a restart forgets it → a token captured pre-restart could replay within its ≤5-min TTL).
  **Client compat:** the client mints a FRESH nonce per HTTP request (`sync::sync_ns` no longer
  reuses one token across the GET+POST); an OLD client that reuses a token will have its second
  request rejected — update client + server together.
- **Quotas** (constants near the handlers): per-request record count (`MAX_RECORDS_PER_REQUEST`),
  per-field lengths (`MAX_FIELD_LEN` for ns/uuid/nonce, `MAX_CT_LEN` for ciphertext, `MAX_LABEL_LEN`)
  → `413`; per-account total records (`MAX_RECORDS_PER_ACCOUNT`) → `507`; plus a coarse
  `DefaultBodyLimit` (`MAX_BODY_BYTES`). A registered-but-malicious paired device can't OOM the
  process or fill disk. Updates to existing records bypass the per-account cap (no growth).
- **Two record-stamp bounds, enforced by `reject_client_poisoning_stamps` on every push.** A stamp
  the server HOSTS is a stamp it hands to every peer, so a bad one is a namespace-wide problem,
  and the damage is permanent rather than a lost LWW comparison:
  - `wall_ms` more than `MAX_FUTURE_SKEW_MS` ahead of server time → **rejected**. HLC receive is
    an unbounded `max` against an observed remote stamp, so one `wall_ms: i64::MAX` record would
    pin every peer's process-global clock permanently and no later edit could ever win.
  - `counter` wider than **`u32::MAX`** → **rejected**. `hlc_key` reads the counter as `u64` so it
    can order anything, but the client's `Hlc.counter` is a `u32` and `sync_envelope::from_value`
    deserializes with serde, which **errors** on an out-of-range integer instead of truncating —
    so such a record is unopenable by every client, and unrecoverable: the counter lives inside
    the AEAD-bound `hlc`, so the server cannot rewrite it into range, and the per-uuid LWW gate
    lets the poison outrank every legitimate rewrite of that id. One push would brick one uuid on
    every device, forever.

  Both are **rejected, never rewritten** — clamping either field would invalidate the AEAD tag
  and recreate exactly the undecryptable-forever state. A stamp in the *past* is harmless (LWW
  just loses), so only the future and the width are policed. `u32::MAX` itself is in range and
  is accepted: the client now carries into the wall instead of overflowing on it.
- **The cross-uuid HLC tie-break is a FUNCTION OF THE BODY, not of `HashMap` order.** Step 3 of
  `canonicalize_body` hands out reserved `ord` counters when two different ids carry the same HLC,
  which is what makes LWW total instead of map-iteration-ordered. It used to walk `result`, which
  step 2 builds by iterating a `HashMap` — so the first record to arrive kept the client's original
  counter and the rest got `+1, +2, …` **in hash order**. The same body therefore produced different
  `ord` values on different server processes and across restarts, and two servers replaying one
  batch handed clients different orderings for identical content. `result` is now `sort_by`'d on
  `(wall, counter, node, uuid)` — `uuid` is unique after step 2, which is exactly what makes the
  sort total, and it must precede the move-consuming loop because `hlc_key` borrows. The occupied
  counters are tracked as a per-`(wall, node)` `BTreeSet` so the walk can jump to the next free
  slot instead of scanning, and the walk terminates on `checked_add` rather than saturating: a
  saturating add at the ceiling would loop forever. The old `MAX_HLC_TIE_BREAKS` cap is gone
  (the constant survives `#[cfg(test)]` for a regression test) — it made the ordering **non-total**
  again for clusters larger than the cap, which a body of up to `MAX_RECORDS_PER_REQUEST` records
  can reach. Its doc had claimed a record past the cap "keeps the last counter it reached, which is
  still deterministic"; both halves were wrong — the counter depended on hash order, so it was not
  deterministic, and the counter it kept was one an earlier record in the batch already held.
- **Tombstone retention is a COUNT *and* an AGE — `max(newest-N, younger-than-the-floor)`.**
  `TOMBSTONE_RETENTION_PER_NS` (500) alone was not a safety property: one bulk delete ("clear all
  history", or the vault bulk delete, which the push path's own comment calls "hundreds of
  tombstones in one request") writes more than that in a single namespace at once, and a pure count
  evicts the surplus **while it is seconds old**. Every device that was offline during that delete
  has then never been told, and re-pushes its stale copies on its next sync, resurrecting exactly
  the rows the user just deleted — the failure the retention doc above already claimed could not
  happen. `TOMBSTONE_MIN_AGE_MS` (90 days) is the other bound, chosen against the **client's** own
  30-day tombstone GC: the server deliberately outlives it so it can still answer a device away
  longer than the client-side window. It is a deliberate size/behaviour trade — a namespace may now
  hold more than 500 tombstones for as long as they are younger than the floor. The clock is read
  **once** per reap, so both bounds see the same instant.
- **A pull reaps only the namespace it serves; a push reaps every namespace.** `prune_tombstones_in`
  takes an `Option<&str>`, and `get_records` passes `Some(ns)`. Reaping other namespaces from a
  *read* was pure waste: `post_records` already reaps everything on every push, so the only
  tombstones that can outlive a reap were created since the last push, and the next push collects
  them. `Snapshot::from_store_compacting` passes `None` and must stay that way. **Honest limit:** this
  bounds the work that *allocates and removes* (the doomed set, the cloned-key `HashSet`, the
  removals) to one namespace, but it does **not** bound the scan of `store.records` itself, because
  the store has no namespace→records index. Fixing that means maintaining such an index in `Store`
  and touching every insert/remove site — a structural change, deliberately not smuggled in beside
  a bug fix.
- **Two audit findings investigated and found NOT to be defects.** Recorded so the next reader does
  not re-raise them (both have passing tests that are *guards*, not defect witnesses):
  - *"A prune on the first write path is discarded."* `post_records` calls `prune_tombstones(&mut g)`
    before the merge, drops the return, and never sets `changed = true`; the second call after the
    merge therefore always returns 0, so no `persist()` runs. **The conclusion is right and the
    consequence is not.** EVERY write to the snapshot goes through `Snapshot::from_store_compacting`,
    which evaluates the *identical* `tombstones_past_retention` predicate — so a tombstone a reap
    would drop is already absent from the file. The in-memory store is a superset of the file by
    construction, a reap only moves memory *toward* the file, and skipping the persist changes
    nothing observable. `a_reap_cannot_be_undone_by_a_restart_because_it_never_reached_the_file`
    proves it: the file is byte-identical across such a push, and a reloaded store has nothing left
    to reap. (Residual, stated rather than overclaimed: between two writes, tombstones can become
    age-doomed without being count-doomed, so the file can briefly hold one a later prune would drop.
    That is staleness bounded by the retention window, not data loss, and the next write reaps it.)
  - *"`duplicate_losers` is not order-independent."* That function is in the **client**
    (`src-tauri/src/sync_stores.rs`), not here, and the claim is false. `Iterator::max_by` returns
    the last maximum only on an `Equal` verdict, and the `ub.cmp(ua)` tiebreak returns `Equal` iff
    the uuids are equal — which requires *both* uuids and HLCs to match, making the maximum unique.
    The premise also cannot arise: `duplicate_losers` runs on `merged`, the output of
    `merge_records`, which is keyed by uuid. `duplicate_losers_is_independent_of_input_order` settles
    it by running **all 24** permutations of a 4-record group (iterative `permutations` helper, no
    `itertools`) and requiring an identical loser set from each, with `assert_eq!(checked, 24)` so
    sampling cannot pass as enumeration.
- **Pull pagination: `MAX_RESPONSE_RECORDS` is a PAGE size, not a `413` cliff.** It used to be a
  hard refusal — `get_records` returned `413` the moment a namespace reached 5,000 records, while
  `MAX_RECORDS_PER_ACCOUNT` (50,000) means a namespace can legitimately grow past it, so such a
  namespace could **never be pulled again** by any client. `GET /v1/records` now takes
  `?limit=&cursor=`, sorts the namespace by `uuid` (the store is a `HashMap`, so the old iteration
  order was non-deterministic and no cursor could have been meaningful), and returns
  `{"records": [...], "next": "<uuid>|null"}` where `next` is the **last served uuid** and the
  client's retain is `uuid > cursor`. The response is **additive**, so a client that ignores
  `next` still gets a valid page and stops, exactly as before. `limit` is clamped to
  `1..=MAX_RESPONSE_RECORDS`, and the byte budget always serves at least the FIRST record —
  refusing it would hand back a non-advancing cursor and spin the client loop forever.

## Storage

- In-memory `Store` behind an `Arc<Mutex<…>>`, served from `AppState`.
- Set **`AEGIS_SYNC_DATA=<path>`** to persist: the store is mirrored to a single JSON file
  (`Snapshot`), atomic-written (temp → fsync → rename) on each change and loaded on boot.
  Unset → pure in-memory (resets on restart). A corrupt data file fails loud at boot.
- **`persist_blocking` takes the `writer` lock BEFORE it snapshots.** Snapshotting under `db`,
  releasing it, and only then taking `writer` lets two concurrent persists interleave as
  *A snapshots → B fully persists → A writes*, leaving the file holding the OLDER snapshot. The
  file is the only thing that survives a restart, so if the lost mutation was the last one, it is
  lost for good — and "the next persist re-writes current state" only holds if another mutation
  ever arrives, which is exactly what a quiet server does not do. `db` is still released before
  `save_snapshot`, so reads and other mutations are never blocked by disk I/O; only
  persist-vs-persist is serialized, which it must be anyway (both share one `.tmp` file).
  Note the test pins the LOCK ORDER, not the interleaved outcome: a two-thread outcome test for a
  futex-based mutex cannot be made deterministic without being able to choose which thread wins.
- **`AEGIS_SYNC_ADDR`** sets the listen address (default `127.0.0.1:8787`).

## Hard rule

The auth `canonical()` serialization and the token shape in `src/main.rs` MUST stay
**byte-for-byte identical** to `src-tauri/src/sync_auth.rs` (a round-trip test guards the
shape). Change one, change the other in the same commit.

## Docker

`Dockerfile` (multi-stage Alpine/musl → minimal Alpine, non-root) + `docker-compose.yml`
(named volume at `/data`, plain HTTP on 8787, `/healthz` healthcheck). See `DOCKER.md` for
running it and putting a reverse proxy in front for HTTPS. The container serves plain HTTP;
TLS is the operator's reverse proxy.

## Test

`cargo test` (run from this folder, or `cargo test --manifest-path sync-server/Cargo.toml`
from the repo root). Covers HLC ordering, auth canonical shape, account-root registration,
and the snapshot save/load round-trip.
