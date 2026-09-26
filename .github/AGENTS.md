# .github/ — CI & supply-chain automation

GitHub Actions workflows and Dependabot config for Aegis.

## Workflows (`workflows/`)

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on every push to `main`
  (so a direct push is gated too, not just PRs), weekly (Mon 06:17 UTC), and on
  demand. Ubuntu only; two parallel jobs:
  - **`web`**: `npm ci` → `npm run typecheck` (scoped `tsc --noEmit` via
    `tsconfig.build.json`, which excludes test files + `src/testFixtures` to skip the
    known test-only type noise) → `npm run lint` (ESLint flat config, errors fail /
    warnings are the migration backlog) → `npm run format:check` (Prettier) →
    `npm test` (vitest node + jsdom) → `node scripts/check-npm-audit.mjs`.
  - **`rust`**: installs the webkit2gtk build deps, then
    `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` (the 119
    `src-tauri` unit tests, Linux-cfg paths) for `src-tauri/Cargo.toml`, plus an
    advisory (non-blocking) `cargo audit` over the crypto/keyring/TLS deps.
    The standalone `sync-server/` crate is NOT gated here (separate non-workspace crate).
- **`tauri-build-check.yml`** (Tauri Build Check) — proves the app compiles, links,
  and bundles on real OSes and produces downloadable artifacts for on-device
  testing. Triggers on demand only (`workflow_dispatch`) — deliberately NOT on push,
  to avoid spending heavy multi-OS + Android build minutes on every commit; trigger it
  from the Actions tab when you want fresh cross-OS artifacts. Matrix:
  - `windows-latest` → portable `Aegis_x64_portable.exe` (`--no-bundle`, raw exe)
  - `macos-latest` → `.app` + `.dmg`
  - `ubuntu-24.04` → portable `.AppImage` (`--bundles appimage`). NOT 22.04: its
    webkit2gtk (`_GLIBCXX_ASSERTIONS`) aborts in Skia's COLR-v1 color-font path, so the
    bundled-webkit AppImage crashed (blank/frozen pages) on newer distros like Fedora.
  - plus an `android` job → **release** APK (minified; debug-key-signed so it still
    installs — each CI run uses its own debug key, so it's a one-off-install artifact,
    not an update channel). Rust cross-compiled to the 4 Android ABIs.
    Artifacts retained 14 days; the real signed/update channel is `tauri-release.yml`.
- **`tauri-release.yml`** (Tauri Release) — the auto-update feed. Triggers on a
  `v*` tag. Builds signed bundles + `latest.json` for Linux/Windows/macOS (Intel +
  Apple Silicon) via `tauri-apps/tauri-action`, publishes a **draft** GitHub
  Release. Needs repo secrets `TAURI_SIGNING_PRIVATE_KEY`
  (+`_PASSWORD`); without them it still builds but emits no update signature.
  Dormant until the Tauri app is on the default branch and a `v*` tag is pushed.

## `dependabot.yml`

Weekly npm + github-actions + **cargo** updates. Minor/patch bumps are grouped into a
single PR per ecosystem to reduce noise; major bumps arrive individually. Cargo is
tracked for **both** Rust manifests — `/src-tauri` (the Tauri core) and `/sync-server`
(the standalone self-hosted sync server) — so `Cargo.lock` no longer drifts unmanaged.
The CI `rust` job's `cargo audit` is advisory (non-blocking); the Dependabot cargo
PRs are the currency mechanism for the crypto/keyring/TLS surface.

## Notes

- Linux jobs `apt-get install` webkit2gtk/appindicator/rsvg/xdo/patchelf — the apt
  equivalents of the Fedora dev deps.
- CI uses Node 22 with npm cache; cargo registry + `src-tauri/target` are cached by
  `Cargo.lock` hash.
- `tauri-build-check.yml` runs the full multi-OS + Android build **on demand only**
  (`workflow_dispatch`) — heavier than `ci.yml`; cross-OS compile/link/bundle is not
  auto-gated on push (run it manually, or rely on branch protection if you add it).
