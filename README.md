# Aegis

A cross-platform, ad-blocking browser shell built on **Tauri 2** (Rust core) with a
**React 19 + TypeScript** UI. Targets **Linux, Windows, macOS, and Android**.

> The Rust core is **not** standalone — Tauri serves the built React UI. Every release
> build runs `npm run build:renderer` first (wired via `beforeBuildCommand` in
> `src-tauri/tauri.conf.json`), so you never build the frontend by hand.

This document covers **how to produce release builds** and **where the artifacts land**.
For day-to-day development use `npm run tauri:dev` (desktop) or `npm run android:dev`.

---

## Prerequisites (all platforms)

```bash
node -v          # Node 22.x (CI uses 22)
rustc --version  # Rust stable toolchain
npm install      # JS deps (Rust deps resolve on first build)
```

`productName` is **Aegis**, app id **com.aegis.browser**, version **0.1.0** (from
`package.json` + `src-tauri/tauri.conf.json`). Artifact filenames embed that version.

> **Tauri builds natively, per-OS.** You cannot bundle Windows or macOS installers from
> Linux — build each desktop OS on its own machine, **or** use the CI release workflow
> (see [CI release builds](#ci-release-builds-recommended-for-cross-platform)).

---

## Linux desktop (AppImage + .deb)

**Extra deps** (Fedora names; Debian/Ubuntu equivalents in parentheses):
`webkit2gtk4.1-devel` (`libwebkit2gtk-4.1-dev`), `gtk3-devel`, `libappindicator-gtk3-devel`
(`libappindicator3-dev`), `librsvg2-devel` (`librsvg2-dev`), `libxdo-devel` (`libxdo-dev`),
`patchelf`.

```bash
npm run tauri:build
# = APPIMAGE_EXTRACT_AND_RUN=1 NO_STRIP=1 tauri build
```

**Output:**

| Artifact | Path |
| -------- | ---- |
| AppImage | `src-tauri/target/release/bundle/appimage/Aegis_0.1.0_amd64.AppImage` |
| Debian package | `src-tauri/target/release/bundle/deb/Aegis_0.1.0_amd64.deb` |
| Raw binary | `src-tauri/target/release/app` |

> **AppImage distribution caveat:** build the AppImage on a **recent** distro
> (the CI uses `ubuntu-24.04`). An AppImage built on `ubuntu-22.04` bundles a webkit2gtk
> that aborts in Skia's COLR-v1 color-font path on newer hosts (e.g. Fedora) → blank/frozen
> pages. The `.deb` and local dev builds are unaffected.

---

## Windows desktop (NSIS installer)

Build **on Windows** with:

- **Visual Studio** with the *Desktop development with C++* workload (bundles CMake).
- **NASM** ([nasm.us](https://www.nasm.us/)) on `PATH` — required by `aws-lc-sys` (rustls' crypto backend).
- The **WebView2 Runtime** (preinstalled on Windows 10/11).

```powershell
npm install
npm run tauri:build        # or: npm run build
```

**Output:**

| Artifact | Path |
| -------- | ---- |
| NSIS installer | `src-tauri\target\release\bundle\nsis\Aegis_0.1.0_x64-setup.exe` |
| Raw binary | `src-tauri\target\release\app.exe` |

> If `cargo` fails every crates.io fetch with `CRYPT_E_NO_REVOCATION_CHECK` (a network
> that blocks OCSP/CRL), set `http.check-revoke = false` in `~/.cargo/config.toml`.

---

## macOS desktop (.app + .dmg)

Build **on macOS** with **Xcode** + Command Line Tools (`xcode-select --install`).

```bash
npm install
npm run tauri:build                                  # native arch
# Or target a specific arch explicitly:
npm run tauri -- build --target aarch64-apple-darwin # Apple Silicon
npm run tauri -- build --target x86_64-apple-darwin  # Intel
```

**Output** (arch in the filename matches the build target):

| Artifact | Path |
| -------- | ---- |
| App bundle | `src-tauri/target/release/bundle/macos/Aegis.app` |
| Disk image | `src-tauri/target/release/bundle/dmg/Aegis_0.1.0_aarch64.dmg` (or `_x64.dmg`) |

> macOS-native code can only be compiled on a Mac; it cannot be cross-built from Linux.

---

## Android (release APK)

**Requirements:**

- **JDK 21** — *not* a newer JDK. Gradle/AGP here fail under JDK 25. Use Android Studio's
  bundled JBR.
- **Android SDK** (`ANDROID_HOME`) + **NDK 27**.
- One-time project init only if `src-tauri/gen/android/` is missing: `npm run tauri android init`.

```bash
# Point JAVA_HOME at a JDK 21 (e.g. Android Studio's JBR):
export JAVA_HOME="$HOME/development/android-studio/jbr"

npm run android:build                      # universal release APK (all ABIs)
npm run android:build -- --target aarch64  # arm64-only (smaller; for a phone)
```

**Output:**

| Artifact | Path |
| -------- | ---- |
| Universal release APK | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| (debug, from `android:dev`) | `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` |

**Signing:** by default the release APK is signed with the **debug key** (installs fine,
but is not a Play-Store upload key and is not an update channel). For a real release key,
drop a gitignored **`keystore.properties`** at the repo root:

```properties
storeFile=/absolute/path/to/release.keystore
storePassword=********
keyAlias=aegis
keyPassword=********
```

The Gradle config auto-detects it and signs the release build with it.

---

## CI release builds (recommended for cross-platform)

Since installers must be built on their own OS, the easiest way to get **all** desktop
installers from one machine is the GitHub Actions release workflow.

### `tauri-release.yml` — tagged release (signed + auto-update feed)

Push a `v*` tag (or run it from the Actions tab). It builds **Linux + Windows + macOS
(Apple Silicon & Intel)** via `tauri-apps/tauri-action`, generates `latest.json`, and
publishes a **draft** GitHub Release with the installers attached.

```bash
# Bump the version in all three places first (see Versioning below), commit, then:
git tag v0.1.0
git push origin v0.1.0
```

> Update signatures need repo secrets `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`). Without
> them the build still succeeds but emits no signature, so auto-update won't verify.

### `tauri-build-check.yml` — on-demand test artifacts

Run manually (Actions → *Tauri Build Check* → *Run workflow*) to get downloadable,
unsigned artifacts (retained 14 days) for on-device testing:

- **Windows** → `Aegis_x64_portable.exe` (raw portable exe, no installer)
- **macOS** → `.app` + `.dmg`
- **Linux** → portable `.AppImage` (built on `ubuntu-24.04`)
- **Android** → release APK (debug-key-signed, all 4 ABIs)

---

## Output locations at a glance

| Platform | Command | Artifact path (from repo root) |
| -------- | ------- | ------------------------------ |
| Linux | `npm run tauri:build` | `src-tauri/target/release/bundle/appimage/Aegis_0.1.0_amd64.AppImage` |
| Linux | `npm run tauri:build` | `src-tauri/target/release/bundle/deb/Aegis_0.1.0_amd64.deb` |
| Windows | `npm run tauri:build` (on Windows) | `src-tauri/target/release/bundle/nsis/Aegis_0.1.0_x64-setup.exe` |
| macOS | `npm run tauri:build` (on macOS) | `src-tauri/target/release/bundle/{macos/Aegis.app, dmg/Aegis_0.1.0_<arch>.dmg}` |
| Android | `npm run android:build` | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| All desktop (CI) | push `v*` tag | GitHub Release assets (draft) |

---

## Versioning

A release version lives in **three** files — keep them in sync before tagging:

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`

Android `versionCode`/`versionName` come from `src-tauri/gen/android/tauri.properties`
(`tauri.android.versionCode` / `tauri.android.versionName`).

---

## Quick reference

```bash
npm install            # once
npm run tauri:dev      # run desktop app (hot reload)
npm run android:dev    # run on Android emulator/device
npm run tauri:build    # desktop release bundles for the current OS
npm run android:build  # Android release APK (needs JDK 21)
npm test               # full vitest suite (renderer + shared + scripts)
```
