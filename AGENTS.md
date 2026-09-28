# Aegis — project guide

Aegis is a cross-platform, ad-blocking browser shell built on **Tauri 2** (a Rust
core) with a **React 19 + TypeScript** UI. Targets: Linux, Windows, macOS, and
Android (iOS is a future, macOS/Xcode-gated tier).

## Architecture in one picture

```
┌──────────────────────────── Tauri window ────────────────────────────┐
│  CHROME webview  = the React UI in src/  (toolbar, sidebar, modals)    │
│  CONTENT webview = the page the user is browsing (second webview)      │
└───────────────────────────────────────────────────────────────────────┘
        ▲  invoke('ipc', {channel, payload})   │  events (nav.state, …)
        │  ───────────────────────────────────▶ │ ◀───────────────────────
   src/lib/ipcClient.ts                      src-tauri/src/lib.rs  ipc()
```

- The **Rust core is NOT standalone** — Tauri serves the built React UI. From
  `src-tauri/tauri.conf.json`: `frontendDist: "../dist"` and
  `beforeBuildCommand: "npm run build:renderer"`. Deleting the frontend breaks
  the build. The frontend _is_ part of the Rust implementation.
- Desktop runs **one chrome webview + one content webview per tab** via Tauri's
  unstable `Window::add_child`. The active tab's webview is visible; background
  tabs are hidden; idle tabs are discarded and reloaded on next activation.
  Android runs a **single** webview with a native Kotlin content `WebView`
  bridged as `window.AegisAndroid`.

## Folder map

| Folder          | What it is                                          | Has its own AGENTS.md |
| --------------- | --------------------------------------------------- | --------------------- |
| `src/`          | React renderer (the UI / "chrome")                  | yes                   |
| `src-tauri/`    | Rust core + native platform code                    | yes                   |
| `shared/`       | `types.ts` — the IPC contract                       | yes                   |
| `scripts/`      | npm-audit CI gate (Node ESM)                        | yes                   |
| `sync-server/`  | Self-hosted E2E sync server (Rust/axum, standalone) | yes                   |
| `.github/`      | CI workflows + Dependabot                           | yes                   |
| `dist/`         | Vite build output (gitignored)                      | generated, no docs    |
| `node_modules/` | npm deps (gitignored)                               | generated, no docs    |

> **The `AGENTS.md` files are living docs.** Every folder's `AGENTS.md` (this one
> included) documents _current_ behavior — when a change makes one stale, update it
> in the same commit. Treat them as part of the code, not a one-time snapshot.

## Commands

```bash
npm install            # install JS deps (Rust deps resolve on first build)
npm run tauri:dev      # run the app (Vite renderer + Tauri, hot reload)
npm test               # vitest: node project (shared/ + scripts/) + jsdom (src/)
npm run tauri:build    # build installers (AppImage/deb/nsis/app/dmg)
npm run android:dev    # Android emulator/device
npm run android:build  # release APK (signed with the debug key unless keystore.properties exists)
```

Native build deps: a Rust toolchain; on Linux, webkit2gtk/gtk dev packages.

### Testing

```bash
npm test    # vitest: node project (shared/ + scripts/) + jsdom (src/)
```

Tests are **co-located** `*.test.ts` / `*.test.tsx` files, and they mock the IPC surface
(`src/testFixtures/aegisMock.ts`) rather than driving a real browser or a real webview.
A mutating user flow must be driven somewhere that **actually executes**: a component
test that clicks/types the real UI, and/or a unit test in the owning Rust module.

### Test coverage — a ratchet, not a 100% claim

`@vitest/coverage-v8` measures **every** non-excluded source file (`src/**`, `shared/**`,
`scripts/**` — 119 files) on every run, and the measured numbers are committed in
`coverage-baseline.json`. CI enforces them as a **ratchet that may only go up**
(`scripts/coverage-ratchet.mjs`). It fails if any metric drops below the baseline, if the
baseline was _lowered_ in the same commit, or if a file the baseline names is missing from
the report. Raising the baseline is free; lowering it needs a deliberate, reviewable diff.

```bash
npm run test:coverage      # the suite + the v8 report (coverage/, gitignored)
npm run coverage:baseline  # regenerate coverage-baseline.json — only when coverage went UP
npm run coverage:ratchet   # the CI gate
```

**Regenerate the baseline whenever the measured file list or the totals change, not only when
coverage goes up.** `vitest.config.ts` measures everything matching `include`, so adding a
source file — even a 0%-covered one — lowers every ratio while leaving the covered count
alone or higher. A baseline generated from a run that predates new files is simply _wrong_,
and the ratchet will (correctly) fail on the first CI run after that commit. Use
`COVERAGE_ALLOW_BASELINE_LOWER=1` to land the correction, then say in the commit why.

**The target is deliberately not literally 100%, and cannot be.** Anyone promising "100%"
here is either lying in CI or about to quietly relax the number. The measured gap, as of
2026-09-28 (`120 test files / 1697 tests`):

| Metric     | Measured               | Gap |
| ---------- | ---------------------- | --- |
| lines      | 4483/5084 = **88.17%** | 601 |
| statements | 5928/6835 = **86.73%** | 907 |
| functions  | 1197/1407 = **85.07%** | 210 |
| branches   | 3573/4400 = **81.2%**  | 827 |

45 of the 119 files are at 100% statements. The 907 uncovered statements decompose as:

- **301 statements in 7 CLI scripts that v8 structurally cannot see** — `check-bundle-size`
  (35), `check-npm-audit` (36), `check-android-versioncode` (57), `coverage-baseline` (17),
  `coverage-ratchet` (41), `rust-coverage-baseline` (43), `rust-coverage-ratchet` (72).
  v8 only instruments the test worker's own V8 runtime, so a **spawned subprocess earns zero
  coverage credit**. These are all thin I/O entry points whose logic lives in a pure module
  that _is_ measured: `scripts/cliGates.test.mjs` really does cover the first three (30
  passing tests) and the report still says 0%, and `scripts/rustCoverageCheck.mjs` is at
  **96.9%** because `rustCoverageCheck.test.mjs` imports it. Treat "0% in a report" as
  _"not measurable here"_, never as _"untested"_, for anything a test spawns. See
  `scripts/AGENTS.md`.
- **553 lines never measured at all**, by `coverage.exclude`: `src/main.tsx` (49, the
  `createRoot` entry point), `src/testFixtures/aegisMock.ts` (503, a mock), and
  `src/vite-env.d.ts` (1). All three are entry-point-or-mock by design.
- **606 statements of real, measurable test debt** spread across 74 of the 119 files,
  concentrated in a handful: `App.tsx` 123, `mobile/MobileApp.tsx` 84, `TabStrip.tsx` 13,
  `SettingsModal.tsx` 2, `ipcClient.ts` 29, `Sidebar.tsx` 1, `mobile/MobileMenuSheet.tsx`
  25, `PrivacyDashboard.tsx` 21. By directory: `src/` 597, `scripts/` 9, `shared/` **0**.
  The file count is _files with at least one uncovered statement_, recomputed from
  `coverage/coverage-summary.json` rather than carried forward: an earlier revision of this
  line said "68 files", which is not what the report yields.

**A percentage can move in the opposite direction from the codebase, so never read the ratio
alone.** Removing split view deleted three fully-covered source files: the percentage went
**up** on all four metrics while the absolute count of covered statements _fell_ from 5674 to 5507. Adding three new `scripts/` files did the reverse: the percentage **fell** on all four
while the covered count _rose_ from 5507 to 5601. The ratchet guards the ratio, because that
is what CI can cheaply compare; the absolute counts in the table above are the honest
companion number, and the two tables in this repo (`coverage-baseline.json` plus this one)
are the reason to read both.

**Branches (81.2%, 827 uncovered) is the weakest metric and where the next effort belongs.**
The Rust side has its own measured numbers and its own structural ceiling — see the
coverage section of `src-tauri/AGENTS.md`.

## Conventions that matter everywhere

- **One IPC chokepoint.** All renderer→core calls go through `src/lib/ipcClient.ts`
  → `invoke('ipc', {channel, payload})` → the single `ipc()` command in
  `src-tauri/src/lib.rs`, which dispatches by `channel`. Channel names live in
  `shared/types.ts` (`IPC` const). Add a channel in three places: `shared/types.ts`,
  the Rust dispatcher, and `ipcClient.ts`.
- **Event names can't contain `.`** — Tauri 2 forbids dots in event names. The Rust
  side translates `.` → `:` when emitting (`emit_event` in `lib.rs`); the JS side
  translates back in `src/lib/tauriInvoke.ts`. Keep the logical names dotted in
  `shared/types.ts`; never emit a raw dotted name.
- **Don't guess — verify.** Per the repo owner's standing instruction, read the
  actual file/config/code before claiming behavior; run commands and report real
  output rather than assuming.
- **Always finish with all platforms being on the same version/level.** A feature or
  fix isn't done when it works on one platform — bring Linux, Windows, macOS, and
  Android to parity (iOS when it exists) before calling it complete. Don't leave a
  capability working on Linux with "Win/Android is a follow-up"; close the gap.
- **Cover every user-facing change with a test before pushing to `main` (required).**
  Tests exist to catch any bug a real user might hit, so they must cover **everything a
  user can do**. Before any `git push` to `main`, cover every user-facing change in the
  push — and verify it:
  - **New command channel** → a unit test in the owning Rust module. If it mutates user
    data, the mutation must be driven somewhere that **actually executes**, not asserted
    only at the IPC boundary. A test that structurally cannot fail proves nothing:
    reintroduce the bug and watch it go red.
  - **New hook** → a `renderHook` test covering its IPC wiring, its timing, and its
    teardown.
  - **New interactive control or user action** → a test that drives the real UI the way a
    user does (click/type/keyboard) and asserts the effect.
  - **Gate:** `npm test` green. Runtime behaviour on real hardware is **not** covered by
    any automated gate here — see gotcha 17 in `src-tauri/AGENTS.md` for the known gaps.

## Status (as of the Tauri migration branch)

Linux desktop is verified on real hardware. Windows desktop is verified on real
hardware (Windows 11): browses and ad-blocks — both the WebView2 network tier
(`adblock_win`) and the injected tier — with no crash, and the CI-built portable
exe behaves identically to a local build. (The shield block-_counter_ is now wired on all three
platforms: Linux via `connect_block_counter`/`resource-load-started`, Windows via the
`WebResourceRequested` network tier in `adblock_win.rs`, and Android via
`shouldInterceptRequest` in `MainActivity.kt`. Each platform's count reflects what
its own ad-block tier sees — content-filter-blocked requests on Linux are cancelled
before the signal fires and are never counted; see gotcha 6 in `src-tauri/AGENTS.md`
for the honest per-platform framing.) Android browses + ad-blocks + is secure
(verified on emulator). macOS compiles + bundles green in CI but is not yet
GUI-runtime-verified. iOS is unstarted (needs macOS + Xcode).

**Privacy & sync subsystems (DONE).** Beyond browse/ad-block/security, the following
are shipped across platforms: **E2E sync** (`sync.rs` pull→merge→push, `sync_auth.rs`
Ed25519 device tokens, `sync_stores.rs` HLC-LWW merge; self-hosted `sync-server/`),
**WebRTC IP-leak defense** (`webrtc_shim.rs` + the `webrtcPolicy` setting, with native
Linux/Windows backstops), the **atomic store-write** path (`jsonstore::write_atomic`),
the **shared crypto** layer (`crypto.rs` — XChaCha20-Poly1305 / HKDF / Argon2id /
zeroize), **Android document-start JS injection** (`MainActivity.kt`
`addDocumentStartJavaScript`), **private/ephemeral mode** (per-tab `private`
flag; desktop content webview uses `WebviewBuilder::incognito(true)` — Linux
`WebContext::new_ephemeral`, Windows `SetIsInPrivateModeEnabled`, macOS
`nonPersistentDataStore`; history/downloads-list/session-persistence all skip private
tabs; closed private tabs are not reopenable; a tab opened from a private tab inherits
privateness; Android is a best-effort weaker tier — `LOAD_NO_CACHE` + 3rd-party-cookies
refused + cache/history cleared on close, but first-party cookies linger in Android's
process-global jar after close, which is documented and accepted). Affordance: **New
private tab** button in `TabStrip` + `Ctrl+Shift+N` (desktop) + mobile tab switcher.
Tests cover the button + the keyboard shortcut. The "a private navigation leaves no
history row" assertion is **not** automated — proving it needs a real webview, and
`history::record`'s private-tab skip is covered by `history.rs`'s unit tests instead. Runtime
verify: Linux live GUI and Win/macOS GUI **PENDING** user sessions; Android device verify **PENDING**.
The **OS-keychain anchor** is desktop-done / Android hardware-anchored — **sub-project
J DONE.** Android now PREFERS StrongBox (hardware Secure Element where the device has
`FEATURE_STRONGBOX_KEYSTORE`, graceful TEE fallback otherwise); the seed-at-rest
contract (Keychain → Passphrase → None) holds on all tiers. Honest framing:
StrongBox vs. TEE is device-dependent (emulators + most phones = TEE; SE-capable
devices = StrongBox) — this is a documented hardware-tier fact, not a parity gap.
Desktop uses `keyring` (Secret Service / Credential Manager / Keychain).
Passphrase-wrapped file is the fallback when no keychain is available. On-device
wrap/unwrap hardware verify is **PENDING** user (phone session). **Anti-fingerprinting / farbling**
(`farble.rs`; sub-project L): opt-in (default `off`), three levels (`off` / `standard` /
`strict`). `standard` perturbs canvas (`getImageData`/`toDataURL`/`toBlob`), audio
(`getFloatFrequencyData`/`getChannelData`), and navigator/UA-CH
(`hardwareConcurrency`/`deviceMemory`/`userAgentData.brands` kept consistent with the
Chrome-148 UA). `strict` adds WebGL (`getParameter` UNMASKED\_\*/`readPixels`/
`getSupportedExtensions`/`getShaderPrecisionFormat`). Shipped on all four platforms:
desktop via `adblock_inject::script` document-start (same injection path as the WebRTC
shim), Android via `NativeFarble` JNI getter + `MainActivity.createTabWebView`
registration. Per-site fp-allowlist (`fp-allowlist` store — **local-only, it is NOT in
`sync_stores::SYNCABLE`**, so a restore from backup is the only way to move it;
`fingerprint.*` IPC
channels, `useFingerprint` hook + SecurityTab UI) — on **all four** platforms: Android's
JNI getter takes the tab's content host and checks the `ANDROID_FP_ALLOWLIST`
process-global that `farble::seed_from_disk` mirrors from `FarbleState`, so an allowlisted
host gets no shim there either. (This doc previously called Android a parity gap; the code
had shipped it.) Session salt = CSPRNG `OnceLock<[u8;32]>`, NEVER
persisted; page sees only `public_seed = HKDF-SHA256(salt)` (one-way — not a
super-cookie). Seed is baked INSIDE the IIFE closure, not a top-level `var`/`window.*`
(a top-level var leaks to `window` = cross-site super-cookie; shim runtime tests run
in true global scope via indirect eval to catch this). Per-spawn: level/allowlist apply
to newly created/reloaded tabs only. Honest limits: a same-world JS shim is detectable
(default-off for this reason); on WebKit the Chrome-148 UA already lies about the engine;
per-frame-origin seeding (not Brave's per-top-eTLD+1); Android has no fp-allowlist (v1).
`vitest src/lib/farbleShim.test.ts` is authoritative for shim runtime behavior and passes
(22 tests; the tree has 1205 TS tests in 112 files in total, verified on vitest
4.1.9 and 4.1.11 — run `npm test` for the full count). Live farble-a-real-page verify + Android device verify + Win/macOS GUI verify
are **PENDING** user. **Content-webview Proxy** (`proxy.rs`; sub-project M): routes
browsed pages through a user-configured HTTP or SOCKS5 proxy. **This is a Proxy, not a
VPN** — it covers the content webview only (not the OS, not other apps, not the chrome's
own updater/filter-list fetches). Residual leaks remain: WebRTC is mitigated by the
WebRTC IP-leak fix (shipped), but DNS/QUIC/UDP egress is outside the proxy path. Use
for light geo/region testing or pairing an external proxy — not anonymity. Shipped
`proxy.*` IPC (`proxy.getState` / `proxy.setConfig` / `proxy.clear` /
`proxy.testConnection`), `ProxySettingsTab` + `useProxy` hook, and component tests for
the tab's controls. The set→assert→restore round-trip is **not** automated:
`proxy.setConfig`/`clear` are destructive to a live config, so `proxy.rs`'s unit tests
cover the config validation instead. Per-platform parity matrix:

- **Linux** — live proxy via WebKitGTK `WebsiteDataManagerExt::set_network_proxy_settings`
  (`NetworkProxyMode::Custom` / `Default`). Per-webview fan-out + spawn-inherit. Egress
  verify **PENDING** user (route traffic through a real proxy log).
- **Android** — process-global proxy via `androidx.webkit ProxyController.setProxyOverride`
  / `clearProxyOverride` (feature-checked; `NativeProxy.kt` JNI → `proxy.rs`
  `note_config`). Covers both the chrome and content WebViews (process-global — a parity
  difference vs. desktop content-only). The chrome (`tauri.localhost` / `127.0.0.1` /
  `localhost`) is excluded via bypass rules so the UI is not proxied. Device egress verify
  **PENDING** user.
- **Windows** — **runtime egress VERIFIED on real Windows 11 (2026-06-24)**: a content
  tab routed real `CONNECT` traffic through a local logging proxy. Proxy applied at spawn
  time via `--proxy-server` / `--proxy-bypass-list` in `additional_browser_args`.
  **Spawn-time only**: toggling the proxy applies to new/reloaded tabs; already-open tabs
  are unaffected (reload to apply). The `apply` call is a deliberate no-op on Windows
  (WebView2 browser args are immutable after creation). NOTE: because content webviews
  carry these args, each distinct args set lives in its OWN WebView2 user-data-folder
  (`EBWebView-content-<hash>`) — required to avoid a blank-page failure; see
  `src-tauri/AGENTS.md` gotcha 23.
- **macOS** — NOT implemented. Direct connection. `WKWebsiteDataStore.proxyConfigurations`
  (macOS 14+) requires raw `msg_send!` / hand-rolled `nw_proxy_config_*` Network.framework
  bindings that cannot be compiled or verified from Linux (objc2 needs a macOS toolchain).
  The implementation guide for this was deleted in commit 58d2c4b and is NOT
  recoverable, so the macOS tier has to be re-derived from scratch. macOS builds and runs;
  proxy is simply absent.

## Cleanup After Implementation

- **Clean up temporary files:** After completing implementation tasks, remove any temporary planning files, notes, or information gathering files created during the process. This includes:
  - TODO lists, task files, or planning documents created in temporary locations
  - Information gathering notes or research files
  - Any draft or prototype files not intended for the final codebase
  - Keep the repository clean by removing these artifacts before pushing changes

**Remaining roadmap features:** password-vault autofill (Phase B), anti-fingerprinting
runtime verifies, and content-webview proxy macOS tier. The roadmap that tracked these was
deleted in commit 58d2c4b; `CHANGELOG.md` and the status sections of the per-folder
`AGENTS.md` files are the current record of what is and is not done.
