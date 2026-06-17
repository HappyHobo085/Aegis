# Dockerized Sync Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the reference `sync-server/` crate deployable via Docker with durable, restart-surviving storage.

**Architecture:** Keep the standalone Rust/axum binary and its exact HTTP/auth contract. Mirror the in-memory `Store` to a single JSON file (atomic-write on change, load on boot) gated by a new `AEGIS_SYNC_DATA` env var. Add an additive unauthenticated `/healthz` route. Ship a multi-stage Alpine/musl Dockerfile + compose + docs. The container serves plain HTTP; HTTPS is delegated to an operator-run reverse proxy.

**Tech Stack:** Rust 2021, axum 0.7, tokio, serde/serde_json (no new deps), ed25519-dalek; Docker (Alpine/musl).

**Test gate for this crate:** `cargo test --manifest-path sync-server/Cargo.toml` (the npm suite tests the Tauri app and is unaffected by this server-only change).

**Spec:** `docs/superpowers/specs/2026-06-17-dockerized-sync-server-design.md`

---

## Reference: current shapes in `sync-server/src/main.rs`

These already exist (do not redefine; later tasks extend them):

```rust
#[derive(Clone, Serialize, Deserialize)]
struct WireRecord { uuid: String, hlc: Value, deleted: bool, nonce: String, ct: String }

#[derive(Clone, Serialize)]                       // Task 1 adds Deserialize here
struct Device {
    #[serde(rename = "deviceId")] device_id: String,
    label: String,
    #[serde(rename = "lastSeenMs")] last_seen_ms: i64,
}

#[derive(Default)]
struct Store {
    records: HashMap<(String, String, String), WireRecord>, // (account, ns, uuid) -> record
    devices: HashMap<String, HashMap<String, Device>>,      // account -> deviceId -> device
}
type Db = Arc<Mutex<Store>>;
```

---

## Task 1: Persistence data model (`Snapshot`)

**Files:**
- Modify: `sync-server/src/main.rs` (the `Device` derive near the store section; add new structs after the `Store` definition, before `type Db`)
- Test: `sync-server/src/main.rs` (the existing `#[cfg(test)] mod tests`)

- [ ] **Step 1: Write the failing test**

Add inside `mod tests`:

```rust
#[test]
fn snapshot_round_trips_records_and_devices() {
    let mut store = Store::default();
    store.records.insert(
        ("acct".into(), "bookmarks".into(), "u1".into()),
        WireRecord {
            uuid: "u1".into(),
            hlc: json!({ "wall_ms": 1, "counter": 0, "node": "a" }),
            deleted: false,
            nonce: "nn".into(),
            ct: "cc".into(),
        },
    );
    store
        .devices
        .entry("acct".into())
        .or_default()
        .insert("dev1".into(), Device { device_id: "dev1".into(), label: "phone".into(), last_seen_ms: 42 });

    let back = Snapshot::from_store(&store).into_store();

    assert_eq!(back.records.len(), 1);
    let r = back.records.get(&("acct".into(), "bookmarks".into(), "u1".into())).unwrap();
    assert_eq!(r.ct, "cc");
    assert_eq!(back.devices.get("acct").unwrap().get("dev1").unwrap().label, "phone");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path sync-server/Cargo.toml snapshot_round_trips`
Expected: FAIL — compile error, `Snapshot` not found.

- [ ] **Step 3: Add `Deserialize` to `Device`**

Change its derive line from:

```rust
#[derive(Clone, Serialize)]
struct Device {
```

to:

```rust
#[derive(Clone, Serialize, Deserialize)]
struct Device {
```

- [ ] **Step 4: Add the snapshot structs + conversions**

Insert directly after the `Store` struct definition and before `type Db = Arc<Mutex<Store>>;`:

```rust
// On-disk shape. The live Store is keyed by tuples (which JSON can't use as map keys),
// so we flatten to vectors for serialization and rebuild the maps on load.
#[derive(Serialize, Deserialize)]
struct SnapRecord {
    account: String,
    ns: String,
    record: WireRecord,
}

#[derive(Serialize, Deserialize)]
struct SnapDevice {
    account: String,
    device: Device,
}

#[derive(Serialize, Deserialize, Default)]
struct Snapshot {
    records: Vec<SnapRecord>,
    devices: Vec<SnapDevice>,
}

impl Snapshot {
    fn from_store(store: &Store) -> Snapshot {
        let records = store
            .records
            .iter()
            .map(|((account, ns, _uuid), record)| SnapRecord {
                account: account.clone(),
                ns: ns.clone(),
                record: record.clone(),
            })
            .collect();
        let devices = store
            .devices
            .iter()
            .flat_map(|(account, set)| {
                set.values().map(move |d| SnapDevice { account: account.clone(), device: d.clone() })
            })
            .collect();
        Snapshot { records, devices }
    }

    fn into_store(self) -> Store {
        let mut store = Store::default();
        for sr in self.records {
            let key = (sr.account, sr.ns, sr.record.uuid.clone());
            store.records.insert(key, sr.record);
        }
        for sd in self.devices {
            let device_id = sd.device.device_id.clone();
            store.devices.entry(sd.account).or_default().insert(device_id, sd.device);
        }
        store
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test --manifest-path sync-server/Cargo.toml snapshot_round_trips`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sync-server/src/main.rs
git commit -m "feat(sync-server): add JSON Snapshot model for the store"
```

---

## Task 2: Disk save/load (atomic write, fail-loud on corrupt)

**Files:**
- Modify: `sync-server/src/main.rs` (add `use` for path/io at top; add functions after the `Snapshot` impl)
- Test: `sync-server/src/main.rs` (`mod tests`)

- [ ] **Step 1: Write the failing tests**

Add inside `mod tests`:

```rust
#[test]
fn save_then_load_yields_equal_store() {
    let dir = std::env::temp_dir().join(format!("aegis-sync-save-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("data.json");

    let mut store = Store::default();
    store
        .devices
        .entry("acct".into())
        .or_default()
        .insert("dev1".into(), Device { device_id: "dev1".into(), label: "L".into(), last_seen_ms: 7 });

    save_snapshot(&path, &Snapshot::from_store(&store)).unwrap();
    let loaded = load_store(&path).unwrap();

    assert_eq!(loaded.devices.get("acct").unwrap().get("dev1").unwrap().last_seen_ms, 7);
    std::fs::remove_dir_all(&dir).ok();
}

#[test]
fn missing_file_loads_empty() {
    let path = std::env::temp_dir().join(format!("aegis-sync-absent-{}.json", std::process::id()));
    let _ = std::fs::remove_file(&path);
    let store = load_store(&path).unwrap();
    assert!(store.records.is_empty() && store.devices.is_empty());
}

#[test]
fn corrupt_file_is_an_error() {
    let dir = std::env::temp_dir().join(format!("aegis-sync-corrupt-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("data.json");
    std::fs::write(&path, b"not json {").unwrap();
    assert!(load_store(&path).is_err());
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cargo test --manifest-path sync-server/Cargo.toml _store`
Expected: FAIL — `save_snapshot` / `load_store` not found.

- [ ] **Step 3: Add imports**

At the top of the file, alongside the existing `use std::...` lines, add:

```rust
use std::io::Write;
use std::path::{Path, PathBuf};
```

- [ ] **Step 4: Implement save/load**

Add after the `impl Snapshot { ... }` block:

```rust
/// Atomically write the snapshot to `path`: serialize to a sibling `.tmp`, fsync it, then
/// rename over the target (atomic on the same filesystem). Callers serialize their writes
/// via AppState's writer mutex, so a single fixed `.tmp` name is safe.
fn save_snapshot(path: &Path, snap: &Snapshot) -> std::io::Result<()> {
    let json = serde_json::to_vec_pretty(snap)
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
    let mut tmp_os = path.as_os_str().to_owned();
    tmp_os.push(".tmp");
    let tmp = PathBuf::from(tmp_os);
    {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
    }
    std::fs::rename(&tmp, path)
}

/// Load a store from `path`. A missing file is a fresh start (empty store); an unparseable
/// file is a hard error so the operator fails loud rather than silently losing data.
fn load_store(path: &Path) -> std::io::Result<Store> {
    match std::fs::read(path) {
        Ok(bytes) => {
            let snap: Snapshot = serde_json::from_slice(&bytes)
                .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidData, e))?;
            Ok(snap.into_store())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Store::default()),
        Err(e) => Err(e),
    }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cargo test --manifest-path sync-server/Cargo.toml _store`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add sync-server/src/main.rs
git commit -m "feat(sync-server): atomic JSON save + fail-loud load"
```

---

## Task 3: `AppState` + wire persistence into handlers and `main`

**Files:**
- Modify: `sync-server/src/main.rs` (replace `type Db` usage in state; add `AppState`; update all 5 handlers, `app()`, and `main()`)
- Test: `sync-server/src/main.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test**

Add inside `mod tests`:

```rust
#[test]
fn persist_writes_and_reloads_through_appstate() {
    let dir = std::env::temp_dir().join(format!("aegis-sync-appstate-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("data.json");

    let state = AppState::new(Store::default(), Some(path.clone()));
    state.db.lock().unwrap().devices.entry("acct".into()).or_default().insert(
        "dev1".into(),
        Device { device_id: "dev1".into(), label: "laptop".into(), last_seen_ms: 99 },
    );
    state.persist();

    let reloaded = load_store(&path).unwrap();
    assert_eq!(reloaded.devices.get("acct").unwrap().get("dev1").unwrap().label, "laptop");
    std::fs::remove_dir_all(&dir).ok();
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path sync-server/Cargo.toml persist_writes_and_reloads`
Expected: FAIL — `AppState` not found.

- [ ] **Step 3: Add `AppState` (replace the `type Db` line)**

Find:

```rust
type Db = Arc<Mutex<Store>>;
```

Replace with:

```rust
type Db = Arc<Mutex<Store>>;

/// Shared request state: the in-memory store plus optional disk persistence. `writer`
/// serializes atomic writes so two concurrent mutations never clobber each other's temp file.
#[derive(Clone)]
struct AppState {
    db: Db,
    data_path: Option<Arc<PathBuf>>,
    writer: Arc<Mutex<()>>,
}

impl AppState {
    fn new(store: Store, data_path: Option<PathBuf>) -> AppState {
        AppState {
            db: Arc::new(Mutex::new(store)),
            data_path: data_path.map(Arc::new),
            writer: Arc::new(Mutex::new(())),
        }
    }

    /// Snapshot the store under its lock, release it, then atomically write to disk under the
    /// writer lock — so requests never block on fsync. No-op when persistence is disabled.
    fn persist(&self) {
        let Some(path) = self.data_path.clone() else { return };
        let snap = {
            let g = self.db.lock().unwrap();
            Snapshot::from_store(&g)
        };
        let _w = self.writer.lock().unwrap();
        if let Err(e) = save_snapshot(&path, &snap) {
            eprintln!("[aegis-sync-server] WARN failed to persist to {}: {e}", path.display());
        }
    }
}
```

- [ ] **Step 4: Update `require_registered` callers — change the 5 handler signatures**

`require_registered` keeps its `db: &Db` parameter (no change to the fn). Update each handler to take `State(state): State<AppState>` instead of `State(db): State<Db>`, and pass `&state.db` where `&db`/`db` was used.

Replace `get_records`:

```rust
async fn get_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Query(q): Query<RecordsQuery>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers)?;
    require_registered(&state.db, &account, &device)?;
    let g = state.db.lock().unwrap();
    let records: Vec<WireRecord> = g
        .records
        .iter()
        .filter(|((a, n, _), _)| a == &account && n == &q.ns)
        .map(|(_, r)| r.clone())
        .collect();
    Ok(Json(json!({ "records": records })))
}
```

Replace `post_records` (now tracks `changed` and persists only when state actually changed):

```rust
async fn post_records(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<PostRecords>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers)?;
    require_registered(&state.db, &account, &device)?;
    let mut changed = false;
    {
        let mut g = state.db.lock().unwrap();
        for rec in body.records {
            let key = (account.clone(), body.ns.clone(), rec.uuid.clone());
            // HLC last-writer-wins: keep the incoming record only if it strictly dominates the
            // stored one (a stale push from a lagging device can't roll the server back).
            let keep = match g.records.get(&key) {
                Some(existing) => hlc_key(&rec.hlc) > hlc_key(&existing.hlc),
                None => true,
            };
            if keep {
                g.records.insert(key, rec);
                changed = true;
            }
        }
    }
    if changed {
        state.persist();
    }
    Ok(Json(json!({ "ok": true })))
}
```

Replace `post_device` (persist after registering):

```rust
async fn post_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterDevice>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers)?;
    if account != body.account_id || device != body.device_id {
        return Err(StatusCode::FORBIDDEN);
    }
    if !verify_account_root(&body.account_id, &body.device_id, &body.account_sig) {
        return Err(StatusCode::FORBIDDEN);
    }
    {
        let mut g = state.db.lock().unwrap();
        g.devices.entry(account).or_default().insert(
            device.clone(),
            Device { device_id: device, label: body.label, last_seen_ms: now_ms() },
        );
    }
    state.persist();
    Ok(Json(json!({ "ok": true })))
}
```

Replace `get_devices`:

```rust
async fn get_devices(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers)?;
    require_registered(&state.db, &account, &device)?;
    let g = state.db.lock().unwrap();
    let devices: Vec<Device> =
        g.devices.get(&account).map(|m| m.values().cloned().collect()).unwrap_or_default();
    Ok(Json(json!({ "devices": devices })))
}
```

Replace `remove_device` (persist only when a device was actually removed):

```rust
async fn remove_device(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RemoveDevice>,
) -> Result<Json<Value>, StatusCode> {
    let (account, device) = verify_auth(&headers)?;
    require_registered(&state.db, &account, &device)?;
    let mut removed = false;
    {
        let mut g = state.db.lock().unwrap();
        if let Some(set) = g.devices.get_mut(&account) {
            removed = set.remove(&body.device_id).is_some();
        }
    }
    if removed {
        state.persist();
    }
    Ok(Json(json!({ "ok": true })))
}
```

- [ ] **Step 5: Update `app()` and `main()`**

Replace `app`:

```rust
fn app(state: AppState) -> Router {
    Router::new()
        .route("/v1/records", get(get_records).post(post_records))
        .route("/v1/devices", get(get_devices).post(post_device))
        .route("/v1/devices/remove", post(remove_device))
        .with_state(state)
}
```

Replace `main`:

```rust
#[tokio::main]
async fn main() {
    let addr = std::env::var("AEGIS_SYNC_ADDR").unwrap_or_else(|_| "127.0.0.1:8787".to_string());
    let data_path = std::env::var("AEGIS_SYNC_DATA").ok().map(PathBuf::from);
    let store = match &data_path {
        Some(p) => load_store(p)
            .unwrap_or_else(|e| panic!("[aegis-sync-server] failed to load {}: {e}", p.display())),
        None => Store::default(),
    };
    let state = AppState::new(store, data_path.clone());
    let listener = tokio::net::TcpListener::bind(&addr).await.expect("bind");
    let storage = data_path
        .as_ref()
        .map(|p| p.display().to_string())
        .unwrap_or_else(|| "in-memory".to_string());
    println!("[aegis-sync-server] listening on http://{addr} (storage: {storage}, ciphertext-only)");
    axum::serve(listener, app(state)).await.expect("serve");
}
```

- [ ] **Step 6: Run the full crate test suite to verify it passes**

Run: `cargo test --manifest-path sync-server/Cargo.toml`
Expected: PASS — all existing tests (hlc/canonical/unhex/registration) plus the new snapshot/save/load/persist tests. No warnings about unused `Db` (it is still used inside `AppState`).

- [ ] **Step 7: Commit**

```bash
git add sync-server/src/main.rs
git commit -m "feat(sync-server): persist store to disk via AppState (env AEGIS_SYNC_DATA)"
```

---

## Task 4: `/healthz` endpoint

**Files:**
- Modify: `sync-server/src/main.rs` (add handler; add route in `app()`)
- Test: `sync-server/src/main.rs` (`mod tests`)

- [ ] **Step 1: Write the failing test**

Add inside `mod tests`:

```rust
#[tokio::test]
async fn healthz_returns_ok() {
    let Json(v) = healthz().await;
    assert_eq!(v, json!({ "ok": true }));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cargo test --manifest-path sync-server/Cargo.toml healthz`
Expected: FAIL — `healthz` not found.

- [ ] **Step 3: Add the handler**

Add near the other handlers (e.g. just above `fn app`):

```rust
/// Unauthenticated liveness probe for Docker/reverse proxies. Returns no account data.
async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}
```

- [ ] **Step 4: Register the route in `app()`**

In `app`, add the `/healthz` route:

```rust
fn app(state: AppState) -> Router {
    Router::new()
        .route("/v1/records", get(get_records).post(post_records))
        .route("/v1/devices", get(get_devices).post(post_device))
        .route("/v1/devices/remove", post(remove_device))
        .route("/healthz", get(healthz))
        .with_state(state)
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cargo test --manifest-path sync-server/Cargo.toml healthz`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add sync-server/src/main.rs
git commit -m "feat(sync-server): add unauthenticated /healthz probe"
```

---

## Task 5: Docs — README, crate CLAUDE.md, root folder map

**Files:**
- Modify: `sync-server/README.md` (replace the in-memory paragraph)
- Create: `sync-server/CLAUDE.md`
- Modify: `CLAUDE.md` (root — add a `sync-server/` row to the folder map table)

- [ ] **Step 1: Update `sync-server/README.md`**

Replace this paragraph (lines ~8–10):

```markdown
This reference keeps everything **in memory** (it resets on restart) — fine for trying sync
out or a single-user setup. For durable use, swap the `HashMap`s in `src/main.rs` for a
database or disk-backed store; the HTTP contract stays the same.
```

with:

```markdown
By default this keeps everything **in memory** (it resets on restart) — fine for a quick try.
For durable use, set **`AEGIS_SYNC_DATA`** to a writable file path and the server snapshots
all records + device registrations to that JSON file (atomic write on change, loaded on boot)
— no database required. The easiest durable deployment is Docker: see **[DOCKER.md](DOCKER.md)**,
which sets `AEGIS_SYNC_DATA` on a persistent volume for you.
```

- [ ] **Step 2: Update the README "Run" section**

Replace the Run code block:

```bash
cargo run                                   # listens on 127.0.0.1:8787
AEGIS_SYNC_ADDR=0.0.0.0:8787 cargo run       # expose on your LAN
```

with:

```bash
cargo run                                              # in-memory, 127.0.0.1:8787
AEGIS_SYNC_ADDR=0.0.0.0:8787 cargo run                  # expose on your LAN
AEGIS_SYNC_DATA=./aegis-sync.json cargo run             # durable: persist to a JSON file
```

- [ ] **Step 3: Create `sync-server/CLAUDE.md`**

```markdown
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
```

- [ ] **Step 4: Add `sync-server/` to the root folder map**

In the repo-root `CLAUDE.md`, in the "Folder map" table, add a row after the `scripts/` row:

```markdown
| `sync-server/` | Self-hosted E2E sync server (Rust/axum, standalone) | yes |
```

- [ ] **Step 5: Commit**

```bash
git add sync-server/README.md sync-server/CLAUDE.md CLAUDE.md
git commit -m "docs(sync-server): document AEGIS_SYNC_DATA persistence + add CLAUDE.md"
```

---

## Task 6: Dockerfile + .dockerignore

**Files:**
- Create: `sync-server/Dockerfile`
- Create: `sync-server/.dockerignore`

- [ ] **Step 1: Create `sync-server/.dockerignore`**

```
target/
*.tmp
*.json
.env
.git
```

(Keeps the build context tiny: only `Cargo.toml`, `Cargo.lock`, and `src/` are needed. `*.json` also keeps any local data file out of the image.)

- [ ] **Step 2: Create `sync-server/Dockerfile`**

```dockerfile
# ---- build stage: static-ish musl binary ----
FROM rust:alpine AS builder
RUN apk add --no-cache musl-dev
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

# ---- runtime stage: minimal, non-root ----
FROM alpine:3.20
RUN addgroup -S aegis \
    && adduser -S -G aegis aegis \
    && mkdir -p /data \
    && chown aegis:aegis /data
COPY --from=builder /build/target/release/aegis-sync-server /usr/local/bin/aegis-sync-server
USER aegis
ENV AEGIS_SYNC_ADDR=0.0.0.0:8787 \
    AEGIS_SYNC_DATA=/data/aegis-sync.json
EXPOSE 8787
VOLUME ["/data"]
ENTRYPOINT ["/usr/local/bin/aegis-sync-server"]
```

- [ ] **Step 3: Build the image (verification)**

Run: `docker build -t aegis-sync-server sync-server/`
Expected: build succeeds, ending with `naming to docker.io/library/aegis-sync-server`.
(If `docker` is not installed, note it and defer this verification to the operator; do not mark the task complete with a fabricated result.)

- [ ] **Step 4: Smoke-test the image (verification)**

Run:
```bash
docker run -d --rm -p 8787:8787 --name aegis-sync-smoke aegis-sync-server
sleep 1
curl -fsS http://localhost:8787/healthz
docker stop aegis-sync-smoke
```
Expected: `curl` prints `{"ok":true}`.

- [ ] **Step 5: Commit**

```bash
git add sync-server/Dockerfile sync-server/.dockerignore
git commit -m "feat(sync-server): multi-stage Alpine Dockerfile + dockerignore"
```

---

## Task 7: docker-compose.yml + .env.example + DOCKER.md

**Files:**
- Create: `sync-server/docker-compose.yml`
- Create: `sync-server/.env.example`
- Create: `sync-server/DOCKER.md`

- [ ] **Step 1: Create `sync-server/docker-compose.yml`**

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

- [ ] **Step 2: Create `sync-server/.env.example`**

```
# Host port to publish the sync server on. The container always listens on 8787 internally.
# Copy this file to .env and edit, or leave unset to use the 8787 default.
AEGIS_SYNC_PORT=8787
```

- [ ] **Step 3: Create `sync-server/DOCKER.md`**

````markdown
# Running the Aegis sync server with Docker

A durable, self-hosted deployment of the end-to-end-encrypted sync server. The container
stores **opaque ciphertext only** — it can never read your bookmarks, saved items, or
allowlist. Data is persisted to a named Docker volume, so it survives restarts and upgrades.

## Quick start

```bash
cd sync-server
docker compose up -d           # build + start in the background
curl http://localhost:8787/healthz   # -> {"ok":true}
```

To publish on a different host port, copy `.env.example` to `.env` and set `AEGIS_SYNC_PORT`.

## Point Aegis at it

In Aegis: **Settings → Sync → Server URL** = `http://<host>:8787`, then **Start new sync**.
On another device, paste the same URL and **Restore from a recovery phrase**.

> Over the public internet, use HTTPS via a reverse proxy (below). On a LAN or localhost,
> plain HTTP is fine.

## Where the data lives & backups

Records + device registrations are written to `/data/aegis-sync.json` inside the container,
backed by the `aegis-sync-data` named volume. The contents are opaque ciphertext plus a small
device list, so a backup is safe to store anywhere.

```bash
# Back up the data file out of the running container:
docker compose cp sync:/data/aegis-sync.json ./aegis-sync.backup.json
```

If the data file is ever corrupted, the server **fails to start** (loud, by design) rather
than silently losing data — restore the file from a backup.

## Updating

```bash
docker compose build && docker compose up -d   # data persists in the volume
```

## HTTPS via a reverse proxy

The container speaks plain HTTP on 8787; terminate TLS in front of it.

**Caddy** (automatic Let's Encrypt — needs a domain pointing at the host, ports 80/443 open):

```caddyfile
sync.example.com {
    reverse_proxy localhost:8787
}
```

**nginx** (with your own cert):

```nginx
server {
    listen 443 ssl;
    server_name sync.example.com;
    ssl_certificate     /etc/ssl/certs/sync.crt;
    ssl_certificate_key /etc/ssl/private/sync.key;
    location / {
        proxy_pass http://127.0.0.1:8787;
    }
}
```

Then use `https://sync.example.com` as the Aegis Server URL.

## Notes & limits

- **Scale:** the JSON store is rewritten in full on each change — ideal for personal/family
  use. A very large multi-user deployment would want a database backend (the code keeps the
  HTTP contract identical, so that's a drop-in future change).
- **Security:** the server stores ciphertext only, but still restrict who can reach it
  (firewall / reverse-proxy auth) as defense in depth.
- The runtime image includes `wget` (Alpine busybox) for the compose healthcheck. If you slim
  to a `scratch`/distroless image, replace the healthcheck accordingly.
````

- [ ] **Step 4: Bring it up (verification)**

Run:
```bash
docker compose -f sync-server/docker-compose.yml up -d --build
sleep 2
curl -fsS http://localhost:8787/healthz
```
Expected: `{"ok":true}`.
(If `docker` is unavailable, note it and defer to the operator — do not fabricate output.)

- [ ] **Step 5: Prove durability across a restart (verification)**

This proves the volume + load-on-boot path end to end. The records/devices endpoints require
a signed token, but `/healthz` plus the data-file presence are sufficient to confirm the
volume persists; for a full record round-trip, drive it from an Aegis client. Minimal check:

```bash
# Confirm the data file is created on the volume after the server starts, then survives restart
docker compose -f sync-server/docker-compose.yml exec sync ls -la /data
docker compose -f sync-server/docker-compose.yml restart
sleep 2
docker compose -f sync-server/docker-compose.yml exec sync ls -la /data   # file still present
curl -fsS http://localhost:8787/healthz                                   # {"ok":true}
docker compose -f sync-server/docker-compose.yml down
```
Expected: `/data/aegis-sync.json` is present before and after the restart; healthz ok.
For a true data round-trip, register a device + sync a bookmark from two Aegis clients
pointed at `http://<host>:8787`, restart the container, and confirm the bookmark is still
synced.

- [ ] **Step 6: Commit**

```bash
git add sync-server/docker-compose.yml sync-server/.env.example sync-server/DOCKER.md
git commit -m "feat(sync-server): docker-compose + .env.example + DOCKER.md guide"
```

---

## Final verification

- [ ] Run the full crate test suite: `cargo test --manifest-path sync-server/Cargo.toml` — all green.
- [ ] `docker build -t aegis-sync-server sync-server/` succeeds (or is explicitly deferred if Docker is unavailable on this host).
- [ ] `curl http://localhost:8787/healthz` returns `{"ok":true}` from the running container.
- [ ] The `AegisSig` auth `canonical()` shape in `sync-server/src/main.rs` is unchanged (the round-trip test still passes), so all Aegis clients remain compatible — no per-platform work needed.
- [ ] Update memory (`aegis-webrtc-sync-initiative`) to note the Dockerized durable sync server.
```
