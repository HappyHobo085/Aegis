# Aegis — Platform Status & Finishing Guide

Branch: `feat/tauri-migration` (Tauri-only; the Electron implementation was removed).
This is the honest per-platform state and the exact remaining steps to finish, written
because the last pieces are gated on hardware/CI access, not on unwritten code.

## Verified and working now

| Platform | Browse | Ad-block | Secure (UA / HTTPS-Only / malware) | Auto-update | How verified |
|---|---|---|---|---|---|
| **Linux** | ✅ | ✅ full (WebKit content filters) | ✅ | ✅ (tauri updater) | runtime, real hardware |
| **Android** | ✅ | ✅ full (native WebView `shouldInterceptRequest` → Rust `adblock` engine) | ✅ | ✅ (manifest check → releases) | runtime, x86_64 emulator |

## Code-complete; verification gated on hardware/CI (not on missing code)

| Platform | State | What's left to *verify* |
|---|---|---|
| **Windows** | Browses + secure + auto-update + an **injected ad-block tier** (`adblock_inject.rs`: blocks fetch/XHR/sendBeacon to ~54k EasyList domains + cosmetic-hides ~13k selectors). Rust **compile-verified** via `cargo check --target x86_64-pc-windows-gnu`. | Run the **Tauri Build Check** CI (real Windows runner) and confirm green. Optionally upgrade the injected tier to **full network interception** (see below) — needs a Windows box to develop+verify. |
| **macOS** | Same `cfg(not(target_os="linux"))` code as Windows + the injected ad-block tier. Cannot be compile-checked from Linux (no macOS SDK). | Run the Build Check CI (macOS runner) / build on a Mac. |
| **iOS** | Not built. Needs macOS + Xcode. | `npm run tauri -- ios init && tauri ios build` on a Mac. Ad-block there is the capped `WKContentRuleList` tier (Apple policy). |

## Exact finishing steps

1. **See the Windows/macOS build-check results** (the only thing blocking desktop verification right now):
   - `gh auth login` (or set a `repo`+`actions:read` token), then
   - `gh run list --branch feat/tauri-migration` and `gh run watch <id>` for the **Tauri Build Check** workflow.
   - Fix any red job against its real log, push, re-verify. (Expected green: the Windows Rust cross-compiles and macOS shares the same `not(linux)` code.)

2. **Turn on the real auto-update feed** (desktop + Android):
   - Add the `TAURI_SIGNING_PRIVATE_KEY` repo secret (key at `~/.aegis-updater.key`), push a `v*` tag → `tauri-release.yml` builds + publishes signed bundles + `latest.json`.
   - For the Android updater, ensure `latest.json` includes an `android-universal` platform entry pointing at the published APK (the client checks `platforms[android-*]`).

3. **Full network ad-block on Windows** (optional — beyond the shipped injected tier):
   - wry 0.55 does **not** expose general request interception (only custom-protocol URIs — verified in `wry/src/webview2/mod.rs`). Full blocking needs a `[patch.crates-io]` fork of wry to add an all-URLs `WebResourceRequested` filter + a block-decision hook, threaded through `tauri`'s `WebviewBuilder`, calling `adblock_engine::should_block`. Develop and verify this on Windows.

4. **macOS / iOS**: build on a Mac (`tauri build`, `tauri ios build`).

5. **Make Tauri the default**: merge `feat/tauri-migration` → `main` (it removes the legacy Electron app, still present on `main`).

## Test gate

`npm test` = **417** unit tests (the React UI + shared + scripts). `cd src-tauri && cargo test` = the Rust units (adblock engine toggle/allowlist, injected-blocker build, update version/manifest, safety). The old 952/954 figures included Electron tests that were deleted with the Electron implementation.
