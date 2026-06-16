# .github/ — CI & supply-chain automation

GitHub Actions workflows and Dependabot config for Aegis.

## Workflows (`workflows/`)

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on push to `main`, and
  weekly (Mon 06:17 UTC). Ubuntu only: `npm ci` → `npm test` (vitest node + jsdom
  projects) → `node scripts/check-npm-audit.mjs` (high/critical audit gate). Fast;
  no native build.
- **`tauri-build-check.yml`** (Tauri Build Check) — proves the app compiles, links,
  and bundles on real OSes and produces downloadable artifacts for on-device
  testing. Triggers on push to `main` and on demand. Matrix:
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

Weekly npm + github-actions updates. All minor/patch npm bumps are grouped into a
single PR to reduce noise; major bumps arrive individually. (Cargo/Rust deps aren't
covered yet — `src-tauri/Cargo.lock` is pinned manually.)

## Notes

- Linux jobs `apt-get install` webkit2gtk/appindicator/rsvg/xdo/patchelf — the apt
  equivalents of the Fedora dev deps.
- CI uses Node 22 with npm cache; cargo registry + `src-tauri/target` are cached by
  `Cargo.lock` hash.
- `tauri-build-check.yml` runs the full multi-OS + Android build on every push to
  `main` (and on demand) — heavier than `ci.yml`.
