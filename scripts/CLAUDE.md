# scripts/ — supply-chain CI gate

Node ESM scripts that gate CI on `npm audit`, plus build and deployment scripts.
Tested in the vitest **node** project.

## CI Workflows

GitHub Actions workflows in `.github/workflows/`:

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
  and bundles on real OSes and produces downloadable artifacts for on-device testing.
  Triggers on demand only (`workflow_dispatch`) — deliberately NOT on push,
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

## Dependabot

`dependabot.yml` — Weekly npm + github-actions + **cargo** updates. Minor/patch bumps
are grouped into a single PR per ecosystem to reduce noise; major bumps arrive individually.
Cargo is tracked for **both** Rust manifests — `/src-tauri` (the Tauri core) and `/sync-server`
(the standalone self-hosted sync server) — so `Cargo.lock` no longer drifts unmanaged.
The CI `rust` job's `cargo audit` is advisory (non-blocking); the Dependabot cargo
PRs are the currency mechanism for the crypto/keyring/TLS surface.

## Files

- **`auditCheck.mjs`** — pure logic, no I/O. Parses an `npm audit --json`
  (auditReportVersion 2) report and partitions high/critical advisories into
  `{ blocking, allowed }` using an allowlist. Key exports:
  `BLOCKING_SEVERITIES` (`['high','critical']`), `collectBlockingAdvisories`,
  `isAllowlisted`, `evaluateAudit`. Advisories are deduped by `source` (npm
  advisory id), falling back to `url`.
- **`check-npm-audit.mjs`** — the CLI wrapper. Spawns `npm audit --json` (recovering
  stdout when npm exits non-zero), loads the allowlist from `../.audit-allowlist.json`,
  calls `evaluateAudit()`, and **exits non-zero if any blocking advisory remains**.
  Allowlisted ones are logged and ignored.
- **`auditCheck.test.mjs`** — unit tests for the pure logic above.

## Allowlist

`../.audit-allowlist.json` (`{ "allow": [<source-id|url>, ...] }`). To accept a
high/critical advisory, add its numeric `source` or `url` there **with
justification in the commit** — that's the documented escape hatch.

## Run

```bash
node scripts/check-npm-audit.mjs   # the gate
npm test                           # includes auditCheck.test.mjs (node project)
```

## Build & deploy scripts

Convenience wrappers around the release builds (each resolves the repo root via
`git rev-parse --show-toplevel`, so they run from anywhere):

- **`deploy-android.sh`** — build the arm64 **release** APK (debug-key-signed) and
  `adb install -r` it onto the connected phone, updating `com.aegis.browser` in place.
  Sets `JAVA_HOME` to the Android Studio JBR (JDK 21 — Gradle/AGP break under JDK 25).
  Flags: `--universal` (all ABIs), `--reinstall` (uninstall first on a signing-key
  mismatch — wipes that app's data).
- **`build-appimage.sh`** — the release AppImage. Mirrors the CI `aegis-linux-appimage`
  job: `tauri build --bundles appimage --config src-tauri/tauri.appimage-mediaframework.conf.json`
  (the media-framework override ships matched GStreamer plugins — see `src-tauri/CLAUDE.md`
  gotcha 12). Output under `src-tauri/target/release/bundle/appimage/*.AppImage`.
- **`build-windows-portable.ps1`** — **run on a Windows host** (MSVC + NASM + CMake). Mirrors
  the CI `aegis-windows-portable` job: `tauri build --no-bundle` then copy
  `src-tauri/target/release/app.exe` → `Aegis_x64_portable.exe`. The canonical
  (shipping-equivalent) portable exe.
- **`build-windows-portable-cross.sh`** — best-effort **GNU cross-compile from Linux**
  (`cargo build --release --target x86_64-pc-windows-gnu` after `npm run build:renderer`).
  NOT the MSVC build that ships — validate on real Windows; use the `.ps1`/CI for the
  canonical artifact. Needs `mingw64-gcc` + the `x86_64-pc-windows-gnu` rust target.

## Autopilot launcher (`scripts/autopilot/`)

**Linux only. Needs a real display (X11 or Wayland).** Drives the entire Aegis feature
surface through the real Rust core in an isolated, disposable environment.

### Files

- **`run-autopilot.sh`** — the entry point. Creates a timestamped output directory
  (`target/autopilot/<ts>/`), spins up the fixture server, launches `npm run tauri:dev`
  with a disposable XDG profile (`XDG_DATA_HOME`/`XDG_CONFIG_HOME` → a `mktemp` dir so
  no user data is touched), and polls for `done.sentinel` (written by
  `autopilot_done` on the Rust side). On exit (including error/timeout), a trap kills
  the app + fixture server and deletes the temp profile.
  - **Key env vars passed to the app:**
    - `VITE_AEGIS_AUTOPILOT=1` — activates the `main.tsx` bootstrap branch.
    - `VITE_AEGIS_AUTOPILOT_FIXTURE=http://127.0.0.1:8137/` — URL of the fixture page
      used for the ad-block induction step.
    - `VITE_AEGIS_AUTOPILOT_DISPLAY=1` (or empty) — whether to attempt screenshots
      (`spectacle`). Set automatically from `$DISPLAY`/`$WAYLAND_DISPLAY`.
    - `AEGIS_AUTOPILOT_OUT=<ts-dir>` — where the Rust commands write report files.
    - `AEGIS_AUTOPILOT_TRACE=1` — makes `linux_layout::connect_block_counter` log a
      `[aegis-count] block=… page=… url=…` line per subresource to `app.log`. The
      summarizer reads these to assert ad-block **blocking** (see `summarize.mjs`).
  - **Watchdog:** polls `done.sentinel` every second with a configurable timeout
    (default 1800 s — the first run compiles the Rust core, which a cold `tauri dev`
    build can take 10-20 min; override with `AEGIS_AUTOPILOT_TIMEOUT=<seconds>`). Then
    runs `summarize.mjs` and exits non-zero if any step failed **or** ad-block blocking
    regressed.
  - Report lands in `target/autopilot/<ts>/report.html` (screenshot gallery) and
    `target/autopilot/<ts>/report.json`.

- **`summarize.mjs`** — prints the run summary and computes the **authoritative ad-block
  blocking verdict** from the `[aegis-count]` A/B trace in `app.log`. The live shield
  COUNT can't prove blocking for well-known hosts (the WebKit content filter cancels a
  matched request _before_ `resource-load-started` fires, so the counter never sees it —
  see `src-tauri/src/linux_layout.rs`). Instead the fixture is loaded twice — ad-block
  OFF (`?ab=off`, filter removed) then ON (`?ab=on`, filter active) — and the verdict is
  PASS when ad subresources fire in the OFF phase and **vanish** in the ON phase, FAIL if
  any still load with ad-block ON, SKIP if no trace. Pure logic is unit-tested in
  `summarize.test.mjs` (node project) against a real captured trace.

- **`fixture-server.mjs`** — a tiny Node `http.createServer` that serves files from
  `scripts/autopilot/fixture/` over HTTP on `127.0.0.1:8137`. Must be HTTP (not
  `file://`) so the content webview's network ad-block filtering applies. The query
  string is ignored for routing (`split('?')[0]`), so the `?ab=off`/`?ab=on` phase
  markers still serve `index.html` while forcing a full reload. Path traversal is
  rejected (`403`); unknown paths return `404`.

- **`fixture/index.html`** — an ad-bait page: an inline script fires requests
  (`new Image().src`, **cache-busted per load** with a unique query) to known third-party
  ad/tracker hosts so the ad-block A/B trace can verify real blocking. The specific
  domains come from the Brave `adblock` filter lists bundled in the Rust core (EasyList +
  EasyPrivacy + Peter Lowe's + abuse-TLDs). Cache-busting matters because WebKit
  negative-caches a blocked URL, so static ad URLs wouldn't re-fire the load signal.

### How to run

```bash
bash scripts/autopilot/run-autopilot.sh
```

Expected output: `RESULT: N passed, 0 failed, M skipped`, then
`ad-block blocking (trace): PASS — N ad subresource(s) loaded with ad-block OFF, 0 with
ad-block ON`, and the gallery path. If `$DISPLAY`/`$WAYLAND_DISPLAY` is unset, screenshots
are skipped and the functional tour still runs (IPC + ad-block steps only).

### Live run step order (from `src/autopilot/run.ts`)

1. **Screen tour** — every `SCREENS` entry is reached, screenshotted, and torn down.
2. **Catalog verification** — every `CATALOG` entry's `exercise(api)` runs. If `live=true`,
   `verify(api)` also runs for entries that declare it (functional round-trips on the
   disposable profile).
3. **Interaction specs** — every `INTERACTIONS` spec with `layers.includes('live')` runs
   via `makeLiveCtx`. Results appear in the report as `interaction:<spec.id>` rows.
   All mobile-only specs (`domain: 'mobile.*'`) are `['vitest']` only and are NOT
   included in the live run (the live harness drives only the desktop shell).
4. **Ad-block induction** — A/B navigation of the fixture page (ad-block OFF then ON)
   to verify blocking at the network layer.
