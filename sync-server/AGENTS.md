# sync-server — Aegis's self-hosted E2E sync server

Three crates, each its own Cargo workspace with its own `Cargo.lock`:

| Folder           | What                                                       | Status                          | CI / Dependabot |
| ---------------- | ---------------------------------------------------------- | ------------------------------- | --------------- |
| `wasm/`          | The sync server as a Meshnode WASM service (`wasi:http`)   | **ACTIVE**                      | yes / yes       |
| `core/`          | `aegis-sync-core`: pure protocol code + contract vectors   | active, shared by both servers  | yes / yes       |
| `legacy-docker/` | The original axum server, Docker + systemd deploy          | **DEPRECATED, not maintained**  | no / no         |

Each folder has its own `AGENTS.md`. The servers store **opaque ciphertext only**: they never hold
encryption keys and cannot decrypt bookmarks, saved items, or the allowlist.

- **`core/` stays at `sync-server/core`.** Meshnode vendors it from exactly that path, so moving it
  breaks Meshnode's `scripts/sync-aegis-core.sh`.
- **`legacy-docker/`** is kept only for existing deployments. Do not add features. It gets no CI, no
  Dependabot, and no security fixes, so a known advisory against its frozen lockfile will stay open.

## Migration note (2026-11-21)

The axum server used to live directly in `sync-server/` and now lives in `sync-server/legacy-docker/`.
For an existing deployment:

- **Docker Compose:** run it from `sync-server/legacy-docker`. The project name is pinned to
  `sync-server` (`name:` in `docker-compose.yml`), so it keeps the existing
  `sync-server_aegis-sync-data` volume. The build context is `sync-server/` because the crate
  path-depends on `../core`.
- **systemd unit:** an installed unit has the OLD directory baked into `WorkingDirectory` and
  `RequiresMountsFor`. Re-install it from `sync-server/legacy-docker` (see `legacy-docker/DOCKER.md`),
  or the next boot starts nothing.
- **`.env`:** Compose reads `.env` from its own directory. A `sync-server/.env` has to move to
  `sync-server/legacy-docker/.env` (it is gitignored, so `git` does not move it).
