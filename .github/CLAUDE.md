# .github/ — CI & supply-chain automation

GitHub Actions workflows and Dependabot config for Aegis.

## Workflows (`workflows/`)

- **`ci.yml`** (CI) — the always-on gate. Runs on every PR, on push to `main`, and
  weekly (Mon 06:17 UTC). Ubuntu only: `npm ci` → `npm test` (vitest node + jsdom
  projects) → `node scripts/check-npm-audit.mjs` (high/critical audit gate). Fast;
  no native build.
- **`tauri-build-check.yml`** (Tauri Build Check) — proves the app compiles, links,
  and bundles on real OSes and produces downloadable artifacts for on-device
  testing. Triggers on push to `feat/tauri-migration` and on demand. Matrix:
  - `windows-latest` → portable `Aegis_x64_portable.exe` (`--no-bundle`, raw exe)
  - `macos-latest` → `.app` + `.dmg`
  - `ubuntu-22.04` → portable `.AppImage` (`--bundles appimage`)
  - plus an `android` job → debug APK (Rust cross-compiled to the 4 Android ABIs).
  Unsigned; publishes nothing. Artifacts retained 14 days.
- **`tauri-release.yml`** (Tauri Release) — the auto-update feed. Triggers on a
  `v*` tag. Builds signed bundles + `latest.json` for Linux/Windows/macOS (Intel +
  Apple Silicon) via `tauri-apps/tauri-action`, publishes a **draft** GitHub
  Release. Needs repo secrets `TAURI_SIGNING_PRIVATE_KEY`
  (+`_PASSWORD`); without them it still builds but emits no update signature.
  Dormant until the Tauri app is on the default branch and a `v*` tag is pushed.

## `dependabot.yml`

Weekly npm + github-actions updates. Minor/patch npm bumps are grouped to reduce
noise; `electron` and `@ghostery/*` are excluded so they arrive as individual PRs.
(That exclusion and its referenced policy doc are legacy-Electron leftovers — inert
on the Tauri branch, kept for when/if Electron tooling matters again.)

## Notes

- Linux jobs `apt-get install` webkit2gtk/appindicator/rsvg/xdo/patchelf — the apt
  equivalents of the Fedora dev deps.
- CI uses Node 22 with npm cache; cargo registry + `src-tauri/target` are cached by
  `Cargo.lock` hash.
- The build-check trigger branch is `feat/tauri-migration`; update it if the Tauri
  work merges to `main`.
