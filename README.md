# Aegis

A cross-platform, ad-blocking browser shell built on **Tauri 2** (Rust core) with a
**React 19 + TypeScript** UI. Targets **Linux, Windows, macOS, and Android**.

> The Rust core is **not** standalone — Tauri serves the built React UI. Every release
> build runs `npm run build:renderer` first (wired via `beforeBuildCommand` in
> `src-tauri/tauri.conf.json`), so you never build the frontend by hand.

---

## What Aegis does

A browser whose whole design goal is **blocking ads and trackers without breaking
pages**, plus a set of privacy features that mainstream browsers either bolt on or omit.

### Ad & tracker blocking

Blocking is layered, because no single interception point works on every platform:

| Tier                        | Where it runs                                                                        | What it covers                                                           |
| --------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Declarative content filters | Linux (WebKitGTK)                                                                    | The bulk of EasyList/EasyPrivacy, applied by the engine itself           |
| Network interception        | Windows (WebView2 `WebResourceRequested`), Android (Kotlin `shouldInterceptRequest`) | Full request-time blocking                                               |
| Injected document-start JS  | All desktop platforms                                                                | Pop-under guards, cosmetic filtering, the WebRTC shim, autofill plumbing |

All tiers read the **same** bundled lists (EasyList + EasyPrivacy + Peter Lowe's) plus
your own custom filters and subscriptions, so behaviour does not silently diverge by
platform. Per-host allowlisting and a global on/off toggle apply to every tier.

A pop-under / new-window guard drops blank and script-scheme shells and known ad
destinations, so `window.open()` ad shells do not accumulate as background tabs.

### Privacy

- **Encrypted password vault** — XChaCha20-Poly1305 records under an Argon2id
  master-password KDF, stored in a `0600` file, with a per-record `updatedAt` merge.
  _Autofill is not implemented yet_ — the vault is manage-only for now (see
  [Status](#status--what-is-and-is-not-verified)).
- **End-to-end encrypted sync** — your own server (the `sync-server/` crate), Ed25519
  device tokens, HLC last-writer-wins merge. The server stores only opaque ciphertext.
  Credentials are sealed under _both_ the sync root and the vault key, so holding the
  recovery phrase alone is not enough to read them.
- **Anti-fingerprinting / farbling** — opt-in (`off` / `standard` / `strict`).
  `standard` perturbs canvas, audio, and navigator/UA-CH values consistently;
  `strict` adds WebGL. Per-site allowlist support.
- **WebRTC IP-leak defense** — configurable via the `webrtcPolicy` setting, with a
  native backstop on top of the injected shim.
- **Private / ephemeral tabs** — no history, no downloads entry, not reopenable after
  close, and an in-memory webview where the platform supports it.
- **Content-webview proxy** — optional HTTP or SOCKS5 proxy. This is a _proxy_, not a
  VPN: it covers the browsing webview only, and DNS/QUIC/UDP egress is outside its
  path.
- **Per-site permissions** (camera/microboard/notifications), with remember/reset
  controls.

### Browser basics

Tab strip with **workspaces**, **split view**, find-in-page, a command palette, downloads,
bookmarks/favourites, history, an omnibox with site-info popover, per-tab private mode,
and a configurable ad-block shield with a live blocked-count badge.

---

## Status — what is and is not verified

Honesty here is deliberate; the `AGENTS.md` files in each directory are the authoritative
per-subsystem record, and they document what is _pending_ as well as what ships.

- **Verified on real hardware:** Linux desktop (browses, ad-blocks, blocks securely) and
  Windows 11 (both the WebView2 network tier and the injected tier).
- **Compiles and bundles but is not GUI-verified:** macOS. Some macOS-native tiers are
  CI-compile-only by construction, and the **content-webview proxy is not implemented on
  macOS at all**.
- **Android:** browses, ad-blocks, and is secure (emulator-verified). Some tiers are
  weaker by design — see the per-platform notes in `src-tauri/AGENTS.md`.
- **iOS:** unstarted (needs macOS + Xcode).
- **Not implemented:** password autofill (the vault is manage-only), macOS proxy,
  macOS/Android find-in-page parity, and the Android farbling allowlist.

> **No automated gate exercises the real Rust core or a real webview.** The test suite is
> vitest-level and runs against an IPC mock. Platform-specific behaviour — the Linux
> WebKit filter tier, the Windows WebView2 tier, the Android `shouldInterceptRequest`
> tier, multi-webview layout, the OS keychain, StrongBox — is covered only by the manual
> verification notes in `src-tauri/AGENTS.md`. The cross-OS CI workflow proves the app
> _compiles and bundles_ per OS; it runs no tests.

---

## Architecture

```
┌──────────────────────────── Tauri window ────────────────────────────┐
│  CHROME webview  = the React UI in src/  (toolbar, sidebar, modals)    │
│  CONTENT webview = the page the user is browsing (second webview)      │
└───────────────────────────────────────────────────────────────────────┘
        ▲  invoke('ipc', {channel, payload})   │  events (nav.state, …)
        │  ───────────────────────────────────▶ │ ◀───────────────────────
   src/lib/ipcClient.ts                      src-tauri/src/lib.rs  ipc()
```

- **One IPC chokepoint.** Every renderer→core call goes through `src/lib/ipcClient.ts` →
  `invoke('ipc', {channel, payload})` → a single `ipc()` command that dispatches by
  channel. Channel names live in `shared/types.ts`. Adding a channel means touching
  three files, and a drift-guard test enforces that correspondence.
- **Desktop** runs one chrome webview plus one content webview per tab; background tabs
  are hidden and idle tabs discarded. **Android** runs a single webview with a native
  Kotlin content `WebView` bridged as `window.AegisAndroid`.
- **Sync-server** (`sync-server/`) is a standalone axum crate that stores opaque
  ciphertext. It is a separate, non-workspace crate.

The `AGENTS.md` file in each directory is a **living document** describing current
behaviour, including known gotchas. Read the one for the area you are changing.

---

## Prerequisites (all platforms)

```bash
node -v          # Node 22.x (CI uses 22)
rustc --version  # Rust toolchain pinned by rust-toolchain.toml (MSRV 1.88)
npm install      # JS deps (Rust deps resolve on first build)
```

`productName` is **Aegis**, app id **com.aegis.browser**, version **0.1.0** (from
`package.json` + `src-tauri/tauri.conf.json`). Artifact filenames embed that version.

> **Tauri builds natively, per-OS.** You cannot bundle Windows or macOS installers from
> Linux — build each desktop OS on its own machine, **or** use the CI release workflow
> (see [CI release builds](#ci-release-builds-recommended-for-cross-platform)).

---

## Development

```bash
npm run tauri:dev      # run desktop app (hot reload)
npm run android:dev    # run on Android emulator/device
npm test               # full vitest suite (renderer + shared + scripts)
```

### Gates

Every one of these runs in CI on every PR and push to `main`:

| Command                                                         | What it enforces                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `npm run typecheck`                                             | `tsc --noEmit`, including test files and the build configs                |
| `npm run lint`                                                  | ESLint                                                                    |
| `npm run format:check`                                          | Prettier (markdown included)                                              |
| `npm test`                                                      | vitest — node project (`shared/`, `scripts/`) + jsdom project (`src/`)    |
| `node scripts/check-npm-audit.mjs`                              | no high/critical npm advisories; **fails closed** if the audit cannot run |
| `cargo fmt --check` / `cargo clippy -D warnings` / `cargo test` | for `src-tauri` **and** `sync-server`                                     |
| `cargo audit`                                                   | Rust advisories (**blocking**, despite the historical "advisory" label)   |

Renderer tests are **co-located** vitest files running against the IPC mock
(`src/testFixtures/aegisMock.ts`); the Rust core is covered by `cargo test` against a
`MockRuntime` app. Neither gate drives a real webview, a real browser, or real hardware —
see the platform matrix above for what is verified and what is not.

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

| Artifact       | Path                                                                  |
| -------------- | --------------------------------------------------------------------- |
| AppImage       | `src-tauri/target/release/bundle/appimage/Aegis_0.1.0_amd64.AppImage` |
| Debian package | `src-tauri/target/release/bundle/deb/Aegis_0.1.0_amd64.deb`           |
| Raw binary     | `src-tauri/target/release/app`                                        |

> **AppImage distribution caveat:** build the AppImage on a **recent** distro
> (the CI uses `ubuntu-24.04`). An AppImage built on `ubuntu-22.04` bundles a webkit2gtk
> that aborts in Skia's COLR-v1 color-font path on newer hosts (e.g. Fedora) → blank/frozen
> pages. The `.deb` and local dev builds are unaffected.

---

## Windows desktop (NSIS installer)

Build **on Windows** with:

- **Visual Studio** with the _Desktop development with C++_ workload (bundles CMake).
- **NASM** ([nasm.us](https://www.nasm.us/)) on `PATH` — required by `aws-lc-sys` (rustls' crypto backend).
- The **WebView2 Runtime** (preinstalled on Windows 10/11).

```powershell
npm install
npm run tauri:build        # or: npm run build
```

**Output:**

| Artifact       | Path                                                             |
| -------------- | ---------------------------------------------------------------- |
| NSIS installer | `src-tauri\target\release\bundle\nsis\Aegis_0.1.0_x64-setup.exe` |
| Raw binary     | `src-tauri\target\release\app.exe`                               |

> If `cargo` fails every crates.io fetch with `CRYPT_E_NO_REVOCATION_CHECK` (a network
> that blocks OCSP/CRL), set `http.check-revoke = false` in `~/.cargo/config.toml`.

> **Multi-tab note:** webview creation is deliberately off the UI thread on Windows —
> WebView2's async `CreateCoreWebView2Controller` cannot complete while the event loop
> is blocked. Do not "simplify" that back onto the main thread; see gotcha 17 in
> `src-tauri/AGENTS.md`.

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

| Artifact   | Path                                                                          |
| ---------- | ----------------------------------------------------------------------------- |
| App bundle | `src-tauri/target/release/bundle/macos/Aegis.app`                             |
| Disk image | `src-tauri/target/release/bundle/dmg/Aegis_0.1.0_aarch64.dmg` (or `_x64.dmg`) |

> macOS-native code can only be compiled on a Mac; it cannot be cross-built from Linux.
> Some macOS tiers (find-in-page, URL tracking, zoom) are compile-verified only.

---

## Android (release APK)

**Requirements:**

- **JDK 21** — _not_ a newer JDK. Gradle/AGP here fail under JDK 25. Use Android Studio's
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

| Artifact                    | Path                                                                                      |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| Universal release APK       | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| (debug, from `android:dev`) | `src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk`     |

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

## Running your own sync server

```bash
cd sync-server
cargo run --release
```

It listens on **HTTP :8787** by default and stores only opaque ciphertext. Put it behind
TLS — the app requires an `https://` sync server URL unless the host is loopback, and
refuses plain `http://` for anything else.

Point Aegis at it in **Settings → Sync**. See `sync-server/AGENTS.md`.

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

Run manually (Actions → _Tauri Build Check_ → _Run workflow_) to get downloadable,
unsigned artifacts (retained 14 days) for on-device testing:

- **Windows** → `Aegis_x64_portable.exe` (raw portable exe, no installer)
- **macOS** → `.app` + `.dmg`
- **Linux** → portable `.AppImage` (built on `ubuntu-24.04`)
- **Android** → release APK (debug-key-signed, all 4 ABIs)

---

## Output locations at a glance

| Platform         | Command                            | Artifact path (from repo root)                                                            |
| ---------------- | ---------------------------------- | ----------------------------------------------------------------------------------------- |
| Linux            | `npm run tauri:build`              | `src-tauri/target/release/bundle/appimage/Aegis_0.1.0_amd64.AppImage`                     |
| Linux            | `npm run tauri:build`              | `src-tauri/target/release/bundle/deb/Aegis_0.1.0_amd64.deb`                               |
| Windows          | `npm run tauri:build` (on Windows) | `src-tauri/target/release/bundle/nsis/Aegis_0.1.0_x64-setup.exe`                          |
| macOS            | `npm run tauri:build` (on macOS)   | `src-tauri/target/release/bundle/{macos/Aegis.app, dmg/Aegis_0.1.0_<arch>.dmg}`           |
| Android          | `npm run android:build`            | `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk` |
| All desktop (CI) | push `v*` tag                      | GitHub Release assets (draft)                                                             |

---

## Versioning

A release version lives in **three** files — keep them in sync before tagging:

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`

Android `versionCode`/`versionName` come from `src-tauri/gen/android/tauri.properties`
(`tauri.android.versionCode` / `tauri.android.versionName`).

---

## Security

Report security issues privately rather than opening a public issue. `SECURITY.md`
describes the threat model, what is and is not defended, and the reporting path.

A few things worth knowing:

- The content webview has **no Tauri IPC access** (`withGlobalTauri` is not enabled), so a
  page cannot invoke the core. It also cannot reach the OS keychain, which is accessed
  only from Rust.
- Settings writes go through a **per-key allow-list with validators**, so a
  compromised renderer cannot repoint the home page at a `file://` URL or flip a
  security control to a permissive value in one call.
- The element picker's page→core channel is **nonce-gated**: a page that sets
  `document.title` to the picker's sentinel without a live pick is rejected.

---

## License

**GNU Affero General Public License v3.0 only** — see [`LICENSE`](./LICENSE).

The AGPL's section 13 matters if you run a modified Aegis as a network service: you must
offer those users the corresponding source of your version.
