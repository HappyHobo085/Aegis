# Aegis Improvements Program — Master Design & Decomposition

**Date:** 2026-06-23
**Status:** Approved decomposition; per-sub-project implementation plans to follow.
**Owner ask:** "How can you improve this app… do all, plan everything first."

This is a **program-level** design. It decomposes a large, multi-subsystem effort into
13 independently-shippable sub-projects (A–M), sequences them, and defines each one's
scope, dependencies, acceptance criteria, and verification reality. Each sub-project
gets its **own implementation plan** under `docs/superpowers/plans/`; the novel features
also carry a short design section here so their plans have a basis. One approval gate
precedes any code.

---

## 1. How we got here

Three parallel codebase surveys (tech-debt, test/tooling, feature gaps) plus a
roadmap-vs-reality reconciliation pass established the real current state. Two findings
reshaped the plan:

1. **`docs/FEATURE_ROADMAP.md` is stale.** It lists work as "not started" that is in
   fact shipped. We verified this directly (not from the doc).
2. **Most "big" privacy work already exists.** The genuinely remaining roadmap features
   are only vault, farbling, and proxy, plus one small infra gap.

### 1.1 Corrected current-state baseline (verified, with evidence)

| Roadmap item | Real state | Evidence |
|---|---|---|
| E2E sync engine ("F2b") | **DONE** | `src-tauri/src/sync.rs` network pull→merge→push (`reqwest::blocking`, `GET/POST /v1/records`), background loop; `sync_auth.rs` Ed25519 signed tokens; `sync_stores.rs` HLC-LWW merge; IPC in `shared/types.ts` |
| WebRTC IP-leak defense | **DONE** | `webrtc_shim.rs` (candidate/SDP filtering) + native backstops (Linux `set_enable_webrtc`, Windows `--force-webrtc-ip-handling-policy`) + `webrtcPolicy` toggle. Worker-bypass is a documented hard limit, not a bug |
| S1 atomic store writes | **DONE** | `jsonstore::write_atomic` (temp→`sync_all`→rename→dir-fsync + `.bak`); `settings.rs`, `customfilters.rs`, `data.rs:48`, `subs.rs` all route through it |
| S2 shared crypto | **DONE** | `crypto.rs`: XChaCha20-Poly1305 `seal/open`, HKDF-SHA256, Argon2id (via `sync_keystore`), `zeroize`; deps in `Cargo.toml` |
| S3 OS keychain | **PARTIAL** | Desktop `keyring` done (`sync_keystore.rs`); **Android hardware Keystore JNI path documented but not connected** (passphrase fallback works) → sub-project **J** |
| S4 Android document-start JS injection | **DONE** | `MainActivity.kt` `WebViewCompat.addDocumentStartJavaScript(...)` for ad-block + WebRTC shim, applied per tab |
| Password vault | **ABSENT** | No vault/credential storage → sub-project **K** |
| Anti-fingerprinting / farbling | **ABSENT** | No farble module/salt/noise → sub-project **L** |
| VPN / proxy | **ABSENT** | No proxy config → sub-project **M** |

**Sub-project B** updates `FEATURE_ROADMAP.md` + the CLAUDE.md files to reflect this.

---

## 2. Locked scope decisions

1. **Vault = Phase A only.** Store/manage credentials. **Autofill (Phase B) is out of
   scope** — it deliberately pierces the no-page→core invariant; a separate go/no-go.
2. **"Proxy," not "VPN."** A content-webview-scoped proxy is the honest ceiling for a
   shell. Labeled accordingly; no claim of a whole-device tunnel.
3. **Private mode = full ephemeral**, per-platform partitioned, nothing persisted.
4. **Theme = light palette + `prefers-color-scheme`** (system-follow), keeping dark as a
   choice.
5. **Parity rule honored** (CLAUDE.md: all platforms reach the same level), with explicit
   verification reality (§4).

---

## 3. Sub-project catalog (A–M)

Each entry: scope, primary files, dependencies, acceptance criteria. Stable IDs (A–M);
execution order is in §5.

### A — CI hardening *(enabler)*
- **Scope:** Add gates to `.github/workflows/ci.yml`: `cargo test` (the ~119 Rust tests
  run locally-only today), `tsc --noEmit` (scoped to avoid the known test-file noise),
  `cargo clippy -D warnings` + `cargo fmt --check`, and a new ESLint + Prettier setup
  (no config exists in-repo). Optionally a `cargo-audit` gate for the crypto/keyring
  surface (npm-audit covers JS only).
- **Files:** `.github/workflows/ci.yml`, new `eslint.config.js`, `.prettierrc`,
  `rustfmt.toml`/`clippy` allow-set, `package.json` scripts.
- **Deps:** none. **First**, so all later work is linted + tested in CI.
- **Acceptance:** CI runs all gates green on a clean checkout; a deliberately-broken Rust
  test / type error / lint fails CI locally-reproduced.

### B — Docs/roadmap reconcile *(enabler)*
- **Scope:** Rewrite the stale status in `FEATURE_ROADMAP.md` (sync/WebRTC/S1/S2/S4 done;
  vault/farbling/proxy/J remaining) and align CLAUDE.md status lines.
- **Deps:** none. **Acceptance:** doc matches §1.1; reviewer confirms.

### C — Rust core unit tests
- **Scope:** Unit tests for currently-untested modules: `adblock` (enable/allowlist state
  machine), `safety` (malware match + proceed), `permissions` (grant/revoke/reset),
  `data` (export→import roundtrip — prior live-crash history), `history`, `places`,
  `downloads`, `tabs`, `subs`.
- **Deps:** A (so the tests actually gate in CI).
- **Acceptance:** each module has meaningful `#[test]` coverage; `cargo test` green in CI;
  the `data` roundtrip asserts every store survives export→import.

### D — Find-in-page (Ctrl+F)
- **Scope:** A find bar (chrome UI) + per-engine search: WebKitGTK `WebKitFindController`,
  WebView2 `ICoreWebView2_2` find / `Find` API, WKWebView `find(_:)`/JS fallback, Android
  `WebView.findAllAsync` + `setFindListener`. Match count, next/prev, highlight, Esc/close.
- **Files:** new `FindBar.tsx`, IPC `find.*` channels (shared/types.ts + Rust dispatcher +
  ipcClient.ts), per-platform nav modules; autopilot catalog/screen/interaction entries.
- **Deps:** none. **Acceptance:** type→matches highlight + counted; next/prev cycles; Esc
  closes; works Linux+Android live, Win/mac via CI build + device.

### E — Page zoom (Ctrl +/−/0, Ctrl-scroll)
- **Scope:** Per-tab zoom factor, persisted per-origin (optional v1: session-only).
  WebKitGTK `set_zoom_level`, WebView2 `ZoomFactor`, WKWebView `pageZoom`/magnification,
  Android `setInitialScale`/text-zoom. Toolbar/menu affordance + keyboard.
- **Files:** IPC `zoom.*`, per-platform setters, small UI indicator; autopilot entries.
- **Deps:** none. **Acceptance:** zoom in/out/reset via keyboard + UI; persists across nav
  within a tab; per-platform verified as in D.

### F — Light / system theme
- **Scope:** Add a light palette to the design tokens; honor `prefers-color-scheme`; an
  Appearance setting: System / Dark / Light. Currently hardcoded dark (`index.css`
  `color-scheme: dark`; Appearance only offers accent color).
- **Files:** `index.css` (token layer), `AppearanceTab.tsx`, settings field
  `themeMode`, the mobile shell; autopilot screen states for both themes.
- **Deps:** none (renderer-mostly). **Acceptance:** toggling re-themes chrome instantly;
  system mode follows OS; vitest + live screenshots both themes.

### G — Shield block-counter parity (Windows + Android)
- **Scope:** Wire the block-count badge on Windows + Android (Linux-only today; badge
  shows 0 elsewhere — `adblock.rs:43/61` hooks only the Linux signal). Windows: count in
  the `adblock_win.rs` `WebResourceRequested` handler. Android: count in the
  `shouldInterceptRequest` JNI path → emit to the shield.
- **Files:** `adblock.rs`, `adblock_win.rs`, Android `NativeAdblock`/`MainActivity.kt`,
  the `adblock.blockedCount` event path.
- **Deps:** none. **Acceptance:** badge increments on Windows + Android device runs;
  Linux unchanged; autopilot ad-block trace still PASS.

### H — Private / incognito mode (full ephemeral)
- **Scope:** A private window/tab whose content uses an **ephemeral data partition**
  (cookies, storage, cache discarded on close) and which is **excluded from history,
  sync, and the downloads record**. New-private affordance + a clear visual treatment.
- **Design notes:** WebKitGTK ephemeral `WebKitWebContext`/`WebsiteDataManager`
  (`is_ephemeral`); WebView2 separate user-data folder / `CoreWebView2Profile`
  (`IsInPrivateModeEnabled` where available); WKWebView `WKWebsiteDataStore.nonPersistent()`;
  Android — no native incognito, so a dedicated WebView instance with cookies/cache
  cleared on close + `setAcceptThirdPartyCookies(false)` (best-effort, documented as
  weaker). Private tabs must bypass the history/saved/sync write paths.
- **Files:** tab registry (`tab_registry.rs`/`tabs.rs` — a per-tab `private` flag),
  per-platform webview creation, `history.rs`/sync skip guards, IPC + UI; autopilot
  catalog/screen/interaction (incl. a `verify` that a private tab leaves no history row).
- **Deps:** none (heaviest item). **Acceptance:** a private session leaves no history/
  cookie/storage residue after close (Linux+Android live-verified); normal tabs unchanged.

### I — macOS GUI runtime verification ⚠️ hardware-gated
- **Scope:** Launch the built macOS app and verify browse + ad-block + the new features
  GUI-run. **Cannot be done from this Linux box** (objc2 needs a macOS toolchain; CI
  builds but never launches). Requires the owner's macOS session or a Mac runner.
- **Deps:** ideally after the features land. **Acceptance:** owner confirms GUI run, or it
  stays explicitly "CI-build-verified, GUI-pending."

### J — Android hardware-Keystore anchor (finish S3)
- **Scope:** Connect the Rust JNI path to the existing `AegisKeystore.kt` so the sync/
  vault seed is hardware-anchored on Android (StrongBox/`KeyGenParameterSpec`), keeping
  the passphrase fallback. Small.
- **Files:** `sync_keystore.rs` (android module), `AegisKeystore.kt`.
- **Deps:** none; precedes K's Android leg. **Acceptance:** Android device wraps/unwraps
  via hardware Keystore; fallback still works headless.

### K — Password vault (Phase A)
- **Scope:** New `vault.rs` — credential records sealed with the existing `crypto.rs`
  AEAD, master-password Argon2id KDF, lock/unlock, CRUD, search. IPC (`vault.*`) + a
  manage/add UI + a Settings section. **No autofill.** Reuses S2/S3 (and J on Android).
- **Deps:** A, J (Android). **Acceptance:** create→unlock→add→retrieve→lock roundtrip;
  data encrypted at rest; locked state zeroizes keys; tests + live.

### L — Anti-fingerprinting / farbling
- **Scope:** New `farble.rs` — a per-session, crypto-derived salt; document-start JS that
  adds deterministic per-eTLD+1 noise to canvas, audio, WebGL, and `navigator`/UA-CH
  surfaces. Settings: Off / Standard / Strict + a per-site allowlist. Two reconciled
  shims (WebKit vs Chromium engines). Honest limit: detectable; the WebKit UA already
  lies about the engine.
- **Deps:** A; uses S2 (salt) + S4 (Android injection, done). **Acceptance:** fingerprint
  surfaces differ per-site/session with noise on; a probe page shows perturbed values;
  toggle + allowlist work; live-verified Linux+Android.

### M — Proxy (Tier-1, "Proxy")
- **Scope:** Per-platform proxy application on the content webview(s): WebKitGTK
  `set_network_proxy_settings`, WebView2 `--proxy-server`, Android `ProxyController.
  setProxyOverride`, macOS = a hand-rolled Network.framework binding (CI-only, may slip).
  Settings UI + IPC (`proxy.*`). Labeled "Proxy"; depends on the (done) WebRTC fix so it
  isn't leak-hollow.
- **Deps:** A; WebRTC (done). **Acceptance:** traffic routes via the configured proxy on
  Linux+Android (verified by observed egress); off-state restores direct; macOS CI-built.

---

## 4. Verification reality (applies to every sub-project)

| Platform | What I can do from here | "Done" means |
|---|---|---|
| **Linux** | Full runtime + autopilot + ad-block A/B trace | live-verified |
| **Android** | Emulator/device runtime (per prior sessions) | device-verified |
| **Windows** | CI build only here; runtime = owner's Windows session | CI-built + device-verified by owner |
| **macOS** | CI build only (objc2 needs Mac toolchain) | CI-built; **GUI verify = sub-project I, hardware-gated** |
| **iOS** | Not started; needs macOS + Xcode | out of program scope |

---

## 5. Sequencing (user-visible first)

```
Phase 0 (fast enablers):        A  → B
Phase 1 (user-visible):         D, E, F, G, H        (parallelizable; H heaviest)
Phase 2 (backend hardening):    C
Phase 3 (new privacy features): J → K ,  L ,  M       (J before K's Android leg)
Cross-cutting, hardware-gated:  I  (run once a Mac is available)
```

- **A first** even though invisible: it's a one-time enabler that lints all subsequent
  feature code and is what makes C's new tests gate in CI.
- **User-visible (D/E/F/G/H) before C** per owner direction.
- **C before the XL new features** so we harden the base before piling on `vault.rs`/
  `farble.rs`/`proxy`.
- Within a phase, items are independent and may be built in parallel (separate plans).

---

## 6. Cross-cutting requirements (every feature sub-project)

Per the repo's enforced conventions (CLAUDE.md):

1. **IPC in three places:** a new channel goes in `shared/types.ts` (`IPC` const), the
   Rust `ipc()` dispatcher, and `src/lib/ipcClient.ts`. Event names stay dotted logically
   (translated `.`↔`:` at the boundary).
2. **Autopilot coverage in the same commit (drift-guarded):** new channel → `catalog.ts`
   entry (`channels` + `exercise`, plus `verify` if it mutates user data); new UI screen/
   overlay → `screens.ts` (+ `reach.ts`); new interactive control → an interaction test
   driving the real UI. The coverage drift-guard test fails the build otherwise.
3. **Gate per sub-project:** `npm test` green; for runtime-touching changes, the live
   autopilot `RESULT: … 0 failed` and `ad-block blocking (trace): PASS` on Linux.
4. **Parity before "done":** bring Linux/Windows/macOS/Android to the same level (subject
   to §4's hardware reality) — no "Linux works, the rest is a follow-up."

---

## 7. Deliverables of "plan everything first"

1. This master design doc (committed).
2. One implementation plan per sub-project A–M under
   `docs/superpowers/plans/2026-06-23-<slug>.md` (via the writing-plans process).
3. A single **approval gate** presenting all plans before any implementation begins.

## 8. Out of scope (explicit)

- Vault autofill (Phase B); iOS; a true OS-level VPN (Tier-2); extensions/add-ons;
  DevTools; PDF viewer; reader mode; print — none requested for this program (some are
  candidate future work, recorded here only to bound scope).
