# Aegis Security Upgrades — closing the Brave gap

**Date:** 2026-06-12
**Status:** Design approved; spec for review.
**Goal:** Implement the buildable security upgrades identified in the Aegis-vs-Brave comparison —
the items that close the gap a *well-configured Electron app* still has against a *Chromium browser
hardened for untrusted content*. The headline is **patch cadence**: a signed-ready auto-update
channel so Aegis tracks Electron's security releases instead of freezing Chromium at build time.
Organizational/infra-only items (a security team, a public bug-bounty, a paid audit, real Google
Safe Browsing, full fingerprint *farbling*) are **out of scope** — they cannot be shipped as code;
lightweight codeable proxies (SECURITY.md, dependency audit CI) are included instead.

---

## 1. Scope (locked with the user)

**In scope = Tier 1 + Tier 2**, delivered as **four independently-shippable phases**, one combined
spec → one phased implementation plan. Seven workstreams:

1. **Signed-ready auto-update channel** (electron-updater + GitHub Releases feed) — *the #1 gap.*
2. **Electron security fuses + ASAR integrity.**
3. **Engine-currency automation** (Dependabot + "Electron behind" CI + exact pin) — *automates the
   already-written, currently-deferred `engine-update-policy.md`.*
4. **HTTPS-Only** (top-level upgrade with interstitial fallback).
5. **Malicious-site protection** (Safe-Browsing-*lite*: list-based block + interstitial).
6. **Fingerprint/leak mitigation (scoped)** — WebRTC IP-leak + Chrome-like UA.
7. **Config hardening + hygiene** — download-dir path validation, SECURITY.md, `npm audit` gate,
   seed `extraResources` bundling.

### Sub-decisions (locked)
- **(A) Signing = "signing-ready, unsigned now."** Build the full publish + auto-update pipeline
  immediately; integrity comes from electron-updater's SHA512 hash verified over the HTTPS feed.
  The Windows sign step is wired but **conditional on a cert secret** (`WIN_CSC_*`) — a no-op until
  a certificate is provisioned, flippable later with no rearchitecting.
- **(B) Update feed = GitHub Releases** (you already push to `origin` + run Actions there; zero
  extra infra).
- **(C) Platforms = Linux AppImage + Windows nsis/portable** (matches current `electron-builder`
  targets). **No macOS → no Apple notarization.**
- **(D) HTTPS-Only depth = top-level navigations only** (Fork 1a). Subresources rely on Chromium's
  default active-mixed-content blocking; a full subresource upgrade would have to contend with the
  adblocker's `session.webRequest` ownership and is deliberately excluded.
- **(E) Malware = silent network block + interstitial now** (Fork 2a) — Phase 3 builds the
  interstitial for HTTPS-Only anyway, so the malware interstitial is cheap reuse.

### Out of scope (Tier 3 — cannot be "implemented")
Full fingerprint farbling; real Google Safe Browsing (Electron strips Chrome's branded services);
dedicated security team / public bug-bounty / paid third-party audit / continuous fuzzing; macOS
target + notarization; full subresource HTTPS upgrade. These are documented as accepted non-goals.

---

## 2. As-built leverage (do not rebuild)

- **Packaging already exists** (correcting the stale `deferred-distribution.md`): `package.json`
  `build` has `electron-builder ^26.15.2` configured — Linux `AppImage`, Windows `nsis`+`portable`,
  `asarUnpack` for `better-sqlite3`/`@ghostery` natives, `appId com.aegis.browser`. **Missing:**
  `electron-updater`, a `publish` provider, any signing, `@electron/fuses`, and seed
  `extraResources`. App `version` is still `0.0.0`; `electron` is the `^42.3.3` range.
- **CI:** `.github/workflows/build-windows.yml` builds on Windows + uploads the `.exe` artifact with
  `electron-builder --win nsis portable --publish never` (triggers on push to `main` + `v*` tags).
- **Adblock engine + refresh:** `@ghostery/adblocker-electron@2.18.0`; `DEFAULT_LIST_URLS`
  (`electron/main/adblock/engine.ts`), `buildEngine()`/`assembleEngineTexts()`, the 24h
  `RefreshScheduler` + `runRefresh()` + `rebuildEngineFromCache()` (`electron/main/index.ts`), and
  the bundled-seed pipeline (`scripts/generate-seed.mjs` → `aegis-copy-seed` vite plugin →
  `out/main/adblock/seed/engine-seed.bin`). The malware engine reuses `ElectronBlocker.parse()` +
  `.match()`; the malware *lists* ride the existing refresh/seed machinery.
- **Navigation gate (HTTPS-Only hooks here):** `viewController.ts` `will-navigate`/`will-redirect`
  gate (`~:115-119`) + `isAllowedNavigationUrl` (`electron/lib/schemes.ts:16-25`,
  `ALLOWED_NAV_SCHEMES` in `shared/types.ts`) + `vc.navigate()` (`~:203-213`).
- **Chrome-overlay architecture (interstitials ride this):** the transparent chrome
  `WebContentsView` z-order swap via `aegis.view.setChromeOverlay` + App's `chromeOverlayActive`
  union. **GOTCHA (must honor):** any new full-window content-covering overlay MUST be added to that
  union or it renders *behind* the content view.
- **IPC plumbing (update + safety channels extend additively):** sender-guarded
  `electron/main/ipc/guard.ts` + `registerGuardedHandlers(chromeWc.id, {...})`
  (`electron/main/index.ts:~298`); contextBridge `aegis.*` surface in
  `electron/preload/chromePreload.ts`. Content preload is an intentional no-op.
- **Repos + additive migrations:** prepared-statement repos + a single `CREATE TABLE IF NOT EXISTS`
  migration block; `PermissionsRepo`/allowlist patterns to mirror for the new HTTP-exceptions store.
- **The policy Phase 2 automates:** `docs/superpowers/engine-update-policy.md` already states "track
  Electron stable, bump on each security release, re-run the dual-ABI gate, **pin Electron exactly**
  (replace the `^` range), record the Chromium version." Phase 2 operationalizes it; Phase 1 does
  the exact pin.

---

## 3. Workstream designs

### 3.1 Phase 1 — Release pipeline & tamper resistance *(the #1 gap)*
- **Versioning:** pin `electron` exact (`"electron": "42.4.0"`, drop `^`) per the policy; bump app
  `version` `0.0.0` → `0.1.0` (electron-updater compares semver; releases must climb from a real
  baseline).
- **Updater:** add `electron-updater`; set `build.publish = { provider: 'github' }`. New
  `electron/main/update/UpdateController.ts`: **guarded to `app.isPackaged`** (no-op in dev), checks
  on launch + every 6h via `autoUpdater.checkForUpdates()`, listens for
  `update-available`/`download-progress`/`update-downloaded`/`error`, and exposes a new guarded IPC
  namespace **`aegis.update.{getState, checkNow, restartToInstall}`** + event **`aegis.update.state`**.
  `restartToInstall` → `autoUpdater.quitAndInstall()`.
- **Renderer:** a small **update toast/banner** in the chrome UI ("Update downloaded — Restart").
  This is in-chrome, **not** full-window, so it does **not** touch the `chromeOverlayActive` union.
- **Fuses + ASAR integrity:** add `@electron/fuses` (dev dep); flip in an electron-builder
  **`afterPack`** hook (`build/afterPack.js`): `RunAsNode=false`, `EnableNodeOptionsEnvironmentVariable
  =false`, `EnableNodeCliInspectArguments=false`, `OnlyLoadAppFromAsar=true`,
  `EnableCookieEncryption=true`, and `EnableEmbeddedAsarIntegrityValidation=true`. **Open
  verification (§7):** ASAR-integrity is solid on Windows/macOS; **Linux support on Electron 42 must
  be confirmed** — enable where supported, document if Linux is integrity-exempt. Existing
  `asarUnpack` natives are loaded as native modules (not app JS), so they coexist with
  `OnlyLoadAppFromAsar`.
- **Seed bundling:** add `build.extraResources` so `engine-seed.bin` ships *inside* the packaged app,
  and have main load it from `process.resourcesPath` in prod (today it's only copied into
  `out/main/...` for dev/test). Without this a packaged/auto-updated build has **no first-run filter
  seed → no ad blocking until the first network refresh** — a real packaging gap.
- **CI:** flip Windows `--publish never` → publish to GitHub Releases on `v*` tags (`GH_TOKEN`); add a
  **Linux AppImage build+publish job** so Linux auto-update has a `latest-linux.yml` feed too; add the
  **signing-ready** conditional Windows sign step — runs only when `WIN_CSC_LINK`/`WIN_CSC_KEY_PASSWORD`
  secrets are present, otherwise skipped (unsigned but SHA512-verified).
- **Verify:** packaged build launches + blocks ads on first run (seed present); `npx @electron/fuses
  read` confirms the flips on the packaged binary; an `autoUpdater` version round-trips against a draft
  GitHub release (CI/manual — see §7); CI publishes both OS feeds on a `v*` tag.

### 3.2 Phase 2 — Supply-chain hygiene & currency *(automates `engine-update-policy.md`)*
- **Dependabot** (`.github/dependabot.yml`): npm ecosystem, grouped minor/patch, weekly; PRs run the
  existing test gate. (`@ghostery/*` stays exact-pinned per the policy — group separately / allow only
  deliberate bumps.)
- **"Electron majors-behind" CI check:** a small script (`scripts/check-electron-current.mjs`) comparing
  the installed Electron major to the latest stable on the npm registry; **warn** when behind but still
  within Electron's 3-major security-support window, and **fail** when it falls outside that window (no
  longer receiving security backports) — the policy's manual step, automated.
- **`npm audit` gate:** a CI step that blocks on high/critical advisories (`npm audit --json`, parsed)
  with an allowlist escape hatch (`.audit-allowlist.json`) for accepted advisories.
- **SECURITY.md:** disclosure contact + enable GitHub private vulnerability reporting — the codeable
  proxy for the Tier-3 org items.

### 3.3 Phase 3 — Network & malicious-site protections
- **Shared interstitial component:** a full-window **warning overlay** (chrome React route) shown over
  the content view via the existing overlay mechanism. **MUST be registered in App's
  `chromeOverlayActive` union** (per the §2 gotcha). Two variants: *HTTPS-failed* and *malicious-site*,
  each with a "Continue anyway (this site)" action. New guarded IPC **`aegis.safety.{getState,
  proceed}`** + event **`aegis.safety.interstitial`**.
- **HTTPS-Only (top-level):** pure helper `upgradeUrl(url, exceptions)` — if `http:` and host ∉
  exceptions → rewrite to `https:`. Applied in **`vc.navigate()`** (address-bar path) and the
  **`will-navigate`/`will-redirect` gate** (preventDefault + load the https form). Deliberately **not**
  `session.webRequest`, to avoid clobbering the adblocker's single session listener (§7 confirm). On
  `did-fail-load` for an upgraded top-level URL → raise the *HTTPS-failed* interstitial; "Continue"
  adds the host to a persisted **`HttpExceptionsRepo`** (`http_exceptions(host TEXT PRIMARY KEY,
  createdAt INTEGER)`, mirroring the allowlist repo pattern) and reloads over http.
- **Malicious-site protection (Safe-Browsing-lite):** a dedicated **`MalwareGuard`** =
  `ElectronBlocker.parse(malwareListTexts)` built from curated malware/phishing lists (URLhaus,
  Phishing Army, etc.), refreshed by the existing 24h scheduler and seeded like the ad lists.
  `isMalicious(url)` via `MalwareGuard.match({ url, type: 'document' })` is queried **at top-level
  navigation time** in the nav gate → preventDefault + raise the *malicious-site* interstitial (instead
  of a blank failed load). The same lists are also fed into the main session-blocking engine so
  malicious **subresources** are network-blocked. The malware category is **on by default and not
  trivially user-disableable** (protected), unlike ad-list subscriptions.
- **Verify (e2e):** an `http://` fixture upgrades to `https://`; a host that only serves http →
  interstitial → "Continue" persists + loads; a fixture bad-host triggers the malicious-site
  interstitial; ad blocking + normal browsing unaffected.

### 3.4 Phase 4 — Fingerprint/leak hardening & config cleanup
- **WebRTC IP-leak:** set the content WC's WebRTC IP policy to stop local-IP leakage
  (`setWebRTCIPHandlingPolicy('default_public_interface_only')` — **exact value confirmed against the
  Electron 42 API in §7**). Applied where the content WC is created (`viewController.ts`).
- **Chrome-like UA:** set a mainstream stable-Chrome User-Agent on the `persist:content` session
  (`session.setUserAgent(...)`) — less fingerprint-distinctive than the default "Electron/Aegis" UA and
  avoids UA-sniffing breakage. Pinned as a constant the engine-bump checklist updates.
- **Download-dir path validation:** harden `resolveDownloadDir`/the settings setter — require an
  absolute, `path.resolve`-normalized directory and reject non-absolute or `..`-bearing inputs
  (fall back to the OS Downloads dir on reject) — closing the one gap flagged in the comparison
  (`electron/main/downloads.ts`). Pure validator, unit-tested.

---

## 4. Config / IPC / data additions (summary)

- **New deps:** `electron-updater` (runtime); `@electron/fuses` (dev).
- **electron-builder (`package.json`):** `publish: github`; `afterPack: build/afterPack.js`;
  `extraResources` for the seed; a `win` signing block driven by `WIN_CSC_*` env (absent today).
- **New IPC (sender-guarded):** `aegis.update.{getState,checkNow,restartToInstall}` + event
  `aegis.update.state`; `aegis.safety.{getState,proceed}` + event `aegis.safety.interstitial`. All via
  `registerGuardedHandlers` + `chromePreload` contextBridge, same as existing namespaces.
- **New main modules:** `update/UpdateController.ts`; `safety/MalwareGuard.ts` + `safety/httpsUpgrade.ts`
  (pure `upgradeUrl`); `build/afterPack.js`; `scripts/check-electron-current.mjs`.
- **New DB (additive):** `http_exceptions` table + `HttpExceptionsRepo`.
- **New renderer:** update toast/banner; the interstitial overlay route (registered in
  `chromeOverlayActive`); a tiny "Security" Settings surface (HTTPS-Only toggle, http-exception list,
  malware-protection status). Settings gains `httpsOnly: boolean` (default `true`).
- **Repo/CI files:** `.github/dependabot.yml`; `SECURITY.md`; edits to `build-windows.yml` + a new
  Linux publish job; `npm audit` + electron-behind steps.
- **No macOS, no notarization, no `webRequest`-based subresource upgrade** (per locked sub-decisions).

---

## 5. Testing strategy (dual-ABI, as established)

- **Unit (Node ABI / jsdom):** pure `upgradeUrl(url, exceptions)`; the download-dir validator; the
  electron-behind comparator; the fuse-config object; `HttpExceptionsRepo` + the `http_exceptions`
  migration; `UpdateController` against a faked `autoUpdater` (events → state → IPC); the new IPC
  builders (fake deps/spies); `MalwareGuard.isMalicious` against a tiny in-memory list; the update
  banner + interstitial + Security settings components.
- **e2e (Electron ABI):** http→https upgrade on a fixture; failed-https interstitial + "Continue"
  persistence + reload; malicious-host fixture → interstitial; ad blocking unaffected; WebRTC policy +
  Chrome UA asserted on the content WC; the packaged build carries the bundled seed (blocks ads on
  first run) and `@electron/fuses read` shows the flips.
- **Auto-update** is **not** fully e2e-able headless (needs a real signed-ish feed). Verified by a CI
  job that publishes a draft release and asserts the updater fetches `latest*.yml` + the SHA512, plus a
  manual two-build round-trip — recorded in §7, not asserted in the unit/e2e gate.
- **Regression:** the full prior gate (`npm test` then `npm run build && npm run test:e2e`, 758 unit +
  62 e2e baseline) stays green at every phase exit.

---

## 6. Success criteria

1. **Phase 1:** a packaged build auto-updates from the GitHub Releases feed (SHA512-verified), blocks
   ads on first run (bundled seed), and `@electron/fuses read` confirms RunAsNode/inspect/NODE_OPTIONS
   off + OnlyLoadAppFromAsar + ASAR integrity (where the OS supports it) + cookie encryption. Electron
   is exact-pinned; signing is wired and flips on when a cert secret is supplied.
2. **Phase 2:** Dependabot opens grouped npm PRs that run the gate; CI **warns** when Electron is behind
   but still security-supported and **fails** when it falls outside Electron's 3-major security-support
   window; `npm audit` gate runs; `SECURITY.md` + private vuln reporting exist.
3. **Phase 3:** top-level `http` navigations upgrade to `https`; an https failure shows an interstitial
   with a remembered per-site "continue to HTTP"; a known-malicious top-level navigation is blocked with
   a warning interstitial and its subresources are network-blocked.
4. **Phase 4:** WebRTC no longer leaks local IPs; the content UA is a mainstream Chrome string; a
   traversal `downloadDir` is rejected.
5. **No regression:** the full dual-ABI gate stays green; the security-audit sign-off matrix is extended
   with the new controls (auto-update integrity, fuses, HTTPS-Only, malware guard, WebRTC/UA).

---

## 7. Risks & open verifications (resolve in the plan / during impl)

- **ASAR integrity on Linux (Electron 42):** confirm support; enable where supported, document if Linux
  is integrity-exempt (the fuse may be Windows/macOS-only on this version).
- **Adblocker `webRequest` ownership:** confirm `@ghostery/adblocker-electron` owns the content
  session's single `onBeforeRequest` listener — the reason HTTPS-Only is done at the nav layer, not via
  `webRequest`. Confirm `ElectronBlocker.match()` signature for the `MalwareGuard` top-level check.
- **WebRTC policy value:** confirm `setWebRTCIPHandlingPolicy` accepts
  `'default_public_interface_only'` on Electron 42 (vs `'disable_non_proxied_udp'`).
- **AppImage auto-update** requires the running AppImage path be writable (standard electron-updater
  constraint) — note in release docs.
- **Auto-update verification** can't run in the headless unit/e2e gate; verified via a draft-release CI
  job + a manual two-build round-trip.
- **Signing stays OFF** until a Windows cert (e.g. Azure Trusted Signing / SSL.com eSigner) is
  provisioned; until then updates are SHA512-over-HTTPS integrity-verified but unsigned (SmartScreen
  "unknown publisher" expected).
