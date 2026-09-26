# .github/ — CI & supply-chain automation

GitHub Actions workflows and Dependabot config for Aegis.

## Workflows (`workflows/`)

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on every push to `main`
  (so a direct push is gated too, not just PRs), weekly (Mon 06:17 UTC), and on
  demand. Five job groups, all on `ubuntu-latest` except the macOS cross-check:
  - **`web`**: `npm ci` → `npm run typecheck` (scoped `tsc --noEmit` via
    `tsconfig.build.json`, which excludes test files + `src/testFixtures` to skip the
    known test-only type noise) → `npm run lint` (ESLint flat config, errors fail /
    warnings are the migration backlog) → `npm run format:check` (Prettier) →
    `npm test` (vitest node + jsdom) → `node scripts/check-npm-audit.mjs`.
  - **`rust`** (the `src-tauri` crate): installs the webkit2gtk build deps, then
    `cargo fmt --check` → `cargo clippy --locked --all-targets -- -D warnings` →
    `cargo test --locked` (the 418 `src-tauri` unit tests, Linux-cfg paths) →
    a **BLOCKING** `cargo audit` over the crypto/keyring/TLS surface. The audit runs
    with `working-directory: src-tauri` on purpose: cargo-audit resolves its config as
    `./.cargo/audit.toml` relative to the CWD and does not search ancestors, so that is
    what makes `src-tauri/.cargo/audit.toml` authoritative. There is no
    `continue-on-error` and no `|| true` — a new advisory fails the job.
  - **`sync-server`**: the same fmt/clippy/test treatment plus its own **blocking**
    `cargo audit` for the standalone crate (the one internet-facing service in the
    project). It is a separate non-workspace crate, so it needs no webkit2gtk and has
    its own `sync-server/.cargo/audit.toml`.
  - **`cross-target`** (matrix, `cargo check --locked` only — no link, no test, no
    bundle): `x86_64-pc-windows-gnu` + `aarch64-linux-android` on ubuntu (mingw-w64 /
    the Android NDK supply the cross toolchain) and `x86_64-apple-darwin` on a
    **macOS-15** runner, because objc2's build script needs a macOS C toolchain and
    cannot be cross-compiled from Linux. This is the only job that compiles
    `nav_url_win.rs`, `nav_url_mac.rs`, `zoom_win.rs`, `zoom_mac.rs` and the JNI /
    `sync_keystore` / `ffi_guard` block — everything else is Linux-cfg. `fail-fast` is
    off so all three surfaces report at once.
  - **`msrv`**: `cargo check --locked` for BOTH manifests against the `rust-version`
    declared in each `Cargo.toml`, on a toolchain resolved from that manifest (the one
    job that deliberately does NOT use `rust-toolchain.toml`, so a new stable release
    cannot silently break the declared floor).

  Every cargo invocation passes `--locked` (only `cargo fmt` does not — cargo-fmt has
  no such flag), so **`Cargo.lock` is part of the gate**: a dependency change that is
  not committed with its manifest fails the build rather than silently resolving.

  The Rust jobs also run with `RUSTFLAGS: -D warnings` **injected from outside this
  repository** — it appears in every Rust job's environment but is in no workflow,
  manifest, or `.cargo/config.toml` in the tree (the only `.cargo` dir is
  `src-tauri/.cargo/`, and it holds just `audit.toml`). That is why a dead-code or
  unused-import warning on the Windows/macOS/Android-only code turns CI red even
  though `ci.yml` only spells out `-D warnings` for clippy. Treat "all three
  cross-target surfaces are warning-clean" as a real requirement.

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
The CI `rust` and `sync-server` jobs both run a **blocking** `cargo audit`, so a
Dependabot bump that lands a vulnerable version goes red rather than waiting for the
weekly schedule; the accept-lists that keep known-and-accepted advisories out of that
path are `src-tauri/.cargo/audit.toml` and `sync-server/.cargo/audit.toml`, each entry
carrying the one-line reason it is accepted.

## Notes

- Linux jobs `apt-get install` webkit2gtk/appindicator/rsvg/xdo/patchelf — the apt
  equivalents of the Fedora dev deps.
- CI uses Node 22 with npm cache; cargo registry + `src-tauri/target` are cached by
  `Cargo.lock` hash.
- `tauri-build-check.yml` runs the full multi-OS + Android build **on demand only**
  (`workflow_dispatch`) — heavier than `ci.yml`; cross-OS compile/link/bundle is not
  auto-gated on push (run it manually, or rely on branch protection if you add it).
