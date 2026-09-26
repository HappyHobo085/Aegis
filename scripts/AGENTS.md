# scripts/ — supply-chain CI gate

Node ESM scripts that gate CI on `npm audit`, plus build and deployment scripts.
Tested in the vitest **node** project.

## CI Workflows

GitHub Actions workflows in `.github/workflows/`:

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on every push to `main`
  (so a direct push is gated too, not just PRs), weekly (Mon 06:17 UTC), and on
  demand. Ubuntu only; three parallel jobs:
  - **`web`**: `npm ci` → `npm run typecheck` (`tsc --noEmit` via
    `tsconfig.build.json`, which now typechecks test files and `src/testFixtures`
    too — a test-only type error is a real error) → `npm run lint` (ESLint flat
    config, errors fail / warnings are the migration backlog) →
    `npm run format:check` (Prettier) → `npm test` (vitest node + jsdom) →
    `node scripts/check-npm-audit.mjs`.
  - **`rust`**: installs the webkit2gtk build deps, then
    `cargo fmt --check` → `cargo clippy -- -D warnings` → `cargo test` (the
    `src-tauri` unit tests, Linux-cfg paths) for `src-tauri/Cargo.toml`, plus
    `cargo audit` over the crypto/keyring/TLS deps. That audit is **blocking**
    despite the historical "advisory" label — it has no `continue-on-error`, so any
    new advisory fails the job. Two known findings
    (`RUSTSEC-2026-0194`, `RUSTSEC-2026-0195`) are pinned open via `--ignore`
    because the Tauri/plist chain constrains quick-xml; they carry no expiry.
  - **`sync-server`**: the same fmt/clippy/test/audit sequence for the standalone
    `sync-server/Cargo.toml`. It is the only internet-facing service, and it had no
    CI at all before — a `sync-server` lockfile with a vulnerable dependency would
    not have been caught.

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

## Version overrides

`package.json` also carries an `overrides` block, which is the **preferred** way to
clear a high/critical advisory: it forces a fixed transitive version repo-wide,
rather than silencing the check. `npm audit fix` cannot be relied on here — on this
tree it aborts with an internal npm error (`Cannot read properties of null (reading
'edgesOut')`), so the overrides are written by hand.

Current entries, and why each exists:

- `brace-expansion` `^5.0.9` — GHSA-rgw5-rvv9-x895 (unbounded intermediate arrays).
  Pulled in by `eslint` → `minimatch`. Was on `main` before this file was written.
- `browserslist` `^4.29.1` — GHSA-c83g-rgw3-j3cx (unbounded memory growth) and
  GHSA-73wf-gq98-2v4g (uncaught crash via untrusted `browserslist-stats.json`).
  Pulled in by `@babel/helper-compilation-targets`. The first advisory was already
  on `main`; the second arrived with `@rolldown/plugin-babel`.
- `nanoid` `^3.3.18` — GHSA-2v37-7h3g-55p8 (infinite loop when `size` is 0). Pulled
  in by `postcss`. Already on `main`.

npm has no JSON comment support, so this file is where the rationale lives. A
`"//"` key inside `overrides` is a hard error (`Override without name: //`), not a
comment.

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
  (the media-framework override ships matched GStreamer plugins — see `src-tauri/AGENTS.md`
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

**There is no live autopilot launcher in this repo.** `scripts/autopilot/` — the
`run-autopilot.sh` entry point, `summarize.mjs`, `fixture-server.mjs` and the `fixture/`
ad-bait page that earlier revisions of this file documented — does not exist, and neither
does `src/autopilot/run.ts` / `report.ts` or the `src-tauri/src/autopilot.rs` module.

What actually runs is the vitest-level autopilot under `src/autopilot/`, covered in
`src/AGENTS.md`: the feature `CATALOG`, the `SCREENS` list, the interaction specs, and the
`coverage.test.ts` drift guard, all executing against `src/testFixtures/aegisMock.ts`.

Consequence worth stating plainly: **no automated gate here exercises the real Rust core
or a real webview.** Platform-specific behaviour (the Linux WebKit content-filter tier,
the Windows `WebView2` network tier, the Android Kotlin `shouldInterceptRequest` tier,
multi-webview layout, the OS keychain, StrongBox) is covered only by the manual
verification notes in `src-tauri/AGENTS.md`, and `tauri-build-check.yml` only proves the
app compiles and bundles per-OS — it runs no tests.
