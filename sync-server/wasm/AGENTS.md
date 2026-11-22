# sync-server/wasm — the Aegis sync server as a Meshnode WASM service (ACTIVE)

**This is the active sync server.** It replaces the deprecated axum/Docker server in
`../legacy-docker`. A `wasi:http` handler (one fresh instance per request) that stores everything
in Meshnode's `meshnode:kv`: records and device facts in the replicated `store`, spent replay
nonces in the node-local `local`. The protocol (token checks, bounds, id repair, LWW stamps,
paging, the tie `ord`, device rules) is `../core` (`aegis-sync-core`); this crate is the glue
between it and the kv. Module map: `src/lib.rs`.

## Where it comes from, and who owns what

- **Aegis owns this source.** It was copied from Meshnode `services/aegis-sync` at Meshnode commit
  `2888dc94498cdd9b03fe41ecf983a575ee6f2661` (last service change there: `e33b1f2`). Only the
  manifest comments, `rust-version`, the core path (`../core`, was `../../vendor/aegis-sync-core`)
  and the WIT path changed. Edit it HERE; Meshnode copies it into its `services/aegis-sync`.
- **Meshnode owns the host contract.** `wit/` is a copy of Meshnode `crates/mesh-runtime/wit` at
  the same commit (`world.wit` + `deps/`, including `meshnode:kv` in `deps/kv.wit`). Never edit it
  here; when Meshnode's runtime WIT changes, re-copy it.
- **The behavioural tests live in Meshnode** (`crates/mesh-services/tests/aegis_sync.rs`,
  `aegis_sync_mesh.rs`): they run the built `.wasm` inside Meshnode's runtime (`mesh_runtime`,
  wasmtime) and cannot run from this repo. They `#[path]`-include `src/keys.rs`, so that file's
  key layout is part of the contract with them. The shared contract vectors also run, in pure
  form, in `../core`.
- Lockfile is its own (`Cargo.lock`), so `--locked` builds are reproducible.

## Build

```bash
cargo build --locked --release --target wasm32-wasip2     # -> target/wasm32-wasip2/release/aegis_sync.wasm
cargo clippy --locked --target wasm32-wasip2 --all-targets -- -D warnings
```

Needs the `wasm32-wasip2` target (`rustup target add wasm32-wasip2`). It builds for that target
only. `--features test-caps` is TEST ONLY: it lowers the server-wide caps (`src/caps.rs`) for
Meshnode's harness; never deploy it.

Deploy on a Meshnode node (the 30 s timeout is required; the daemon default is 10 s):

```bash
meshd deploy wasm sync target/wasm32-wasip2/release/aegis_sync.wasm \
  --memory-mb 64 --timeout-ms 30000 --max-body 8388608
```

## CI

The `sync-server` job in `.github/workflows/ci.yml` runs fmt, clippy (with and without
`test-caps`), the release build, and `cargo audit`; the `msrv` job checks it on the declared
`rust-version`, which must equal `src-tauri/Cargo.toml` and `../core/Cargo.toml`.
