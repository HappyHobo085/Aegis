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

## Storage

- In-memory `Store` behind an `Arc<Mutex<…>>`, served from `AppState`.
- Set **`AEGIS_SYNC_DATA=<path>`** to persist: the store is mirrored to a single JSON file
  (`Snapshot`), atomic-written (temp → fsync → rename) on each change and loaded on boot.
  Unset → pure in-memory (resets on restart). A corrupt data file fails loud at boot.
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
