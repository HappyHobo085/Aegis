# sync-server/core — `aegis-sync-core`

The protocol core shared by both sync servers: the ACTIVE WASM service (`../wasm`) and the
DEPRECATED axum server (`../legacy-docker`). It is its own workspace with its own `Cargo.lock`, and
both servers path-depend on it. Meshnode vendors this folder byte-for-byte from
`sync-server/core` (its `scripts/sync-aegis-core.sh` + `vendor/VENDORED.md`), so **this path is a
cross-repo contract: do not move or rename it.**

## What it is

`aegis-sync-core` is the PURE protocol crate: no axum, no tokio, no files, no OS
clock or randomness. It exists so the same protocol code can run natively (the deprecated
`../legacy-docker` server) and as the WASM service (`../wasm`, the active server; Meshnode vendors
this crate too). So far it holds:
- `auth.rs` — `AuthToken`, `canonical`, `unhex`, `is_canonical_hex`, the TTL/skew/nonce
  constants, `verify_account_root`, `constant_time_eq`, and **`check_token(token, now_ms,
  sig_hex) -> Result<Verified, AuthError>`**: every stateless check `verify_auth` used to make
  inline (canonical ids, nonce shape, lifetime bounds, signature), in the same order, with a
  typed reason per refusal (all of them are still a plain `401` on the wire).
- `wire.rs` — `WireRecord` (pub fields), `hlc_key`, `ord_key`, `hlc_well_formed`,
  `wire_bytes`, `MAX_HLC_NODE_LEN` and every request/response bound (`MAX_RECORDS_PER_*`,
  `MAX_FIELD_LEN`, `MAX_CT_LEN`, `MAX_LABEL_LEN`, `MAX_BODY_BYTES`, the server-wide `MAX_*`
  caps, `MAX_RESPONSE_*`). **The byte caps `MAX_TOTAL_CT_BYTES` and `MAX_RESPONSE_BYTES` are
  `u64`**, and so is every counter compared against them (`Caps.max_total_ct_bytes`, the push
  path's `growth`/`total`, the page's `bytes`): 4 GiB does not fit wasm32's 32-bit `usize`, so
  as `usize` the core did not compile for the WASM service. On 64-bit native nothing changes.
- `canon.rs` — `content_digest`, `content_pass`, `unique_uuid`, `canonicalize_body`,
  `reject_client_poisoning_stamps` (bodies and comments moved unchanged). Two seams changed:
  `unique_uuid(rec, ns, taken, entropy: &mut dyn Entropy)` draws its collision separator from
  the host, and `canonicalize_body(records, ns, existing, entropy)` takes the `(uuid, record)`
  pairs already stored in the `(account, ns)` instead of the native `Store`. The test-only
  `CONTENT_PASSES` instrument moved with `content_pass`; the server's tests reach it through the
  core's `test-instrument` feature, which only the server's `[dev-dependencies]` entry enables,
  so a release binary never carries it (`cargo tree -e features` shows only `default`).
- `page.rs` — `page_sorted(sorted, cursor, limit) -> Page { records, next }`: the paging core of
  `GET /v1/records` over an iterator already in uuid order. It enforces BOTH response caps
  (`MAX_RESPONSE_RECORDS` via the `limit` clamp, `MAX_RESPONSE_BYTES` with the always-serve-the-
  first-record rule) exactly as `page_records` did; `page_records` now only selects + sorts the
  namespace and calls it.
- `order.rs` (new, for the mesh service) — `order_bytes(hlc)`: `wall_ms` big-endian with the
  sign bit flipped, `counter` big-endian `u64`, then the `node` bytes, so byte order equals
  `hlc_key` order (a property test pins it). `tie_ord(rec)`: the mesh's cross-uuid tie-break,
  `{wall_ms, counter, node + "~" + first 8 hex of content_digest([uuid])}` with `node`
  truncated to keep the result within `MAX_HLC_NODE_LEN`. It is a function of `(hlc, uuid)`
  alone, so every replica agrees without coordinating, and it is shaped to pass the client's
  `ord_is_adoptable`. **The native server does NOT use it** — it keeps its own counter-bump rule
  in `canonicalize_body`, which needs to see the whole stored namespace at once. `order_bytes`
  values must be compared WHOLE: the encoding is not prefix-free (`node` runs to the end).
- `devices.rs` (new, for the mesh service) — `DeviceFacts`, `AccountFacts` (grow-only
  `devices`, `pending`, `approved` (device id → `approved_ms`, the earliest approval; a
  replicated host stores `ApprovedFact`s and folds them with `AccountFacts::approve`),
  `revoked`, and `labels`: `LabelFact`s recording that a member's re-registration refreshed
  its label, as the native `post_device` does; all serde, which is the vectors' `given`
  shape), `label` (the newest label fact, else the registration label), `is_member`
  (registered, not revoked, not pending), `is_pending`, `owner` and `may_remove`. **`owner`
  ranks the members: devices that never had to ask to join first, by (`registered_ms`, id);
  then approved joiners, by (`approved_ms`, id); revoked devices never.** That is "first device
  is owner", and D5's hand-off when it signs out. The never-pending rank comes first because
  `registered_ms` is a node's wall clock, and clock skew between mesh nodes could give an
  approved joiner an earlier one than the account's creator. Joiners rank by APPROVAL time so
  that approving a device that asked earlier never moves the role off the approving owner
  (native keeps a stored owner that only moves on sign-out; vector
  `devices_owner_stays_after_later_approval`). Natively the D5 heir is the earliest-REGISTERED
  remaining device; the two agree when joiners were approved in the order they asked. `may_remove` refuses an actor that is not a member
  (`DeviceRefusal::NotOwner` = 403, as the native `require_registered`), then a non-owner
  removing someone else (403), then the last member (`LastDevice` = 409). **The native server
  does NOT use it**: it keeps its stored owner map.
- `env.rs` — the traits `Clock { fn now_ms(&self) -> i64 }` and `Entropy { fn fill(&mut self,
  buf: &mut [u8]) }`, and nothing else. Anything in the core that needs the time takes the
  instant (or a `Clock`) from its caller; the host supplies the implementation.
- `vector.rs` — **test-only, behind the non-default `vectors` feature**: the contract-vector
  types (`Vector`, `Given`, `Req`, `Expect`, `Step`), `load_all(dir)` (reads, expands the
  `{{…}}` templates with the fixed test keys, validates), `check` / `subset` (the shared
  response comparison), `NOW_MS` and the key helpers. Only test code enables the feature: the
  core's own `[dev-dependencies]` self-entry (for `tests/vectors.rs`) and the server's
  `[dev-dependencies]`. `cargo tree -e features -i aegis-sync-core -e normal` must keep showing
  only `default`, and the wasm32-wasip2 check runs without it.

## Rules

- The code moved out of the original axum server with its bodies and comments unchanged; only
  `pub` was added, plus the seams listed above. `LICENSE` is the AGPL text.
- `rust-version` MUST equal `src-tauri/Cargo.toml` and `../wasm/Cargo.toml` (the CI `msrv` job
  reads all three manifests).
- PURE: no new I/O dependencies. Anything needing time or entropy takes `env::Clock` /
  `env::Entropy`.
- **Hard rule:** the auth `canonical()` serialization and the token shape in `src/auth.rs` MUST
  stay **byte-for-byte identical** to `src-tauri/src/sync_auth.rs` (a round-trip test guards the
  shape). Change one, change the other in the same commit.

## Test

`cargo test` here (or `cargo test --manifest-path sync-server/core/Cargo.toml` from the repo root).

- **Unit tests** (42, `cargo test --lib`): `canonical`, every `check_token` refusal at its exact boundary,
  `hlc_well_formed`, `wire_bytes` and the HLC keys against a fixed clock; `order_bytes` against
  `hlc_key` (a deterministic property test, negative walls included); the `tie_ord` rule (keeps
  wall+counter, deterministic, distinct per uuid, node within 64 bytes, well-formed for the
  client); the device-facts rules (owner ranking incl. never-pending-first, `is_member`, `label`,
  `may_remove` refusing non-members); `page_sorted`'s cursor/next/byte budget; and
  `unique_uuid`/`canonicalize_body` under injected entropy.
- **Contract vectors** (`tests/vectors/*.json`; format, fixed keys and fixed clock in that
  directory's `README.md`). The same files run against every host:
  - `tests/vectors.rs` (4 tests, here): the set is complete, host marks are at most two, the
    templates sign correctly, `subset` semantics, and every mesh-runnable vector through a pure
    in-memory model built only from core functions (facts, computed owner, `tie_ord`).
  - `../legacy-docker/src/vectors_native.rs`: every native-runnable vector through the deprecated
    axum router (not in CI).
  - Meshnode's harness (`crates/mesh-services/tests/aegis_sync.rs` in the Meshnode repo): every
    mesh-runnable vector through the WASM service (`../wasm`) on its runtime.
  - A vector may be `native_only` / `mesh_only` with a reason. Today only the cross-uuid tie pair
    is marked (native counter bump vs mesh `tie_ord`). Prefer `body_subset` over a mark when the
    hosts differ only in body detail. **A behaviour change to the contract means changing a
    vector**, and Meshnode then has to re-vendor the core
    (its `scripts/sync-aegis-core.sh` reads this folder at `sync-server/core`: do not move it).
- It must also pass `cargo check --target wasm32-wasip2` (without the test-only features) and
  `RUSTDOCFLAGS="-D warnings" cargo doc --no-deps --all-features` cleanly. CI runs fmt, clippy,
  test, both of those, and `cargo audit` in the `sync-server` job.
