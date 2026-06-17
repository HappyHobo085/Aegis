# Dockerized Aegis sync server — design

**Date:** 2026-06-17
**Status:** Approved (brainstorming), pending implementation plan
**Topic:** Containerize the reference `sync-server/` crate with durable storage

## Goal

Make the existing reference sync server (`sync-server/`, a standalone Rust/axum
crate added in commit `2f4d6ae`) deployable via Docker for real self-hosting.
The reference today keeps everything **in memory and wipes it on every restart**
— unacceptable for a container, which restarts/redeploys routinely. So this work
adds **durable storage** alongside the Docker scaffolding.

Non-goals: changing the HTTP/auth contract, adding a database server, bundling
TLS termination, multi-tenant scaling features.

## Decisions (settled during brainstorming)

1. **Persistence:** add durable storage (not containerize the in-memory server as-is).
2. **Backend:** a **single JSON snapshot file**, atomic-written on change, loaded
   on boot. Zero new dependencies (`serde`/`serde_json` already present); matches
   Aegis's existing "durable atomic writes everywhere" house style. Suitable for
   personal/family-scale self-hosting (data is tiny: opaque ciphertext + a short
   device list per account).
3. **TLS:** the container serves **plain HTTP**; HTTPS is delegated to a reverse
   proxy the operator runs. `DOCKER.md` documents Caddy/nginx; LAN/localhost needs none.
4. **Layout:** Docker assets live in the **`sync-server/` crate folder** (the build
   context). (`sync-server/docker/` subfolder was offered as an alternative and not chosen.)
5. **Runtime image:** Alpine/musl multi-stage build → minimal Alpine runtime, non-root.

## Architecture

The crate stays a standalone, non-workspace Rust binary. The only behavioral
change is **where the `Store` lives**: still an in-memory `Arc<Mutex<Store>>` for
serving, now optionally mirrored to disk as JSON. The HTTP surface is unchanged
except for one additive, unauthenticated `/healthz` route.

```
                 docker compose up -d
                          │
            ┌─────────────▼──────────────┐
            │  aegis-sync-server (Alpine) │   plain HTTP :8787
            │  AEGIS_SYNC_ADDR=0.0.0.0... │◀──── Aegis clients
            │  AEGIS_SYNC_DATA=/data/...  │      (Linux/Win/macOS/Android)
            └─────────────┬──────────────┘
                          │ atomic write on change / load on boot
                   ┌──────▼───────┐
                   │ named volume │  aegis-sync-data:/data
                   │ aegis-sync.json (opaque ciphertext + device list)
                   └──────────────┘

   (optional, operator-run) reverse proxy (Caddy/nginx) ── HTTPS ──▶ :8787
```

## File layout

```
sync-server/
  Dockerfile            # NEW — multi-stage: rust:alpine build (musl) → alpine runtime, non-root
  .dockerignore         # NEW — excludes target/, *.json data, etc.
  docker-compose.yml    # NEW — one service + named volume + port + healthcheck
  .env.example          # NEW — AEGIS_SYNC_PORT host-port override
  DOCKER.md             # NEW — run, backup, point-Aegis-at-it, reverse-proxy/HTTPS guide
  CLAUDE.md             # NEW — folder doc (repo convention; none exists yet)
  src/main.rs           # CHANGED — JSON persistence + /healthz endpoint + tests
  README.md             # CHANGED — replace the "swap HashMaps for a DB" paragraph
  Cargo.toml            # unchanged (no new deps)
  Cargo.lock            # unchanged
```

## Component detail

### Persistence (`src/main.rs`)

- **New env var `AEGIS_SYNC_DATA`** — path to the JSON file. **Unset → pure
  in-memory** (preserves the current reference behavior and all existing tests).
- **On-disk shape.** The live `Store` is keyed by tuples
  (`(account, ns, uuid)`) which JSON can't use as map keys. Introduce a flat,
  serializable mirror:

  ```rust
  #[derive(Serialize, Deserialize, Default)]
  struct Snapshot {
      records: Vec<SnapRecord>, // { account, ns, record: WireRecord }
      devices: Vec<SnapDevice>, // { account, device: Device }
  }
  ```

  `Snapshot::from(&Store)` flattens; `Store::from(Snapshot)` rebuilds the maps.
- **Load on boot:** if `AEGIS_SYNC_DATA` is set and the file exists, deserialize
  into the `Store`. A missing file is fine (fresh start). A corrupt/unparseable
  file is a hard error at boot (fail loud rather than silently start empty).
- **Atomic write on change:** after a mutation that actually changes state
  (`post_records` where a record wins LWW, `post_device`, `remove_device`):
  1. build the `Snapshot` while holding the `Mutex` (cheap clone),
  2. **release the lock**,
  3. write to `{path}.tmp`, `flush` + `sync_all`, `rename` over `{path}`.

  Releasing the lock before disk I/O keeps requests from blocking on `fsync`.
  No-op stale POSTs (records that lose LWW) do **not** trigger a rewrite.
- **Concurrency note:** two mutations could race on the temp file. Use a
  per-path write guard (a dedicated `Mutex<()>` for the writer, or include the
  PID/sequence in the temp name) so concurrent atomic writes don't clobber each
  other's `.tmp`. The last completed rename wins, which is correct since each
  writer serializes a full current snapshot.

### `/healthz`

`GET /healthz` → `200 {"ok":true}`, no auth, no account data. Wired in `app()`.
Consumed by the compose `healthcheck` and usable by any reverse proxy/load balancer.

### Dockerfile

- **Builder stage:** `rust:alpine`. `COPY Cargo.toml Cargo.lock ./` then `src/`,
  `cargo build --release --locked` (Alpine's default target is musl → static-ish
  binary). Optional: a dependency-cache layer (dummy `main.rs` first) — nice-to-have,
  not required for the reference.
- **Runtime stage:** minimal `alpine`. Copy only the binary to
  `/usr/local/bin/aegis-sync-server`. Create + run as a **non-root user**; ensure
  `/data` is writable by it. `EXPOSE 8787`. `VOLUME /data`. Default envs
  `AEGIS_SYNC_ADDR=0.0.0.0:8787`, `AEGIS_SYNC_DATA=/data/aegis-sync.json`.
  `ENTRYPOINT ["/usr/local/bin/aegis-sync-server"]`.
- ed25519-dalek is pure Rust and the server makes no outbound TLS calls, so **no
  OpenSSL/ca-certificates** are needed. `scratch`/distroless is noted in `DOCKER.md`
  as an optional further-hardening swap.

### docker-compose.yml

```yaml
services:
  sync:
    build: .
    image: aegis-sync-server
    restart: unless-stopped
    ports:
      - "${AEGIS_SYNC_PORT:-8787}:8787"
    environment:
      - AEGIS_SYNC_ADDR=0.0.0.0:8787
      - AEGIS_SYNC_DATA=/data/aegis-sync.json
    volumes:
      - aegis-sync-data:/data
    healthcheck:
      test: ["CMD", "wget", "-qO-", "http://127.0.0.1:8787/healthz"]
      interval: 30s
      timeout: 3s
      retries: 3
volumes:
  aegis-sync-data:
```

(`wget` ships in the Alpine runtime; if the image is slimmed below that, swap the
healthcheck to a tiny `--health` flag on the binary — noted as a follow-up.)

### DOCKER.md

Sections: quick start (`docker compose up -d`); data location + backup (the JSON
is opaque ciphertext + a device list, safe to store/transfer anywhere); pointing
Aegis at it (**Settings → Sync → Server URL** = `http://host:8787`, then Start
new sync / Restore from recovery phrase); **reverse-proxy/HTTPS** with ready Caddy
and nginx snippets and a note that LAN/localhost needs no TLS; updating
(`docker compose build && up -d`; the volume persists data).

### README.md change

Replace the paragraph that says the store is in-memory and to "swap the
`HashMap`s in `src/main.rs` for a database or disk-backed store" with the new
truth: set `AEGIS_SYNC_DATA` for durable JSON persistence (or run via Docker,
which sets it), and point to `DOCKER.md`.

### CLAUDE.md (new, `sync-server/`)

Short folder doc per repo convention: what the crate is (standalone reference
E2E-sync server, ciphertext-only), the persistence model + `AEGIS_SYNC_DATA`/
`AEGIS_SYNC_ADDR` envs, the `/healthz` route, the **hard rule that `canonical()`
+ token shape must stay byte-identical to `src-tauri/src/sync_auth.rs`**, and the
Docker workflow. Also add `sync-server/` to the folder map in the root `CLAUDE.md`
(it predates this crate and omits it).

## Testing

- **Keep** the 4 existing cargo tests green.
- **Add** unit tests:
  - `Snapshot` round-trip: `Store` → `Snapshot` → `Store` preserves records + devices.
  - Save → load via a temp directory yields an equal store.
  - `/healthz` returns `200 {"ok":true}`.
  - (Optional) a stale-losing POST does not change the on-disk snapshot.
- **Manual durability proof** (in the plan, not CI): `docker compose up -d` →
  register a device + post a record → `docker compose restart` → `GET /v1/records`
  still returns the record (proves the volume + load-on-boot path end to end).
- **Build proof:** `docker build sync-server/` succeeds; `docker compose up` then
  `curl http://localhost:8787/healthz` returns ok.

## Client parity

Preserved by construction. The change is storage-internal plus one additive,
unauthenticated route — the `/v1/records` and `/v1/devices` request/response bytes
and the `AegisSig` auth are unchanged. So Linux, Windows, macOS, and Android
clients are unaffected; no per-platform work is required (satisfies the root
CLAUDE.md "all platforms on the same level" rule for this server-side change).

## Risks / open items

- **Snapshot rewrite cost** grows with total record count (whole-file rewrite per
  change). Fine at personal/family scale; if a deployment ever outgrows it, the
  SQLite path (considered and deferred) is the upgrade. Note this in `DOCKER.md`.
- **Corrupt-file handling**: fail loud at boot (chosen) vs. quarantine-and-restart.
  Chosen behavior avoids silent data loss; documented so operators know to restore
  from backup.
- **Healthcheck tool dependency** (`wget`) ties us to an Alpine runtime that
  includes busybox; revisit if we move to `scratch`.
