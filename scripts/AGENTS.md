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
- **`check-bundle-size.mjs`**, **`check-android-versioncode.mjs`** — the other two
  CI gates (gzipped `dist/assets` vs `BUDGETS`; Android `versionCode` monotonicity
  vs `AEGIS_BASE_REF`). They are top-level CLIs like `check-npm-audit.mjs`, with
  the same "one implementation, wired into both `npm run` and `ci.yml`" shape.
- **`cliGates.test.mjs`** — spawns all three CLIs as subprocesses in a **copied
  sandbox** and asserts the exit code _and_ the operator-facing message. Three
  facts force that shape:
  - All three read their inputs at module load and call `process.exit()`, so
    importing one would run it and kill the test worker. There is no in-process
    seam.
  - Each resolves its repo root from its **own file location**, so copying the
    script into a temp dir re-roots it and makes the fixture `dist/`, `.git` and
    `.audit-allowlist.json` ordinary sandbox files. Nothing in the real working
    tree is touched — which matters, because there is a **real `dist/`** here.
  - `npm audit` is reached through `execFileSync('npm', …)`, so the sandbox puts a
    fixture-printing `npm` shim first on the spawned `PATH`; the shim's own exit
    code is a variable, because `npm audit` exits non-zero whenever it finds
    anything (the _normal_ path for a report with findings).
- **`coverageCheck.mjs`** — pure logic, no I/O, shared by **both** coverage gates
  (TypeScript and Rust). Exports `METRICS`, `coversLess` (exact integer
  cross-multiplication, so an unchanged tree can never fail on float noise),
  `pctOf` (returns `undefined` for a 0/0 metric so it is not compared at all),
  `buildBaseline`, `compareToBaseline` (gates the **file list** too, so a new
  `coverage.exclude` cannot be used to make the numbers look better), and
  `detectBaselineLowering`. `coverageCheck.test.mjs` covers it.
- **`rustCoverageCheck.mjs`** — the Rust-side translation, the one place an llvm
  measurement could quietly stop meaning what it claims: llvm `regions` become the
  `statements` slot (a different unit, documented as a deliberate fiction),
  totals are **re-summed from the kept files** instead of read from llvm's own
  `totals` (which includes the excluded files, so trusting it would make the
  exclusion a no-op that still moved the headline), and `EXCLUSIONS` is the
  committed list of files that cannot execute in a headless runner — each with a
  mandatory sentence-length reason **and** an `expectOn` platform. A file
  `expectOn` this host that matches nothing is a hard failure; a file for another
  platform is reported as inert. `rustCoverageCheck.test.mjs` covers it, including
  a check that every listed file really exists on disk (a typo would make the
  exclusion a silent no-op).
- **`coverage-ratchet.mjs`** / **`coverage-baseline.mjs`** / **`rust-coverage-ratchet.mjs`** /
  **`rust-coverage-baseline.mjs`** — the four CLIs. The two ratchets are the CI
  gates; both are three-failure-mode gates (below baseline / baseline lowered vs
  `git show HEAD:…` / a baseline file dropped out of the report) and both print
  their excluded files with their **real** numbers on every run.
  `COVERAGE_ALLOW_BASELINE_LOWER=1` is the documented, deliberately noisy escape
  hatch for the lowering check. Each ratchet also accepts a path to a saved
  `llvmcov.json` (or `coverage-summary.json`) so a CI failure can be reproduced
  from an artifact without re-instrumenting.
  `rust-coverage-ratchet.mjs` additionally prints **per-file covered-line deltas**
  on failure (via `perFileDeltas` in `rustCoverageCheck.mjs`). A total cannot be
  diagnosed on its own, and the specific case it exists for: an **unchanged
  denominator with a falling numerator means code stopped EXECUTING** — the three
  keychain round-trips in `sync_keystore.rs` early-return without a keyring, so a
  `cargo llvm-cov` run outside CI's `dbus-run-session` measured 11038/14750 against
  a 11175/14750 baseline. Naming `sync.rs` and `sync_keystore.rs` directly is the
  difference between a one-run diagnosis and re-running the toolchain locally to
  reconstruct it. `totalDelta` separates "the file shrank" from "the file's code
  stopped running".

## Allowlist

`../.audit-allowlist.json` (`{ "allow": [<source-id|url>, ...] }`). To accept a
high/critical advisory, add its numeric `source` or `url` there **with
justification in the commit** — that's the documented escape hatch.

## Version overrides

`package.json` also carries an `overrides` block, which is the **preferred** way to
clear a high/critical advisory: it forces a fixed transitive version repo-wide,
rather than silencing the check.

### The system npm on this machine cannot resolve this tree

`npm audit fix`, `npm update` and plain `npm install <pkg>` all abort with an
internal npm error — `Cannot read properties of null (reading 'edgesOut')`, thrown
from `#loadPeerSet` in arborist's `build-ideal-tree.js`. It is **not** caused by
this repo: removing the `overrides` block entirely still reproduces it, and the
stack is peer-dependency resolution, which `npm ci` never does (that is why CI,
which only ever runs `npm ci`, is unaffected). The bundled npm is 10.9.7
(`/usr/lib/node_modules_22/npm`, i.e. Node 22.22.2's).

**Workaround — use npm 11 for any command that builds an ideal tree:**

```bash
npx --yes npm@11 install --no-bin-links            # incremental install
npx --yes npm@11 install --package-lock-only <pkg> # regenerate the lock only
```

Both work and produce a correct lock. `npx npm@11 install --package-lock-only
vitest@4.1.11` bumped the lock across `vitest` + the `@vitest/*` siblings in one
133-line diff and reported `found 0 vulnerabilities`. Note it also records the
root `engines` (`node >=22.12.0`) into the lock's root entry, which npm 10 had
been omitting — that field is already in `package.json`, so it is a correction,
not a new constraint.

`--no-bin-links` is still required: this workspace mount rejects the symlinks
npm would create under `node_modules/.bin` (EPERM), so run tools by explicit path
(`node node_modules/vitest/vitest.mjs run`, `node node_modules/typescript/bin/tsc`,
…). Keeping the `overrides` entries hand-written below is still the right call for
_advisories_ — but a version **bump** no longer needs hand-editing.

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
npm test                           # includes auditCheck.test.mjs + cliGates.test.mjs
```

### Coverage ratchets

```bash
npm run test:coverage              # the suite + the v8 report (coverage/, gitignored)
npm run coverage:baseline          # regenerate coverage-baseline.json — ONLY when coverage went UP
npm run coverage:ratchet           # the CI gate (TypeScript)
export PATH="$HOME/.cargo/bin:$PATH"   # rustup/cargo are not on PATH by default
npm run coverage:rust:baseline     # regenerate src-tauri/coverage-baseline.json
npm run coverage:rust:ratchet      # the CI gate (Rust)
```

**The Rust side needs `cargo-llvm-cov` and the `llvm-tools-preview` component**,
neither of which is a `Cargo.toml` change (so `Cargo.lock` and the ~4-minute
dependency rebuild are untouched):

```bash
rustup component add llvm-tools-preview
cargo install cargo-llvm-cov --locked
```

**"0% in a coverage report" is not the same claim as "untested".** The v8 provider
instruments only the test worker's own V8 runtime, so a **spawned subprocess earns
zero coverage credit** — `cliGates.test.mjs` really does cover three of the
zero-percent CLI scripts with 30 passing tests and the report still says 0%. The
same is true in reverse for Rust: `main.rs` and the Kotlin surface are not
`--lib` targets, so they are absent from the report rather than excluded from it.
The Rust ratchet prints every excluded file with its real numbers on each run for
the same reason.

**Regenerate a baseline whenever the measured file list changes, not only when
coverage goes up.** `vitest.config.ts` measures everything matching `include`, so
adding a source file — even a 0%-covered CLI shell — lowers every ratio while the
covered count stays flat or rises. A baseline built from a run that predates new
files is simply wrong, and the ratchet fails on the first CI run after the commit
that added them. Land the correction with `COVERAGE_ALLOW_BASELINE_LOWER=1` and say
in the commit why. (This is not hypothetical: it is exactly how
`coverage-baseline.json` first went stale, in the commit that added
`rust-coverage-baseline.mjs` and `rust-coverage-ratchet.mjs`.)

**A percentage can move either way without the codebase following it.** Deleting a
block of 0%-covered code raises the ratio and moves not one test; adding one lowers
it and moves none either. The ratio is what CI can cheaply compare, so the
absolute `covered` counts in `AGENTS.md` are the honest companion number.

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

## No automated gate exercises the real Rust core or a real webview

Stated plainly because it is the most important caveat in this file: **nothing in CI
drives the shipped app.** Platform-specific behaviour (the Linux WebKit content-filter
tier, the Windows `WebView2` network tier, the Android Kotlin `shouldInterceptRequest`
tier, multi-webview layout, the OS keychain, StrongBox) is covered only by the manual
verification notes in `src-tauri/AGENTS.md`, and `tauri-build-check.yml` only proves the
app compiles and bundles per-OS — it runs no tests. Renderer behaviour is covered by
co-located vitest tests against the IPC mock; the Rust core by `cargo test` against a
`MockRuntime` app. Neither is a GUI run or an on-device run.
