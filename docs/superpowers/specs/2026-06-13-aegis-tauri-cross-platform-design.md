# Aegis — Cross-Platform Rewrite (Tauri 2) Design

**Date:** 2026-06-13
**Status:** PROPOSED (awaiting user review)
**Supersedes direction of:** the Electron-only distribution model. The current Electron app
remains the working product and is **not touched** until the Tauri replacement reaches parity.

## 1. Goal

Turn Aegis into a **fully functional, auto-updating, secure ad-blocking browser that runs on all
devices**: Windows, macOS, Linux, **and** iOS / Android — from one codebase, in a different core
language (Rust), reusing the existing React/TS UI. Personal use now; publishable later (signing
left config-ready, unsigned today).

## 2. Verified constraints (researched 2026-06-13, see Sources)

- **iOS is a hard ceiling.** Apple forces all iOS browsers onto **WKWebView**. Ad-blocking there
  is limited to declarative **`WKContentRuleList`** rules + injected cosmetic CSS/JS. The current
  `@ghostery` request-interception engine (which works because Electron *bundles Chromium*) cannot
  run on iOS. Mobile ad-blocking is therefore a **capped tier**, not desktop parity. This is true
  for *any* cross-platform framework — it is Apple policy, not a tooling gap.
- **Tauri 2 is production-stable** (v2.10.x, Mar 2026) and targets Win/Mac/Linux/iOS/Android from
  one codebase. It uses *system* webviews via `wry`.
- **Brave's ad-block engine is a Rust crate** (`adblock`, a.k.a. adblock-rust): network **and**
  cosmetic filtering, EasyList/EasyPrivacy syntax, mature, production-used. A Rust core is thus an
  *upgrade path* to the same engine Brave ships — not a downgrade from `@ghostery`.
- **Tauri can intercept requests on external content** via `WebviewWindowBuilder::on_web_resource_request`
  and supports **multi-webview** windows (chrome + content split). There are **known rough edges**
  for external-URL interception (e.g. tauri#12740, wry#1087) — burned down explicitly in Phase 1.
- **Toolchain absent on this machine:** no `rustc`/`cargo`, no `webkit2gtk`, no Tauri CLI. Node 22
  present. OS is Nobara/Fedora 43. Phase 0 installs the toolchain (rustup = user-space; webkit libs
  = one `sudo dnf`).

## 3. Target architecture

```
┌───────────────────────────────────────────────────────────────┐
│ Aegis (Tauri 2 app)                                            │
│                                                                │
│  Renderer  ── REUSED ──  src/ (React + TS)                     │
│    • App.tsx, 37 components, 16 hooks, lib/                    │
│    • SINGLE SEAM: src/lib/ipcClient.ts                         │
│        window.aegis.*  ──►  Tauri invoke() + event listeners  │
│                                                                │
│  ── Tauri command/event boundary (serde-typed) ──             │
│                                                                │
│  Core  ── REWRITTEN in Rust ──  src-tauri/                     │
│    • adblock/     → `adblock` crate (network + cosmetic)       │
│    • db/          → `rusqlite` (10 repos)                      │
│    • safety/      → https-upgrade, malware-guard               │
│    • update/      → tauri-plugin-updater                       │
│    • view/        → multi-webview (chrome + content tabs)      │
│    • net/         → on_web_resource_request → adblock match    │
│    • commands/    → #[tauri::command] (replaces 20 ipc mods)   │
│                                                                │
│  Webview layer (per platform):                                │
│    Desktop  → wry (WebKitGTK / WebView2 / WKWebView)          │
│    Android  → System WebView + shouldInterceptRequest         │
│    iOS      → WKWebView + WKContentRuleList + injected JS      │
└───────────────────────────────────────────────────────────────┘
```

### The renderer seam

`src/lib/ipcClient.ts` is the **only** renderer file coupled to Electron. Every hook
(`useNav`, `useAdblock`, `useDownloads`, …) and component talks to it, not to `window.aegis`.
Re-implementing this one module against Tauri's `invoke()` (request/response) and `listen()`
(push events) lets ~4,000 LOC of React UI move with minimal change. The renderer stays buildable
for **both** Electron (current) and Tauri (new) during migration by selecting the client at build
time, so the Electron app keeps working until Tauri reaches parity.

## 4. Old → New subsystem mapping

| Electron (TS) | Tauri (Rust) | Notes |
|---|---|---|
| `adblock/engine.ts`, `controller.ts` (`@ghostery`) | `adblock` crate wrapper | network + cosmetic; cosmetic served via injected CSS/JS |
| `adblock/listManager.ts`, `refreshHelpers.ts`, `seedPath.ts` | Rust list manager + seed | fetch/cache filter lists; ship a pre-parsed seed via Tauri resources |
| `adblock/malwareLists.ts`, `safety/MalwareGuard.ts` | 2nd `adblock`/blocklist matcher | mirrors today's 2nd-engine design |
| `safety/httpsUpgrade.ts`, `SafetyController.ts` | Rust nav gate | HTTPS-Only + interstitial + remembered HTTP exceptions |
| `session.ts`, `userAgent.ts` | wry webview config | Chrome UA, WebRTC IP policy, request hooks |
| `db/*.ts` (10 repos, `better-sqlite3`) | `rusqlite` modules | history, favorites, saved, downloads, settings, permissions, customFilters, subs, httpExceptions, adblock |
| `ipc/*.ts` (20 modules) + `preload/chromePreload.ts` | `#[tauri::command]` fns + events + `capabilities/` | typed boundary; Tauri capabilities = the new lockdown |
| `viewController.ts` (WebContentsView) | Tauri multi-webview | chrome webview + content webview(s) = tabs |
| `update/UpdateController.ts` (`electron-updater`) | `tauri-plugin-updater` | desktop; stores handle mobile |
| `downloads.ts`, `permissions.ts`, `historyRecorder.ts`, `windowOpen.ts` | Rust modules | downloads UX, remembered permissions, history, popup policy |
| `electron-builder` config | Tauri bundler (`tauri.conf.json`) | per-OS installers + updater artifacts |

## 5. Ad-blocking strategy (by webview ENGINE — corrected 2026-06-13)

**Correction:** ad-block capability is set by the webview ENGINE, not desktop-vs-mobile. WebKit
(Linux, macOS, iOS) exposes **no request-interception API for external content** — verified
empirically (a fixture's 5 subresources all fetched, 0 seen by `on_web_resource_request`) and in
wry source (`on_web_resource_request` is wired via `register_uri_scheme` = custom-scheme only).
So WebKit must use **declarative content filters**. Only Chromium-based webviews intercept requests.

| Engine / platforms | Network blocking | Cosmetic | Tier |
|---|---|---|---|
| **Chromium** — Windows (WebView2), Android | `adblock` crate request interception (WebView2 `WebResourceRequested` / Android `shouldInterceptRequest`) | inject CSS + scriptlets | **Full** |
| **WebKit** — Linux (webkit2gtk), macOS + iOS (WKWebView) | filter lists → content-blocker JSON loaded as a WebKit content filter (webkit2gtk `UserContentFilterStore` via **`webkit2gtk-sys` FFI** — the safe binding stubs `add_filter`; `WKContentRuleList` on Apple) | inject CSS (+ best-effort scriptlets) via the user content manager | **Capped** (declarative; Safari-content-blocker class) |

A **converter** (adblock filter syntax → content-blocker JSON) feeds the WebKit tier; the `adblock`
crate feeds the Chromium tier. **User-accepted trade-off (2026-06-13):** capped blocking on
Linux/macOS/iOS, full on Windows/Android — chosen to keep one codebase across all devices.
Feasibility is proven (GNOME Web/Epiphany ad-blocks via webkit2gtk content filters); the work is
the `webkit2gtk-sys` FFI plumbing (async `save` → `add_filter`).

## 6. Auto-update strategy

- **Desktop:** `tauri-plugin-updater` + a GitHub Releases feed (same host as today), gated on a
  `v*` tag via CI. Signing **config-ready** (Tauri's updater requires a signing keypair for the
  update bundle — generated once, public key embedded, private key in CI secret; this is separate
  from OS code-signing, which stays drop-in like the current Windows setup).
- **Mobile:** app stores own updates (Play Store / App Store). For sideloaded Android, an optional
  in-app "new version" check pointing at GitHub Releases. iOS cannot self-update outside the store.

## 7. Security mapping (the 4 hardening phases → Tauri)

| Today | Tauri equivalent |
|---|---|
| Hardened-chrome CSP + sandbox | Tauri **capabilities/permissions** allowlist (deny-by-default IPC), strict CSP in `tauri.conf.json`, `dangerousRemoteDomainIpcAccess` left empty |
| HTTPS-Only + interstitial | Rust nav gate on the content webview |
| MalwareGuard | 2nd Rust blocklist matcher on navigation |
| Fingerprint/leak (Chrome UA, WebRTC `default_public_interface_only`) | wry webview UA + WebRTC policy per platform |
| Download-dir traversal rejection | Rust path validation in the download command |
| Electron fuses / ASAR integrity | Tauri ships a compiled Rust binary (no ASAR); enable updater signature verification + bundle integrity |

## 8. Repository strategy

- **In-place, same repo, on a branch** (`feat/tauri-migration`). Add `src-tauri/`; keep `electron/`
  and `src/` working. Retire `electron/` only after Phase 4 parity is verified.
- The current Electron `main` stays releasable throughout. No force-push, no history rewrite.
- Merge to `main` per-phase via PR once each phase's exit criteria + tests are green.

## 9. Phased decomposition

Each phase is its own spec→plan→implement→verify cycle with explicit, testable exit criteria.

- **Phase 0 — Foundation & scaffold.** Install toolchain (rustup, Tauri CLI, Fedora webkit deps).
  Scaffold `src-tauri/`. Reuse the React renderer via a Tauri-targeted `ipcClient`. App launches,
  shows the chrome UI, and navigates the content webview to an arbitrary URL on **Linux**.
  *Exit:* `npm run tauri:dev` opens Aegis, loads a real site, renderer reused; no ad-blocking yet.

- **Phase 1 — Desktop ad-blocking (GO/NO-GO).** Integrate `adblock` crate; wire
  `on_web_resource_request` → network match; inject cosmetic CSS/scriptlets. Load filter lists +
  ship a seed. **This burns down the core Tauri risk.** *Exit:* a known ad host is blocked and a
  cosmetic rule hides an element on a real page, proven by an automated test. If interception is
  unworkable, escalate (fallback = Approach C, keep Electron desktop).

- **Phase 2 — Feature parity (desktop).** Port the 10 SQLite repos to `rusqlite`; re-wire hooks to
  Tauri commands; tabs/nav, history, favorites, saved, downloads, settings, permissions, custom
  filters, subscriptions, allowlist, element picker. *Exit:* feature checklist matches the Electron
  app; ported unit/e2e suites green.

- **Phase 3 — Security parity (desktop).** Port all four hardening phases (table §7) + Tauri
  capabilities lockdown + strict CSP. *Exit:* security checklist re-verified; HTTPS-Only, malware
  gate, UA/WebRTC, download hardening all proven by tests.

- **Phase 4 — Desktop packaging + auto-update.** Tauri bundler → nsis/msi (Win), dmg/zip (Mac),
  AppImage/deb (Linux). `tauri-plugin-updater` + GitHub Releases. GitHub Actions builds all three
  desktop OSes; signing config-ready. *Exit:* a tagged build publishes installers and a signed
  update round-trips on Linux (Win/Mac via CI artifacts).

- **Phase 5 — Mobile (Android, then iOS).** Tauri mobile targets. Android: adblock via WebView
  interception. iOS: `WKContentRuleList` + cosmetic injection (capped tier). Responsive/touch UI
  pass on the React chrome. Store-based updates. *Exit:* Aegis runs and blocks ads on an Android
  device/emulator; iOS build runs with content-blocker ad-blocking in the simulator.

**The current session starts at Phase 0** and proceeds through Phase 1 (the go/no-go), then
continues phase by phase.

## 10. Risks & mitigations

| Risk | Likelihood | Mitigation |
|---|---|---|
| Tauri external-URL request interception too limited for real ad-blocking | Medium | **Phase 1 is an explicit go/no-go**; fall back to Approach C if it fails |
| Multi-webview browser shell (tabs) immature on some platforms | Medium | Validate on desktop first (Phase 0/2); degrade to single-webview-per-window if needed |
| iOS ad-blocking weaker than expected | High (known) | Set expectation now: capped tier; ship best-effort content rules + cosmetics |
| Rust rewrite is large (~9k LOC core) | High | Phased; reuse the React UI; `adblock`/`rusqlite`/`tauri-plugin-*` cover the heavy lifting |
| Native build per-OS needs CI runners | Medium | Mirror existing GH Actions matrix (Win/Mac/Linux runners already proven for Electron) |

## 11. Testing strategy

- **Rust:** `cargo test` unit tests per module (adblock match, repos, nav gate, path validation).
- **Renderer:** existing Vitest suite stays (it tests components/hooks against a mock client).
- **E2E:** port the Playwright suites to drive the Tauri app (`tauri-driver` / WebDriver) where
  feasible; keep the fixture server. Each phase must leave its slice green before merge.
- **No phase is "done" without running the relevant command and reading real output.**

## 12. Out of scope / deferred

- Full iOS ad-blocking parity (Apple-constrained — capped tier only).
- Paid OS code-signing + Apple notarization (config-ready, unsigned today).
- A web (PWA) target — not requested; Tauri's focus is native.
- Telemetry/stats surfacing — privacy-by-default, as today.

## Sources

- [Tauri 2.0 Stable Release](https://v2.tauri.app/blog/tauri-20/) · [Tauri (Wikipedia)](https://en.wikipedia.org/wiki/Tauri_(software_framework))
- [brave/adblock-rust](https://github.com/brave/adblock-rust) · [`adblock` on crates.io](https://crates.io/crates/adblock) · [Cosmetic Filtering (DeepWiki)](https://deepwiki.com/brave/adblock-rust/3-cosmetic-filtering)
- [WebviewWindowBuilder docs](https://docs.rs/tauri/latest/tauri/webview/struct.WebviewWindowBuilder.html) · [tauri#12740 external-URL interception](https://github.com/tauri-apps/tauri/issues/12740) · [tauri#2975 multiple webviews](https://github.com/tauri-apps/tauri/issues/2975)
- [Apple's Browser Engine Ban Persists (Open Web Advocacy)](https://open-web-advocacy.org/blog/apples-browser-engine-ban-persists-even-under-the-dma/)
- [flutter_inappwebview DNS-level blocking gap (#2712)](https://github.com/pichillilorenzo/flutter_inappwebview/issues/2712)
