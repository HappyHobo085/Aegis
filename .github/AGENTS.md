# .github/ — CI & supply-chain automation

GitHub Actions workflows and Dependabot config for Aegis.

## Workflows (`workflows/`)

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on every push to `main`
  (so a direct push is gated too, not just PRs), weekly (Mon 06:17 UTC), and on
  demand. Five job groups, all on `ubuntu-latest` except the macOS cross-check:
  - **`web`**: `npm ci` → `npm run typecheck` (scoped `tsc --noEmit` via
    `tsconfig.build.json`, which covers `src`, `shared` and the three config files,
    **including every `*.test.ts(x)` and `src/testFixtures`**, because a test-only
    type error is a real error. The CI step is named "Type-check (whole surface,
    tests included)" — it was previously "Type-check (production source, scoped)",
    which was a misnomer, and this line was that claim's last remaining home) →
    `npm run lint` (ESLint flat config; the script is
    `eslint . --max-warnings=0`, so a `'warn'` rule gates exactly like an `'error'` —
    there is NO warning tier in this repo's ESLint setup, contrary to what this line
    used to say; see `eslint.config.mjs`'s own header for the same note) → `npm run format:check` (Prettier) → `npm run test:coverage`
    (vitest, node project and jsdom, 1825 tests, **with** the v8 report) →
    `npm run coverage:ratchet` → `npm run build:renderer` → `npm run sizecheck` →
    `node scripts/check-npm-audit.mjs` → `node scripts/check-android-versioncode.mjs`.
    The `--coverage` flag rides on the _test_ step rather than buying a second
    `vitest run`; the ratchet is its own step so a coverage regression is a distinct
    log line from a test failure and a red suite cannot mask it. The ratchet is a
    **may-only-go-up** gate — it fails if any of the four metrics drops below
    `coverage-baseline.json`, if the baseline was _lowered_ in the same commit, or if
    a file the baseline names left the report (which is what stops an added
    `coverage.exclude` from buying a green build by shrinking the denominator).
    `COVERAGE_ALLOW_BASELINE_LOWER` is deliberately **not** set in the workflow.
    The "lowered in the same commit" half is only meaningful because this job
    first runs a `Resolve the base ref for the comparison gates` step: the
    `_lowered_` check reads `git show <base>:coverage-baseline.json`, and in a CI
    worktree `HEAD` _is_ the file being checked, so comparing against `HEAD`
    would be a tautology that can never fire. The step prefers
    `github.event.pull_request.base.sha` (pull_request), falls back to
    `github.event.before` (ignoring the all-zeros value a branch-creation event
    carries), and exports `AEGIS_BASE_REF` only after `git cat-file -e` proves
    the commit is actually in the clone — which is also why the checkout is
    `fetch-depth: 0`. With no resolvable base the ratchets and
    `check-android-versioncode.mjs` print a loud warning naming what they could
    not check; they do not fall back to a self-comparison.
    The `rust` job repeats the same step and the same `fetch-depth: 0`, because
    `rust-coverage-ratchet.mjs` carries the identical check.
    Numbers and the full gap decomposition: the coverage section of the root
    `AGENTS.md`; the tooling's own contract: `scripts/AGENTS.md`.
  - **`rust`** (the `src-tauri` crate): installs the webkit2gtk build deps, then
    `cargo fmt --check` → `cargo clippy --locked --all-targets -- -D warnings` →
    `cargo test --locked` (the 682 `src-tauri` unit tests that compile on the Linux
    runner: 696 `#[test]` functions in `src-tauri/src` less 14 that are
    platform-gated — `find_mac` 10, `find_win` 2, `adblock_win` 2) →
    `cargo llvm-cov` + `node scripts/rust-coverage-ratchet.mjs` → a **BLOCKING**
    `cargo audit` over the crypto/keyring/TLS surface. Two things in there are not
    incidental:
    - `cargo test` runs inside `dbus-run-session` with a `gnome-keyring-daemon` started
      first. Four `sync_keystore` tests round-trip a real OS keychain through
      `keyring_available()`; with no keyring they early-**return**, so they pass while
      covering nothing. A dev box with a desktop session has a keyring and a headless
      runner does not, so without this the Rust coverage baseline would be satisfiable
      only on some machines — exactly the "threshold that quietly depends on the machine"
      failure a ratchet must not have.
    - the coverage step is a **separate cargo invocation** from `cargo test`: llvm's
      `-C instrument-coverage` is a codegen flag, so the instrumented artifacts cannot
      be reused from the plain test build. That costs minutes, and it is why the step is
      last. `--lib` only — `main.rs` calls `run()` and launching the app is not a test.
      It is **deliberately NOT wrapped** in a keyring, unlike the `cargo test` step — the
      asymmetry is intentional. The three keychain round-trips in `sync_keystore.rs` share
      one OS keyring, so their covered-line footprint depends on state left by earlier runs
      (measured 286 / 289 / 300 lines across three runs, 228 with no keyring), and CI has
      never had a usable one for `llvm-cov` (two runs, both exactly 11038/14750). So
      `src-tauri/coverage-baseline.json` is the **no-keyring FLOOR**: a machine with a
      keyring covers strictly more and passes, CI lands on the floor. A threshold that is
      not reproducible in every environment is not a threshold. The keyring still
      provisions `cargo test`, where it decides whether those tests run or skip — test
      quality, not the gate. Wrapping the coverage step to match was tried and reverted.
      The ratchet prints per-file covered-line deltas on failure, so a file whose code
      stopped EXECUTING is named in one run instead of reconstructed.
      The committed exclusion list lives in `scripts/rustCoverageCheck.mjs` and prints
      each excluded file with its real numbers on every run. It gates **three**
      metrics, not four: llvm branch coverage needs `-Z coverage-options=branch`, i.e.
      nightly, and `rust-toolchain.toml` pins stable.
      The audit runs
      with `working-directory: src-tauri` on purpose: cargo-audit resolves its config as
      `./.cargo/audit.toml` relative to the CWD and does not search ancestors, so that is
      what makes `src-tauri/.cargo/audit.toml` authoritative. There is no
      `continue-on-error` and no `|| true` — a new advisory fails the job.
  - **`sync-server`**: the same fmt/clippy/test treatment plus its own **blocking**
    `cargo audit` for the standalone crate (the one internet-facing service in the
    project). It is a separate non-workspace crate, so it needs no webkit2gtk. It has
    **no** `sync-server/.cargo/audit.toml` — the step runs from `sync-server/` precisely
    so that adding one later is picked up without editing CI, and today it accepts
    nothing.
  - **`cross-target`** (matrix, `cargo check --locked` only — no link, no test, no
    bundle): `x86_64-pc-windows-gnu` + `aarch64-linux-android` on ubuntu (mingw-w64 /
    the Android NDK supply the cross toolchain) and `x86_64-apple-darwin` on a
    **macOS-15** runner, because objc2's build script needs a macOS C toolchain and
    cannot be cross-compiled from Linux. Its `apt:` lists are deliberately minimal —
    `mingw-w64` for Windows and **nothing at all** for Android (the NDK clang is
    already on the runner) — because a non-host target never builds `webkit2gtk`.
    Measured: 0 webkit/gtk-family crates in both non-Linux graphs against 17 on the
    host, no pkg-config/webkit reference in `tauri-build`'s build script, and a
    from-cold check that invokes `pkg-config` zero times. This leg used to install the
    same five webkit/appindicator/rsvg/xdo packages as the `rust` job, on the belief
    that "tauri-build compiles on the host regardless of the target triple"; that cost
    ~2m at best and blew this job's 45-minute budget twice on 2026-10-01, cancelling
    `cargo check` before it ever ran. Do not add them back without re-measuring.
    This is the only job that compiles
    `nav_url_win.rs`, `nav_url_mac.rs`, `zoom_win.rs`, `zoom_mac.rs` and the JNI /
    `sync_keystore` / `ffi_guard` block. The other platform-gated modules are
    `adblock_win.rs` and `nav_policy_win.rs` (both Windows), `find_win.rs` and
    `find_mac.rs`, and the Linux trio `adblock_webkit.rs` / `linux_layout.rs` /
    `find_linux.rs`; the authoritative list is the `mod` declarations in
    `src-tauri/src/lib.rs`, not this paragraph. `fail-fast` is off so all three
    surfaces report at once.
  - **`msrv`**: `cargo check --locked` for BOTH manifests against the `rust-version`
    declared in each `Cargo.toml`, on a toolchain resolved from that manifest (the one
    job that deliberately does NOT use `rust-toolchain.toml`, so a new stable release
    cannot silently break the declared floor).
    The commands are `cargo +<msrv> check …`, and the `+<msrv>` is **load-bearing**.
    `dtolnay/rust-toolchain` only sets the rustup _default_, and a default loses to the
    _directory override_ that the repo-root `rust-toolchain.toml` installs — so a plain
    `cargo check` here compiled 1.98.0 and the declared floor was never built (proved in
    CI run 36281195902, the only job syncing two toolchains; and locally, where
    `cargo --version` reports the override's 1.98.0 while `cargo +stable --version`
    reports the default's 1.98.1). Each step echoes `cargo +<msrv> --version` so the
    toolchain that actually ran is one grep away in the log.
    **This gate has now caught two wrong numbers**, which is the only evidence it
    works: 1.80.0 when the job was written, then 1.85.0 the first time it really
    compiled (run 36282117889: `rustc 1.85.0 is not supported by the following
packages` — darling 0.23, plist 1.9, time 0.3.47, serde*with need 1.88, the
    `icu*\*`2.2 chain needs 1.86). The floor is **1.88.0** and is owned by the
    dependency graph, not by this repo's own code. Re-derive it with
    `cargo metadata --format-version 1 --locked | jq '[.packages[].rust_version] | max'` after any dependency bump, and move`rust-version`in **both** manifests (the job
    fails on drift) plus the README's MSRV line. If`msrv` goes red, fix the manifests
    — do not weaken the job.

  Every cargo invocation passes `--locked` (only `cargo fmt` does not — cargo-fmt has
  no such flag), so **`Cargo.lock` is part of the gate**: a dependency change that is
  not committed with its manifest fails the build rather than silently resolving.

  The Rust jobs do **NOT** get `-D warnings` from anywhere outside this file: every
  warning gate in the tree is spelled out explicitly, `ci.yml` passes
  `RUSTFLAGS="-D warnings"` as a per-step `env:` on its `clippy` invocations, and
  `cross-target`'s step is a bare `cargo check --locked` with **no** warning gate —
  so a dead-code or unused-import warning in the Windows/macOS/Android-only code
  does not fail CI, it fails only when that platform is built with clippy
  (`cargo clippy --locked --target <triple> --all-targets -- -D warnings`, which is
  how it is verified locally). Treat "all three cross-target surfaces are
  warning-clean" as a real requirement, but as a _local_ gate, not one CI enforces.
  This paragraph used to assert the opposite — an env var that appears in no
  workflow, manifest or `.cargo/config.toml` (the only `.cargo` dir is
  `src-tauri/.cargo/`, and it holds just `audit.toml`). A doc that names a
  mechanism that does not exist is worse than no doc: it makes a gap look covered.

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
path is `src-tauri/.cargo/audit.toml` (the only accept-list in the tree; `sync-server`
has none), each entry carrying the one-line reason it is accepted.

## Notes

- Linux jobs `apt-get install` webkit2gtk/appindicator/rsvg/xdo/patchelf — the apt
  equivalents of the Fedora dev deps.
- CI uses Node 22 with npm cache; cargo registry + `src-tauri/target` are cached by
  `Cargo.lock` hash.
- `tauri-build-check.yml` runs the full multi-OS + Android build **on demand only**
  (`workflow_dispatch`) — heavier than `ci.yml`; cross-OS compile/link/bundle is not
  auto-gated on push (run it manually, or rely on branch protection if you add it).
