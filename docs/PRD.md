# Aegis — Product Requirements Document

**Version:** 1.0
**Date:** 2026-07-26
**Audience:** Internal Engineering Team
**Status:** Active

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Architecture](#2-architecture)
3. [Feature Inventory](#3-feature-inventory)
4. [Platform Matrix](#4-platform-matrix)
5. [Security Model](#5-security-model)
6. [Known Limitations & Technical Debt](#6-known-limitations--technical-debt)
7. [Roadmap](#7-roadmap)
8. [Build, CI & Release](#8-build-ci--release)
9. [Open Questions & Risks](#9-open-questions--risks)

---

## 1. Executive Summary

**Aegis** is a cross-platform, privacy-first browser shell built on **Tauri 2** (Rust core) with a **React 19 + TypeScript** UI. It targets **Linux, Windows, macOS, and Android** (iOS is deferred to a future, macOS/Xcode-gated tier).

### What it is

Aegis is not a browser engine — it wraps the platform's native WebView (WebKitGTK on Linux, WebView2 on Windows, WKWebView on macOS, Android WebView) and adds a layer of privacy, security, and ad-blocking features that the native engines don't provide out of the box.

### Differentiators

- **Multi-tier ad-blocking:** Brave's `adblock` engine (EasyList + EasyPrivacy + Peter Lowe's + abuse-TLDs) layered with platform-native content filters (Linux WebKit content filters, Windows `WebResourceRequested`, Android `shouldInterceptRequest`) and injected JS blocking (fetch/XHR/cosmetic on Windows/macOS).
- **Anti-fingerprinting (farbling):** opt-in canvas/audio/WebGL/navigator noise injection with per-site allowlist and three tiers (`off`/`standard`/`strict`).
- **Encrypted vault:** XChaCha20-Poly1305 credential manager with Argon2id KDF, OS-keychain anchoring, and per-record AAD binding.
- **E2E sync:** self-hosted sync server (Rust/axum), Ed25519 device tokens, HLC last-writer-wins merge, opaque ciphertext only.
- **WebRTC IP-leak defense:** ICE candidate filtering (local/private) with TURN preservation, plus native backstops.
- **Content-webview proxy:** HTTP/SOCKS5 routing with per-platform apply mechanisms.
- **Private/ephemeral tabs:** desktop-native incognito partitions, Android best-effort tier.
- **Multi-tab with idle sweep:** background tab memory management, session persistence, closed-tab recovery.

### Current Maturity

| Aspect          | Status                                                                                   |
| --------------- | ---------------------------------------------------------------------------------------- |
| Linux desktop   | **Verified on real hardware.** Full feature parity.                                      |
| Windows desktop | **Verified on real Windows 11.** Browses, ad-blocks, proxies. WebView2 COM layer proven. |
| macOS desktop   | **Compiles + bundles green in CI.** GUI runtime not yet verified on device.              |
| Android         | **Verified on emulator.** Browses, ad-blocks, secure. Device verification pending.       |
| Test suite      | **1,361 tests** (313 Rust + 1,048 JS/TS across 107 test files). All green.               |
| Autopilot       | **Live test harness** drives every feature through the real Rust core on Linux.          |

### Version

`0.1.0` — pre-release. No public auto-update feed active yet (dormant until `v*` tag is pushed).

---

## 2. Architecture

### 2.1 Dual-WebView Model

```
┌──────────────────────────── Tauri window ────────────────────────────┐
│  CHROME webview  = React UI (toolbar, sidebar, modals, settings)     │
│  CONTENT webview = the page the user is browsing (second webview)    │
└───────────────────────────────────────────────────────────────────────┘
        ▲  invoke('ipc', {channel, payload})   │  events (nav.state, …)
        │  ───────────────────────────────────▶ │ ◀───────────────────────
   src/lib/ipcClient.ts                      src-tauri/src/lib.rs  ipc()
```

The chrome and content webviews are **isolated by design**: browsed pages have no access to the IPC surface. The chrome communicates with the Rust core through a single `ipc(channel, payload)` command dispatcher.

### 2.2 IPC Contract

All renderer→core calls go through one chokepoint:

| Layer      | File                     | Role                                                                    |
| ---------- | ------------------------ | ----------------------------------------------------------------------- |
| Contract   | `shared/types.ts`        | Channel names (`IPC` const), payload interfaces, `AegisApi` type        |
| Transport  | `src/lib/tauriInvoke.ts` | `call(channel, payload)` + `on(event, cb)` with `.`→`:` event rewrite   |
| Client     | `src/lib/ipcClient.ts`   | Typed `aegis` object consumed by React hooks                            |
| Dispatcher | `src-tauri/src/lib.rs`   | Single `#[tauri::command] ipc()` that routes by channel name            |
| Events     | `src-tauri/src/lib.rs`   | `emit_event()` translates `.`→`:` (Tauri 2 forbids dots in event names) |

**~190 channel entries** across 30+ feature domains. Adding a channel requires changes in exactly three places: `shared/types.ts`, the Rust dispatcher, and `ipcClient.ts`.

### 2.3 Module Map

**Rust core** (~20,740 lines across 45+ modules):

| Module              | Lines | Purpose                                           |
| ------------------- | ----- | ------------------------------------------------- |
| `vault.rs`          | 1,793 | Encrypted credential vault (Phase A)              |
| `tab_registry.rs`   | 1,415 | Pure tab state machine (24 unit tests)            |
| `sync.rs`           | 953   | E2E sync pull→merge→push                          |
| `farble.rs`         | 816   | Anti-fingerprinting shim injection                |
| `tabs.rs`           | 805   | Tauri tab layer (IPC, spawn, close, sweep)        |
| `linux_layout.rs`   | 791   | Linux multi-webview layout (GtkFixed reparenting) |
| `jsonstore.rs`      | 731   | Atomic JSON store (temp→fsync→rename)             |
| `lib.rs`            | 712   | App setup + IPC dispatcher + `emit_event()`       |
| `nav.rs`            | 697   | Content webview creation + navigation callbacks   |
| `subs.rs`           | 640   | Filter subscriptions + fetch                      |
| `proxy.rs`          | 567   | Content-webview proxy (HTTP/SOCKS5)               |
| `settings.rs`       | 526   | Settings persistence                              |
| `sync_keystore.rs`  | 512   | Root-secret-at-rest (keychain/Android keystore)   |
| `redirect_guard.rs` | 509   | Scripted cross-origin redirect blocking           |
| `downloads.rs`      | 494   | Download manager                                  |
| `adblock.rs`        | 475   | Ad-block state machine + shield counters          |
| `history.rs`        | 455   | Browsing history                                  |
| `webrtc_shim.rs`    | 446   | WebRTC IP-leak defense shim                       |
| `places.rs`         | 460   | Favorites + saved items                           |
| `sync_stores.rs`    | 423   | HLC-LWW record merge                              |
| `split.rs`          | 423   | Split view (2-4 side-by-side tabs)                |
| `view.rs`           | 397   | Content webview geometry + fullscreen             |
| `adblock_engine.rs` | 390   | Brave `adblock::Engine` (dedicated thread)        |

**React UI** (~19,640 lines):

| Layer             | Purpose                                                              |
| ----------------- | -------------------------------------------------------------------- |
| `src/components/` | Presentational components + Settings tabs                            |
| `src/hooks/`      | One hook per feature domain (nav, adblock, tabs, vault, proxy, etc.) |
| `src/lib/`        | IPC client, address parsing, theme, layout constants                 |
| `src/autopilot/`  | Dev-only test harness (dead-code-eliminated from production)         |

### 2.4 Key Architectural Decisions

1. **Single IPC chokepoint** — every renderer→core call goes through one `ipc()` command. No bypasses.
2. **Platform-native webviews** — no bundled Chromium. Smaller binary, native feel, but means per-platform adaptation for every webview feature.
3. **`Engine` is `!Send`** — the ad-block engine lives on one dedicated thread; queries cross via mpsc.
4. **One hook per domain** — React state + IPC wiring lives in hooks; components stay presentational.
5. **Dev-only autopilot** — gated behind `import.meta.env.DEV && import.meta.env.VITE_AEGIS_AUTOPILOT`, dead-code-eliminated from production builds.
6. **Per-webview content filters on Linux** — WebKit content filters are per-tab, not global. Filters are cached to disk by hash.

---

## 3. Feature Inventory

### 3.1 Ad-Blocking

| Component                    | Description                                                                                           | Platforms      |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | -------------- |
| **Brave `adblock` engine**   | EasyList + EasyPrivacy + Peter Lowe's + abuse-TLDs. Runs on a dedicated `!Send` thread.               | All            |
| **WebKit content filters**   | Brave→Safari content-blocker JSON converter, chunked ~25k rules/filter, disk-cached by hash. Per-tab. | Linux          |
| **`WebResourceRequested`**   | Full network interception via WebView2 COM. Blocks at the network layer.                              | Windows        |
| **`shouldInterceptRequest`** | Native Kotlin ad-block + malware check on every request.                                              | Android        |
| **Injected JS tier**         | Document-start fetch/XHR/sendBeacon blocking + cosmetic hiding.                                       | Windows, macOS |
| **Pop-under guard**          | Overrides `window.open` to drop cross-origin scripted popups. Injected on every platform.             | All            |
| **Shield badge**             | Per-tab page count + session total. Wired on all three tiers (each counts what its own layer sees).   | All            |
| **Filter subscriptions**     | User-manageable list subscriptions + custom rules. Built-in defaults seeded on first run.             | All            |
| **Allowlist**                | Per-site ad-block allowlist (syncable).                                                               | All            |

### 3.2 Privacy & Security

| Feature                    | Description                                                                                                                                                                                       | Platforms                                                             |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **Anti-fingerprinting**    | Canvas/audio/WebGL/navigator noise injection. Three tiers: `off`/`standard`/`strict`.                                                                                                             | All (Android: all hosts; desktop: per-site allowlist)                 |
| **WebRTC IP-leak defense** | ICE candidate filtering + SDP rewriting + `getStats()` filtering. `public-only` default.                                                                                                          | All (Linux/Windows: shim + native backstop; macOS/Android: shim only) |
| **HTTPS-Only**             | Top-level `http://` → `https://` upgrade with warning interstitial.                                                                                                                               | All                                                                   |
| **MalwareGuard**           | URLhaus host blocklist check on navigations + subresources. Session bypass available.                                                                                                             | All                                                                   |
| **Permissions**            | Site permission prompts (geolocation, camera, etc.) denied by default, remembered per origin.                                                                                                     | All                                                                   |
| **Private tabs**           | Desktop: native incognito partitions (`WebContext::new_ephemeral` / `SetIsInPrivateModeEnabled` / `nonPersistentDataStore`). Android: best-effort `LOAD_NO_CACHE` + cache/history clear on close. | All (Android: weaker tier, documented)                                |

### 3.3 Vault (Password Manager)

| Feature                   | Description                                                                                                            | Platforms    |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------ |
| **Encrypted storage**     | XChaCha20-Poly1305 per-record seal, Argon2id KDF, per-vault random salt.                                               | All          |
| **OS-keychain anchoring** | Desktop: `keyring` crate (Secret Service / Credential Manager / Keychain). Android: hardware keystore (StrongBox/TEE). | All          |
| **CRUD operations**       | Create, unlock, lock, list, add, update, remove, search.                                                               | All          |
| **Vault sync**            | Encrypted records synced via E2E sync server (opaque ciphertext, HLC merge).                                           | All          |
| **Autofill (Phase B)**    | Form detection → badge → fill → save prompt. Not yet implemented.                                                      | Planned: All |

### 3.4 Sync

| Component          | Description                                                                        |
| ------------------ | ---------------------------------------------------------------------------------- |
| **E2E sync**       | Pull→merge→push over reqwest::blocking. Self-hosted `sync-server/` (Rust/axum).    |
| **Device auth**    | Per-device Ed25519 signed access tokens. Account-root signature for registration.  |
| **Record merge**   | Per-uuid HLC last-writer-wins with tombstones. Targeted refetch on `sync.changed`. |
| **Crypto**         | XChaCha20-Poly1305 seal/open, HKDF-SHA20 per-namespace keys, zeroize-on-drop.      |
| **Replay defense** | Per-(device, nonce) pair tracking. Fresh nonce per HTTP request.                   |
| **Quotas**         | Per-request record count, per-field lengths, per-account total records.            |

### 3.5 Tabs & Navigation

| Feature                 | Description                                                                                                       | Platforms                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------- | ----------------------------- |
| **Multi-tab**           | Create, close, activate, reorder, pin, reopen closed. Session-persisted.                                          | All                           |
| **Idle sweep**          | Background tabs discarded after timeout, reloaded on next activation.                                             | Desktop                       |
| **Private tabs**        | Ephemeral partitions. Inherit privateness from opener. Not reopenable after close.                                | All                           |
| **Tab strip**           | Desktop top row with new-tab / new-private-tab buttons.                                                           | Desktop                       |
| **Mobile tab switcher** | Vertical list with search, new tab, close.                                                                        | Android                       |
| **Navigation**          | Back, forward, reload/stop, home. HTTPS-Only upgrade. Malware guard.                                              | All                           |
| **Redirect guard**      | Blocks scripted cross-origin top-frame redirects. Two-phase (NavigationAction + ResponsePolicyDecision on Linux). | All (platform-specific hooks) |
| **URL bar**             | Driven by main-frame-only sources (`on_page_load` + `notify::uri`). Not subframe URLs.                            | All                           |

### 3.6 Find-in-Page

| Platform | Engine                  | Match Count             | Highlight | Active Index           | Case Sensitive      |
| -------- | ----------------------- | ----------------------- | --------- | ---------------------- | ------------------- |
| Linux    | WebKitFindController    | Real (via `found-text`) | Full      | No (reports 1 when >0) | Yes                 |
| Windows  | `ICoreWebView2Find`     | Real                    | Full      | Real                   | Yes                 |
| macOS    | `WKWebView.findString:` | Bool only               | No        | No                     | Yes                 |
| Android  | `WebView.findAllAsync`  | Real                    | Full      | Real (ordinal+1)       | No (API limitation) |

### 3.7 Page Zoom

| Platform | Engine                       | True Page Zoom    | Factor Precision |
| -------- | ---------------------------- | ----------------- | ---------------- |
| Linux    | `WebViewExt::set_zoom_level` | Yes               | Exact            |
| Windows  | `SetZoomFactor`              | Yes               | Exact            |
| macOS    | `WKWebView::setPageZoom`     | Yes               | Exact            |
| Android  | `WebSettings.textZoom`       | Text-only scaling | Rounded to int % |

### 3.8 Proxy

| Platform | Apply Mechanism                          | Scope        | Live Toggle   |
| -------- | ---------------------------------------- | ------------ | ------------- |
| Linux    | `set_network_proxy_settings` per webview | Content only | Yes           |
| Windows  | `--proxy-server` spawn-time arg          | Content only | New tabs only |
| Android  | `ProxyController` process-global         | All WebViews | Yes           |
| macOS    | No-op (not implemented)                  | N/A          | N/A           |

### 3.9 Other Features

| Feature                | Description                                                                               |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| **Favorites**          | Add, update, remove, reorder. Syncable.                                                   |
| **Saved items**        | Read-later list with tags. Add, remove, rename/delete tags, tag union. Syncable.          |
| **History**            | Record, search, remove, clear. Private-tab skip. Syncable.                                |
| **Downloads**          | List, remove, clear, open file, show in folder. Private-tab skip.                         |
| **Settings**           | Tabbed modal with grouped sections. Theme (dark/light/system). Per-feature configuration. |
| **Data export/import** | Bundles all stores + settings for backup/restore.                                         |
| **Element picker**     | CSS selector picker (Linux-only; cross-platform planned).                                 |
| **Auto-update**        | tauri-plugin-updater + GitHub Releases with minisign verification.                        |
| **Onboarding**         | First-run welcome modal with feature overview + search engine picker.                     |
| **Find bar**           | Ctrl+F infobar with match count, prev/next navigation.                                    |
| **Zoom indicator**     | Toolbar widget with popover (zoom out / percent / zoom in / reset).                       |
| **Split view**         | 2-4 tabs side-by-side with drag-to-split and resize handles.                              |

---

## 4. Platform Matrix

### 4.1 Feature Coverage

| Feature                   | Linux | Windows | macOS | Android |
| ------------------------- | :---: | :-----: | :---: | :-----: |
| Browse + render           |  ✅   |   ✅    |  ✅   |   ✅    |
| Ad-block (engine)         |  ✅   |   ✅    |  ✅   |   ✅    |
| Ad-block (content filter) |  ✅   |   N/A   |  N/A  |   N/A   |
| Ad-block (network tier)   |  N/A  |   ✅    |  N/A  |   ✅    |
| Ad-block (injected JS)    |  N/A  |   ✅    |  ✅   |   N/A   |
| Shield badge counter      |  ✅   |   ✅    |  ✅   |   ✅    |
| Anti-fingerprinting       |  ✅   |   ✅    |  ✅   |   ✅    |
| FP per-site allowlist     |  ✅   |   ✅    |  ✅   |   ❌    |
| WebRTC IP-leak defense    |  ✅   |   ✅    |  ✅   |   ✅    |
| HTTPS-Only                |  ✅   |   ✅    |  ✅   |   ✅    |
| MalwareGuard              |  ✅   |   ✅    |  ✅   |   ✅    |
| Private tabs              |  ✅   |   ✅    |  ✅   |   ⚠️    |
| Multi-tab                 |  ✅   |   ✅    |  ✅   |   ✅    |
| Tab idle sweep            |  ✅   |   ✅    |  ✅   |   N/A   |
| Session persistence       |  ✅   |   ✅    |  ✅   |   N/A   |
| Find-in-page (real count) |  ✅   |   ✅    |  ❌   |   ✅    |
| Find-in-page (highlight)  |  ✅   |   ✅    |  ❌   |   ✅    |
| Page zoom (true)          |  ✅   |   ✅    |  ✅   |   ❌    |
| Proxy (live apply)        |  ✅   |   ❌    |  N/A  |   ✅    |
| Proxy (spawn-time)        |  N/A  |   ✅    |  N/A  |   N/A   |
| Vault (encrypted)         |  ✅   |   ✅    |  ✅   |   ✅    |
| Vault (OS-keychain)       |  ✅   |   ✅    |  ✅   |   ✅    |
| E2E sync                  |  ✅   |   ✅    |  ✅   |   ✅    |
| Favorites + Saved         |  ✅   |   ✅    |  ✅   |   ✅    |
| History                   |  ✅   |   ✅    |  ✅   |   ✅    |
| Downloads                 |  ✅   |   ✅    |  ✅   |   ✅    |
| Element picker            |  ✅   |   ❌    |  ❌   |   N/A   |
| Split view                |  ✅   |   ✅    |  ✅   |   N/A   |
| Redirect guard            |  ✅   |   ✅    |  ✅   |   ✅    |

**Legend:** ✅ Full | ⚠️ Weaker tier (documented limit) | ❌ Not implemented / degraded | N/A Not applicable

### 4.2 Honest Per-Platform Notes

- **Linux:** Full feature coverage. WebKit content filters under-count shield badges (blocked requests cancel before the signal fires — real blocking, invisible count). AppImage requires ubuntu-24.04+ (22.04's webkit2gtk has a Skia crash).
- **Windows:** WebView2 COM is unsafe but compile-verified + GUI-runtime-verified on Windows 11. Content webviews need their own user-data-folder (args mismatch = blank page). Proxy is spawn-time only (immutable browser args). Find-in-page requires 2024+ WebView2 Runtime.
- **macOS:** CI-compile-only (objc2 needs macOS toolchain). GUI runtime is sub-project I. Proxy not implemented. Find-in-page is degraded (bool-only `WKFindResult`). All objc2 code is untestable from Linux.
- **Android:** Best-effort private tabs (first-party cookies linger in process-global jar after close). Text-only zoom (not true page zoom). No fp-allowlist. Process-global proxy (covers chrome too, chrome excluded via bypass rules). Case-insensitive find only.

---

## 5. Security Model

### 5.1 Webview Isolation

- Chrome and content webviews are **separate webview instances** with no shared JS context.
- The chrome reaches the Rust core through **one** `ipc(channel, payload)` command.
- Browsed pages have **no access** to the IPC surface.
- Strict **Content-Security-Policy**: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, no inline/remote scripts.

### 5.2 Least Privilege

- Tauri capabilities (`src-tauri/capabilities/default.json`) grant only core events and file dialogs — no filesystem, shell, or arbitrary-command permissions.
- Site permission requests (geolocation, camera, microphone, notifications, pointer-lock) are **denied by default** and prompted on first use.

### 5.3 Cryptography

| Operation                   | Algorithm          | Parameters                                                 |
| --------------------------- | ------------------ | ---------------------------------------------------------- |
| Vault record seal           | XChaCha20-Poly1305 | 24-byte nonce, AAD = `ns\|uuid\|updatedAt`                 |
| Vault key derivation        | Argon2id           | OWASP params, per-vault 32-byte random salt                |
| Sync namespace keys         | HKDF-SHA256        | Per-namespace derived keys                                 |
| Sync device auth            | Ed25519            | Per-device signed tokens                                   |
| Farble seed                 | HKDF-SHA256        | Session salt (CSPRNG, never persisted), one-way derivation |
| Farble per-origin sub-seeds | SHA-256            | `SHA-256(seed \|\| origin)` — derived inside the shim      |

- All sensitive material uses `Zeroizing` / `ZeroizeOnDrop`.
- Session salt is a `OnceLock<[u8;32]>` — initialized once, never persisted, never in any store.
- `data.export` does NOT carry the salt (it can't — `OnceLock` is never in any store).

### 5.4 Sync Security

- Server stores **opaque ciphertext only** — never holds encryption keys, never decrypts.
- Device registration requires an **account-root signature** (only recovery phrase holder can register).
- **Replay defense:** per-(device, nonce) tracking. Fresh nonce per HTTP request.
- **Quotas:** per-request record count, per-field lengths, per-account total records.

### 5.5 Vault Security

- Decrypted records are **never held in React state** between operations.
- `vault.state` event carries only `{exists, unlocked, count, undecryptable}` — no credential data.
- Master password inputs are `type="password"` with appropriate `autoComplete` values.
- Record passwords are masked by default; revealed only on explicit per-row click.
- Lock wipes the DEK via `Zeroizing` on drop.

### 5.6 Supply Chain

- JavaScript dependencies gated by `npm audit` in CI (high/critical block merge unless explicitly allowlisted).
- Rust dependencies pinned via `Cargo.lock`. Advisory `cargo audit` in CI.
- Dependabot tracks npm + github-actions + cargo weekly.

---

## 6. Known Limitations & Technical Debt

### 6.1 Platform-Specific Limitations

| Limitation                  | Platform | Impact                                        | Fix Path                                                                                                                   |
| --------------------------- | -------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| macOS proxy not implemented | macOS    | No proxy support                              | Requires `WKWebsiteDataStore.proxyConfigurations` + Network.framework FFI bindings (macOS 14+). Cannot compile from Linux. |
| macOS find-in-page degraded | macOS    | No real match count, no highlight-all         | JS-shim tier needed. Cannot compile/test from Linux.                                                                       |
| Android fp-allowlist absent | Android  | Farbling applies to all hosts                 | `ANDROID_FP_ALLOWLIST` process-global pattern (Gap 2 in parity spec).                                                      |
| Android text-only zoom      | Android  | Not true page zoom (images/layout unaffected) | `WebSettings.textZoom` is the only API without Android 9+ workarounds.                                                     |
| Android private tab cookies | Android  | First-party cookies linger after close        | Process-global `CookieManager` has no per-WebView partition. Documented and accepted.                                      |
| Element picker Linux-only   | Linux    | No picker on Win/macOS                        | Cross-platform path via `DocumentTitleChanged` (Win) and KVO (macOS).                                                      |
| Linux shield under-counts   | Linux    | Badge count < actual blocked ads              | WebKit content filter cancels before `resource-load-started` fires. Blocking proven by A/B trace, not count.               |
| Proxy spawn-time on Windows | Windows  | Already-open tabs unaffected by proxy change  | WebView2 browser args are immutable after creation.                                                                        |

### 6.2 Architectural Debt

| Item                            | Description                                                                                                                     | Severity                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| `Engine` is `!Send`             | Ad-block engine must stay on one thread; queries cross via mpsc. Limits parallelism.                                            | Low (design choice, not a bug)   |
| Per-spawn injection model       | WebRTC shim, farble shim, and (planned) autofill are evaluated once at webview creation. Toggling settings requires tab reload. | Medium (UX friction)             |
| Android process-global state    | Proxy, cookie jar, and (future) fp-allowlist are process-global, not per-webview. Limits granularity.                           | Medium (platform constraint)     |
| `on_navigation` subframe firing | Linux `decide-policy` fires for subframes; can't drive URL bar from it.                                                         | Low (mitigated by `notify::uri`) |

### 6.3 Testing Gaps

| Gap                          | Description                                                       | Risk                                        |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------- |
| macOS GUI runtime untested   | CI compiles but no device verification                            | Medium (objc2 bindings untested at runtime) |
| Windows GUI partially tested | Proxy egress verified; find/zoom/UI not fully exercised on device | Medium                                      |
| Android device untested      | Emulator verified; real device pending                            | Low (emulator is close to device)           |
| Live farble-a-real-page      | vitest shim tests pass; no live page verification                 | Low (shim is well-tested in jsdom)          |

---

## 7. Roadmap

### Phase 0 — Glass Morphism UI Redesign

**Impact:** High | **Effort:** Medium | **Platforms:** All | **Status:** Not started

Frosted-glass surfaces, layered depth, soft rounded corners, subtle gradients, spring-like transitions. Full visual transformation of the chrome without behavioral changes.

- Spec: `docs/roadmap/phase-0-glass-morphism-spec.md`
- Dependencies: None (can start immediately)

### Phase 1 — Vault Autofill + Sync (Phase B)

**Impact:** High | **Effort:** High | **Platforms:** All | **Status:** Spec + plan exist

Detect login forms, suggest matching credentials, auto-fill on click, save new credentials after submission. Sync vault records across devices via existing E2E sync infrastructure.

- Spec: `docs/superpowers/specs/2026-07-23-vault-autofill-sync-design.md`
- Plan: `docs/superpowers/plans/2026-07-23-vault-autofill-sync.md`
- Dependencies: Benefits from Phase 0 (visual foundation)

### Phase 2 — Platform Parity Gaps

**Impact:** Medium | **Effort:** Medium | **Platforms:** macOS, Android | **Status:** Not started

Close the cross-platform feature gaps: macOS proxy, Android fp-allowlist, macOS find-in-page enhancement, element picker cross-platform.

- Spec: `docs/roadmap/phase-2-parity-gaps-spec.md`
- Dependencies: None (can parallelize with Phases 0, 4, 5)

### Phase 3 — Workspaces (Named Tab Groups)

**Impact:** High | **Effort:** Medium | **Platforms:** All | **Status:** Partial (React hooks + tests exist; no Rust backend)

Named, color-coded workspace groups with separate tab lists and pinned tabs per workspace. Quick-switch keyboard shortcut. Extends the existing tab registry.

- Spec: `docs/roadmap/phase-3-workspaces-spec.md`
- Dependencies: Benefits from Phase 0
- Current: `useWorkspaces.ts` hook + tests exist; IPC channels defined in `shared/types.ts`; Rust `workspace.rs` not yet created, not wired in `lib.rs`

### Phase 4 — Command Palette Enhancement

**Impact:** Medium-High | **Effort:** Low-Medium | **Platforms:** All | **Status:** Not started

Enrich the existing Ctrl+K palette with fuzzy search across tabs, bookmarks, history, and actions. Categorized results, keyboard navigation, recent actions.

- Spec: `docs/roadmap/phase-4-command-palette-spec.md`
- Dependencies: None (can parallelize)

### Phase 5 — Performance & Polish

**Impact:** Medium | **Effort:** Low-Medium | **Platforms:** All | **Status:** Not started

Lazy-load heavy settings tabs, bundle analysis, startup profiling, React effect cleanup audit, injection pipeline optimization, tab idle sweep tuning.

- Spec: `docs/roadmap/phase-5-performance-spec.md`
- Dependencies: None (can parallelize)

### Phase 6 — Split View

**Impact:** Medium | **Effort:** High | **Platforms:** Linux first, then Windows/macOS | **Status:** Implemented (Rust state machine + IPC + React hooks wired)

Display 2-4 tabs side-by-side. Drag-to-split, keyboard shortcut, resize handles. Extends the existing multi-webview architecture.

- Spec: `docs/roadmap/phase-6-split-view-spec.md`
- Dependencies: Depends on Phase 3 (workspaces + split interaction)
- Current: `split.rs` (423 lines) fully wired in `lib.rs` with managed state; `useSplit.ts` hook + tests exist. IPC channels defined. Runtime verification on real devices pending.

### Execution Order

```
Phase 0 (UI) ──────────────────────────────┐
Phase 2 (Parity) ──────────────────────────┤  ← Start here (parallelizable)
Phase 4 (Command Palette) ─────────────────┘
Phase 5 (Performance) ─────────────────────  ← Anytime
Phase 1 (Vault Autofill) ──────────────────  ← After Phase 0
Phase 3 (Workspaces) ──────────────────────  ← After Phase 0
Phase 6 (Split View) ──────────────────────  ← Last (depends on Phase 3)
```

---

## 8. Build, CI & Release

### 8.1 Development

```bash
npm install              # install JS deps
npm run tauri:dev        # desktop (Vite + Tauri, hot reload)
npm run android:dev      # Android emulator/device
npm test                 # vitest: 1,048 tests (node + jsdom)
cargo test               # Rust: 313 unit tests
```

### 8.2 Release Builds

| Platform    | Command                            | Artifact                       |
| ----------- | ---------------------------------- | ------------------------------ |
| Linux       | `npm run tauri:build`              | `.AppImage` + `.deb`           |
| Windows     | `npm run tauri:build` (on Windows) | NSIS installer                 |
| macOS       | `npm run tauri:build` (on macOS)   | `.app` + `.dmg`                |
| Android     | `npm run android:build`            | Release APK                    |
| All desktop | Push `v*` tag                      | GitHub Release (draft, signed) |

### 8.3 CI Gates (`ci.yml`)

**Two parallel jobs on every PR/push to main:**

| Job      | Steps                                                                                      |
| -------- | ------------------------------------------------------------------------------------------ |
| **web**  | `npm ci` → `typecheck` → `lint` → `format:check` → `npm test` → `npm audit`                |
| **rust** | `cargo fmt --check` → `cargo clippy -D warnings` → `cargo test` → `cargo audit` (advisory) |

### 8.4 Autopilot

```bash
bash scripts/autopilot/run-autopilot.sh   # Linux, needs a display
```

Drives every feature through the real Rust core in an isolated, disposable environment. Screenshots every UI state. A/B trace proves ad-block blocking. Report: `target/autopilot/<ts>/report.html`.

### 8.5 Versioning

Version lives in three files (must be kept in sync):

- `package.json` → `"version"`
- `src-tauri/tauri.conf.json` → `"version"`
- `src-tauri/Cargo.toml` → `[package] version`

---

## 9. Open Questions & Risks

### 9.1 Unresolved Decisions

| Question                                      | Impact | Current State                                                                                                               |
| --------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------- |
| **iOS support timeline**                      | High   | Unstarted. Needs macOS + Xcode toolchain. Low priority vs. other phases.                                                    |
| **Autofill injection model**                  | High   | Spec exists (Phase B). Choice: persistent injected script vs. one-shot eval. Spec recommends persistent (MutationObserver). |
| **Android per-webview proxy**                 | Medium | Process-global proxy is a parity difference vs. desktop. Fix requires Android per-profile API or wry contribution.          |
| **Element picker cross-platform signal path** | Medium | Linux uses `title-changed` signal. Windows/macOS need alternative signal paths (KVO, `DocumentTitleChanged`).               |

### 9.2 Hardware-Gated Items

| Item                          | Requires                                         | Status                            |
| ----------------------------- | ------------------------------------------------ | --------------------------------- |
| macOS GUI runtime verify      | macOS device with Xcode                          | Pending                           |
| Windows find/zoom full verify | Windows 11 device                                | Partially verified                |
| Android device verify         | Physical Android device                          | Emulator verified, device pending |
| StrongBox preference          | Android device with `FEATURE_STRONGBOX_KEYSTORE` | Graceful TEE fallback if absent   |

### 9.3 Risk Register

| Risk                                                  | Likelihood | Impact | Mitigation                                                            |
| ----------------------------------------------------- | ---------- | ------ | --------------------------------------------------------------------- |
| macOS proxy bindings untestable from Linux            | High       | Medium | Deferred to sub-project I; requires Mac developer                     |
| WebView2 Runtime version fragmentation (find-in-page) | Medium     | Low    | Silent no-op on older runtimes; browsing unaffected                   |
| Android process-global cookie leak in private tabs    | Certain    | Low    | Documented, accepted; no fix without platform API                     |
| Ad-block engine `!Send` limits future parallelism     | Low        | Low    | Current mpsc pattern works; refactor only if bottleneck proven        |
| Autopilot can't exercise WebView2 env creation        | High       | Medium | Windows blank-page regression caught by device testing, not autopilot |

---

## Appendix A: IPC Channel Count

~190 channel entries across 30+ feature domains in `shared/types.ts` (812 lines). The `IPC` const is the single source of truth; the Rust dispatcher and `ipcClient.ts` must stay in sync.

## Appendix B: Test Suite

| Suite            | Count         | Framework                                       |
| ---------------- | ------------- | ----------------------------------------------- |
| Rust unit tests  | 313           | `cargo test` (MockRuntime, `with_tmp_app`)      |
| JS/TS tests      | 1,048         | vitest (jsdom + node projects)                  |
| Test files       | 107           | Co-located `*.test.{ts,tsx}` + `*.test.mjs`     |
| Autopilot (live) | Every feature | Real Rust core, disposable profile, screenshots |

## Appendix C: Codebase Size

| Layer                              | Lines       |
| ---------------------------------- | ----------- |
| Rust core (`src-tauri/src/`)       | ~20,740     |
| React UI (`src/`)                  | ~19,640     |
| IPC contract (`shared/types.ts`)   | 812         |
| **Total (excl. tests, generated)** | **~41,000** |
