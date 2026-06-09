# Aegis — Design Spec, Slice 1 (Phases 0–2: "full ad-free core")

**Date:** 2026-06-09
**Status:** Design approved → spec adversarially self-reviewed (5-lens + critic) and revised → awaiting user review
**Source brief:** `ad-blocking-browser-brief.md` (self-contained product brief for the whole product)
**This spec covers:** the first build slice only — Phases 0, 1, and 2 of the brief.

> **Revision note (post-review):** This revision corrects the `@ghostery/adblocker-electron` integration
> mechanism (verified against engine source v2.18.0), pins an Electron floor, and adds security/resilience
> controls (both permission gates, IPC sender validation, scheme allowlist, download floor, chrome-renderer
> lockdown, content-process crash recovery, first-run engine-readiness gating, content-session storage
> policy) plus operationalized, testable success criteria. See §13 for the changelog vs the first draft.

---

## 1. Purpose & slice boundary

Aegis is a cross-platform desktop web browser that pairs a clean UI shell with always-on,
uBlock-grade ad/tracker blocking, rendering sites directly in a real embedded browser engine
(no proxy). This spec defines **Slice 1**: a sandboxed, branded Electron browser that can
navigate the web like a real browser **and** strip ads/trackers across all three filtering
layers (network + cosmetic + anti-adblock), with the minimal escape-hatch controls needed to
use it safely.

### In scope (Slice 1)
- Sandboxed real-webview browsing via Electron `WebContentsView` (single-view, tab-ready architecture).
- Genuine navigation: Back / Forward / Reload-Stop (toggle) / Home, gated on real engine state.
- **Loading indicator** driven by real start/stop-loading signals.
- Smart address bar (search vs URL vs reload) that always shows the real current URL.
- Native nav/title/history-event sync incl. SPA in-page navigation (`pushState`/`replaceState`/`hashchange`), with a short same-URL title debounce.
- **Layer 1** — network request blocking via a real filter engine (`@ghostery/adblocker-electron`), including `$redirect` resource substitution.
- **Layer 2** — cosmetic DOM hiding (generic + per-host + procedural).
- **Layer 3** — anti-adblock: scriptlet (`##+js`) injection, popunder/`window.open` neutralization, supplementary global stubs.
- Filter-list sourcing: fetch on first run, scheduled 24h refresh (injectable timer), manual "update now", atomic on-disk cache, per-source size cap, **HTTPS-only sources**, cache-fallback on failure, serialized matcher on disk, **bundled seed list** so first run is never zero-blocking.
- **Engine-readiness gating**: no page is navigated with blocking inactive (see §6.5).
- Blocked-count: per-page badge + session total.
- Minimal escape-hatch controls: global ad-block on/off + one-click per-site allowlist (reversible, applied on next navigation).
- Error overlay (retry/home) for failed loads **and content-process crash** recovery; app-level error boundary; session restore (last URL/title).
- **Accessibility plumbing** for the in-scope chrome: focus trap + Escape-to-close + focus-restore for the confirm dialog, `aria-live` toasts, skip-to-content link (port of UW's `useDialog`/`SkipLink` patterns).
- Theming (accent color via CSS custom property; site/app name; home URL); toasts + confirm; first-run welcome hint.

### Security floor pulled forward (not the full Phase-5 feature, just the floor)
- Permission requests **deny-by-default** via **both** `setPermissionRequestHandler` **and** `setPermissionCheckHandler`.
- **Scheme allowlist** on all content navigation (`https`, `http`, `about:blank`; reject `file:`, `javascript:`, top-frame `data:`, custom schemes).
- **`will-download` floor**: cancel by default (no silent drive-by downloads); full downloads UX deferred.
- **Chrome (privileged) renderer lockdown**: deny all `window.open`, allow navigation only to the app bundle.
- Content `WebContentsView` on a **dedicated session partition**, isolated from the chrome session.
- TLS certificate errors **hard-fail** to the error overlay (no click-through); `webSecurity` stays on.

### Deferred to later slices (named for traceability)
- **Phase 3:** favorites bar + freeform tags + tag ops, auto-history timeline panel, manual saved-list, sidebar, local persistence for those stores.
- **Phase 4:** full Settings surface; full ad-block controls UI (list-manager subscribe/unsubscribe, my-filters editor, element picker); per-site *enable/disable overrides* (beyond allowlist); data-clearing UI.
- **Phase 5:** downloads/PDF/media UX, full site-permission prompt UX, custom-search-engine management UI, popup routing options (new-tab disposition), multi-tab, cross-platform packaging + auto-update, security audit sign-off.

### Explicit non-goals (carried from brief §2)
No proxy/MITM; no anti-bot/anti-frame/Cloudflare bypass; no URL-rewriting/subdomain routing/`_px_host`;
no `postMessage` address-bar bridge; no hardcoded site/media allowlist; no admin/observability/host-provisioning UI;
no account/sync at launch (local-only, account-less).

---

## 2. Keystone decisions (locked)

| Decision | Choice | Rationale |
|---|---|---|
| First slice | Phases 0–2 | Network blocking alone leaves ad placeholders and breaks on anti-adblock walls; the engine delivers all three layers in one integration, so 0–2 is the smallest coherent "ads gone by default" slice. |
| Engine / stack | **Electron + Chromium**, **min version 42.x** | Only clean path to uBO-grade blocking `webRequest` (brief §4.1); one consistent interception/permission model cross-OS; `@ghostery/adblocker-electron` binds directly. Floor is 42.x (adblocker uses `session.registerPreloadScript`, introduced in Electron 35; the adblocker's declared `peerDependencies: electron >11` is stale — its own devDependency pins 42.x). |
| Embedding API | **`WebContentsView`** | Electron's recommended modern API; `<webview>` tag is explicitly *not recommended* (architectural churn); `BrowserView` deprecated. |
| View model | **Single-view, tab-ready** | One content view in v1; nav state modeled per-view (`ViewController`) so tabs are additive later (brief §3.2). |
| UI shell | **Rebuilt fresh** | UW used only as UX/visual reference (dark theme, `--accent-color`); no proxy coupling or server/JWT data layer carried over. |
| Filter engine | `@ghostery/adblocker-electron` via `fromLists` | Do **not** extend UW's hand-rolled parser (brief §4.1); `fromLists` gives us source control + provenance vs `fromPrebuiltAdsAndTracking`. |
| Local store | `better-sqlite3` (structured) + on-disk files (engine/list cache, session) | Brief §6; synchronous, fast, in main process; schema laid out so Phase 3 just adds tables. |
| UI framework | React 19 + TypeScript + Vite (**electron-vite**) | Matches UW's stack so the visual reference ports cleanly; strong typing for the IPC contract. |
| Address normalization owner | **Renderer** (`src/lib/addressParse`) | Renderer holds nav state (needed for resubmit→reload); it sends a *resolved* URL. Main re-validates via the scheme allowlist as the authoritative security gate (defense in depth). |

---

## 3. Verified technical foundations (`@ghostery/adblocker-electron`, source-verified)

Verified against engine source v2.18.0 and current Electron docs before committing the architecture.

### 3.1 Engine API
- `ElectronBlocker.fromLists(fetch, urls[, config][, caching])`, `.fromPrebuiltAdsAndTracking(fetch)`, `.parse(text)`.
- `enableBlockingInSession(session)` / `disableBlockingInSession(session)`.
- `serialize()` → `Uint8Array`; `ElectronBlocker.deserialize(buffer)`; built-in caching via the `{ path, read, write }` option.
- `fetch` is supplied as a parameter; we use `cross-fetch` (the documented choice). *(Modern Electron main also exposes a global `fetch`; either works — cross-fetch chosen for parity with the engine's examples.)*

### 3.2 How blocking is actually wired (corrected from first draft)
`enableBlockingInSession(session)` does **all** of the following itself — the app does **not** hand-wire cosmetics:
1. **Network:** registers `session.webRequest.onBeforeRequest` to cancel matched requests, and `onHeadersReceived` to apply `$csp` directives **from filter rules** (this is *adding* CSP from rules, not relaxing the site's CSP).
   - **Main-frame requests are NOT filtered** — `onBeforeRequest` early-returns for `request.isMainFrame()`. Top-level document/popunder/redirect defense is therefore entirely the app's `will-navigate`/`will-redirect`/`setWindowOpenHandler` layer (§6.4), not the engine's.
2. **Cosmetics + scriptlets (only if `config.loadCosmeticFilters === true`, the default):** the engine **registers its own bundled preload** on the session via `session.registerPreloadScript({ type: 'frame', filePath: PRELOAD_PATH })` and an `ipcMain.handle('@ghostery/adblocker/inject-cosmetic-filters', …)`. **The app must not register the ghostery preload itself** (that would double-register). The app registers only its *own* content preload separately (multiple preloads per session are allowed).

### 3.3 The injection path (corrected — this drives the build plan and the "no-flash" claim)
- The bundled preload runs **only in the top frame** (guarded by `window === window.top`) — sub-frames are not covered by this mechanism (upstream subframe scripting is in progress, PR #5104).
- It calls `ipcRenderer.invoke('@ghostery/adblocker/inject-cosmetic-filters', location.href)` once early, then on `DOMContentLoaded` starts a `DOMMonitor` and re-invokes as class/id features appear.
- The **main process** responds by calling, on the content `WebContents`:
  - `event.sender.insertCSS(styles, { cssOrigin: 'user' })` for cosmetic CSS;
  - `event.sender.executeJavaScript(script, true)` for scriptlets — **main world, which bypasses page CSP** (PR #4278; this is why the first draft's "modify CSP via onHeadersReceived to allow scriptlets" line was wrong and has been removed).
- **Consequence for "no flash before paint":** injection involves an async IPC round-trip and a `DOMContentLoaded`-driven `DOMMonitor`, so it is **best-effort, not a hard guarantee**. The base cosmetic stylesheet usually lands fast, but there is an inherent race. §10/§11 treat "no flash" as a measured property, not an assertion.
- **Supplementary anti-adblock stubs** (the `adblock-helper.js`-style floor), *if* measurement shows they add value over uBO's `##+js` scriptlets, are injected via the **same main-world path** (engine custom scriptlet resource, or `webContents.executeJavaScript`) — **never** an isolated-world preload (an isolated-world preload cannot set page globals). Coverage measurement is a §12 open item.

### 3.4 Packaging consequences (verified)
- The engine resolves its preload at runtime: `PRELOAD_PATH = createRequire(import.meta.url).resolve('@ghostery/adblocker-electron-preload')`. A real on-disk file must exist at that resolved path in the packaged app. Therefore `@ghostery/adblocker-electron` **and** `@ghostery/adblocker-electron-preload` must be added to Vite `rollupOptions.external` **and** to `asarUnpack` — the same treatment as `better-sqlite3` (which also needs `electron-rebuild`).
- `better-sqlite3` in Electron: `electron-rebuild` (postinstall) + Vite externalize + `asarUnpack` for production.

### 3.5 Engine behaviors worth stating
- **`$redirect` resources** ride with `fromLists` + the engine's `resources.json`: blocked requests matching `$redirect` rules are served **neutered stubs** rather than merely cancelled — this materially reduces "site breaks when blocked" (brief §4.1 requires `$redirect`; confirm resources load alongside lists).
- `WebContentsView` does **not** clip to the renderer DOM; the main process positions/resizes it under the chrome on window resize/layout change.

---

## 4. Architecture

### 4.1 Process & security model
- **Main process (privileged).** Owns the `BrowserWindow`, the chrome renderer, and one content `WebContentsView`. Hosts: filter engine (`ElectronBlocker` bound to the **content session**), list manager, SQLite + repos, session store, the typed IPC router (**with sender validation**), `setWindowOpenHandler`, `will-navigate`/`will-redirect`/`will-download`/`certificate-error`/`render-process-gone` handlers, and **both** permission handlers. Treats list content and page-origin data as untrusted.
- **Chrome renderer (React shell).** `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`. Renders the chrome; communicates with main **only** via a narrow `contextBridge` API (§5). **Locked down:** its `WebContents` denies all `window.open` and allows navigation only to the app bundle (no remote navigation of the privileged context).
- **Content `WebContentsView` (hostile).** `sandbox:true`, `contextIsolation:true`, `nodeIntegration:false`, `webSecurity:true`. Runs on a **dedicated persistent partition** (`persist:content`), separate from the chrome session. Its session carries: (1) `ElectronBlocker` network blocking; (2) the engine's bundled cosmetics/scriptlets preload (auto-registered by `enableBlockingInSession`); (3) a tiny **app content-preload** (in-page `window.open` return-value stubbing only — see §6.4 division of labor); (4) both permission handlers (deny-by-default); (5) `will-download` (cancel by default); (6) `will-navigate`/`will-redirect` scheme-allowlist gate; (7) `certificate-error` (hard-fail). No host/Node privileges.

**IPC sender validation.** Every privileged `ipcMain.handle` validates `event.senderFrame` is the chrome renderer's top frame and rejects otherwise — closing the confused-deputy path where a compromised content renderer could drive `nav.navigate`, `adblock.setEnabled(false)`, or `settings.set`. The validator lives in `electron/main/ipc/guard.ts` and wraps every handler.

**Content storage policy.** The content partition is **persistent** (`persist:content`) so logins/cookies and session restore survive relaunch — normal-browser behavior. Tradeoff recorded: persistent storage means hostile pages can plant durable cookies/localStorage/service-workers; a "clear browsing data" control is **Phase 4**. (If we later prefer ephemerality, the partition is the single switch.)

```
Chrome renderer ──contextBridge IPC (sender-validated)──► Main process ──controls──► content WebContentsView
   (React UI, locked nav)                                  (engine, lists, db,         (hostile sites; sandbox,
        ▲                                                    permissions, handlers)      dedicated partition)
        └──────── nav.state / nav.failed / nav.crashed / adblock.blockedCount ──────────┘
```

### 4.2 Tab-ready abstraction
Content is addressed through a `ViewController` (id → `WebContentsView` + nav state + per-view blocked count + crash state).
Slice 1 instantiates exactly one. The IPC contract carries a `viewId`. Tabs later = a map of `ViewController`s
+ a tab-strip component; no rewrite of the nav or filtering paths.

### 4.3 Data flow (single navigation)
```
[address bar submit]
  └─ renderer: addressParse(rawInput, settings) → {resolvedUrl | reloadCurrent}   (search/https/full-URL/reload + first scheme check)
  └─ IPC nav.navigate(viewId, resolvedUrl)
       └─ main: will-navigate scheme-allowlist gate (authoritative) → viewController.navigate(url)
  did-start-loading        → nav.state(isLoading:true); reset per-page blocked count
  per outbound (sub)request→ ElectronBlocker matches → cancel (++blockedCount) | $redirect stub | allow
  (top frame, async)       → engine preload ↔ main: insertCSS(user) + executeJavaScript(main world) for cosmetics/scriptlets
  did-navigate /           → nav.state(url,title,canGoBack,canGoForward); write session.json (last URL/title)
  did-navigate-in-page     → nav.state(url) for pushState/replaceState/hashchange (no reload)
  page-title-updated       → nav.state(title) (same-URL debounce)
  did-stop-loading         → nav.state(isLoading:false); adblock.blockedCount(page,session)
  did-fail-load            → nav.failed → error overlay (retry/home)
  certificate-error        → hard-fail → nav.failed → error overlay
  render-process-gone /    → nav.crashed → crash overlay (reload/home)   [content view only]
  unresponsive
```

---

## 5. IPC contract (`shared/types.ts` — single source of truth)

All Chrome→Main handlers are **sender-validated** (§4.1).

**Chrome→Main (invoke/handle):**
- `nav.navigate(viewId, url: string)` — loads a **renderer-resolved** URL (renderer ran `addressParse`); main re-checks the scheme allowlist before loading.
- `nav.back(viewId)` / `nav.forward(viewId)` / `nav.reloadOrStop(viewId)`.
- `nav.home(viewId)` — main resolves the current `homeUrl` from `settingsRepo` at call time and navigates it.
- `nav.getState(viewId)` → current `{ url, title, canGoBack, canGoForward, isLoading, crashed }` (lets freshly-mounted chrome read restored/in-flight state without racing a push event).
- `adblock.setEnabled(enabled: boolean)` — global; **re-applies on next navigation**.
- `adblock.toggleAllowlist(host: string)` → add/remove host; **applies on next navigation**; returns new state.
- `adblock.getState()` → `{ enabled, allowlistedHosts, sessionBlocked }`.
- `lists.updateNow()` → force refresh; returns per-source result + `lastUpdated`.
- `settings.get()` / `settings.set(partial)` (incl. the default search template the renderer's `addressParse` uses).

**Main→Chrome (push events):**
- `nav.state(viewId, { url, title, canGoBack, canGoForward, isLoading, crashed })`.
- `nav.failed(viewId, { errorCode, errorDescription, validatedURL, kind: 'load' | 'cert' })`.
- `nav.crashed(viewId, { reason })` — content render-process-gone/unresponsive.
- `adblock.blockedCount(viewId, { page, session })`.

**Address-bar normalization (`src/lib/addressParse`, renderer, unit-tested):**
- No dot and no scheme → search query via the default engine template (`…?q=%s`, DuckDuckGo default, from settings).
- Host present, no scheme → prepend `https://`.
- Full URL → navigate as-is **iff** scheme ∈ allowlist; otherwise reject (main also re-checks).
- Submitting the currently-loaded URL → `reloadCurrent` (renderer compares against its nav-state `url`).

---

## 6. Filter engine & list management

### 6.1 Default list set (sourced via `fromLists`)
EasyList, EasyPrivacy, uBO filters, uBO privacy, uBO badware, uBO unbreak, uBO quick-fixes,
Peter Lowe's domain list, plus the engine's cosmetic/scriptlet/**`$redirect` resources**. **No app-specific
media/host allowlist** (UW's streaming exemptions must not carry over). All source URLs are **HTTPS-only** (reject `http:`).

### 6.2 Lifecycle
1. **Startup:** if `engine.bin` (serialized matcher) exists and is valid → `ElectronBlocker.deserialize` (no re-parse). Else build `fromLists`, then `serialize()` to disk.
2. **Enable blocking:** `enableBlockingInSession(contentSession)` (this auto-registers the engine's cosmetics/scriptlets preload; the app does not).
3. **Refresh:** scheduled every 24h **via an injectable timer** (so tests drive it with fake timers) + manual `lists.updateNow()`. Each refresh: fetch each source (timeout + **per-source size cap enforced as a streaming/`maxContentLength` limit before buffering**), parse, re-serialize, **atomic temp-write + rename**. On any source failure → keep last-known-good (cache-fallback). Record `lastUpdated`/`etag`/`hash` per source.
4. **Allowlist / global toggle:** allowlisted hosts and the global-off switch suppress blocking for matching navigations, **applied on next navigation** (never mid-load).

### 6.3 Blocked-count
Per-cancelled-(sub)request increment, keyed by `viewId`. Per-page count resets on `did-start-navigation`;
session total monotonically accumulates. Pushed to chrome via `adblock.blockedCount`. (Unit test asserts these exact semantics — §11.)

### 6.4 Anti-adblock & popup/redirect specifics (division of labor)
- **Scriptlets (`##+js`)** from uBO lists are injected by the engine (main world via `executeJavaScript`, top frame).
- **`setWindowOpenHandler` (main, `windowOpen.ts`) is the authoritative new-window gate.** Slice-1 policy: **deny popunders / non-user-initiated new windows**; **route a legitimate user-initiated new-window/`target=_blank` to in-place navigation in the single view, subject to the scheme allowlist**; full popup routing (open-as-new-tab) deferred to Phase 5. *(Deny-all was rejected: it would break legitimate `target=_blank` links the brief §4.3 wants routed in-place. Gesture/disposition detection mechanism is a §12 open item.)*
- **`will-navigate` / `will-redirect` (`viewController.ts`)** enforce the scheme allowlist and block hostile top-frame redirects.
- **App content-preload (`contentPreload.ts`)** only stubs the *in-page* `window.open` return value (so scripts checking `window.open(...)`'s return don't break) — it is **not** the gate; the main handler is.
- The engine does not filter main-frame requests (§3.2), so all top-frame protection lives in the above main-process handlers.

### 6.5 Engine-readiness gating (cold-start protection)
- `deserialize` from `engine.bin` is fast; first-run `fromLists` is a slow, fallible network fetch.
- **No content navigation is processed with blocking inactive.** On boot: if a serialized matcher or bundled **seed list** is available, blocking is enabled before the first navigation. On a true first run with no cache, the app **ships a small bundled seed list** (committed in-repo) so the very first page already has baseline blocking; the full lists then fetch/merge in the background, with a visible "updating filters…" indicator. A first-run network failure leaves the user on the seed list (never zero-blocking).
- Until blocking is ready, `nav.navigate` either waits for readiness or shows a brief "preparing protection…" state (decided in planning; either way navigation is not processed unblocked).

---

## 7. Persistence (Slice 1)

`better-sqlite3` in main (rebuilt for Electron; externalized in Vite). Tables this slice needs:

| Table | Columns (representative) | Notes |
|---|---|---|
| `settings` | `key` PK, `value` (JSON) | siteName, homeUrl, primaryColor, theme toggles, **default search template** (`?q=%s`, DuckDuckGo). A `searchEngines[]` list + selectable default is **seeded-but-not-editable** (placeholder until Phase 4/5 UI). |
| `adblock_config` | singleton row | `enabled` (global), `allowlist` (host[]). `perSiteOverrides` (JSON) and `customFilters` (text) are **Phase-4 placeholders** — present for schema stability, not read/written/honored in Slice 1, and have no Slice-1 IPC. |
| `filter_subscriptions` | `listId` PK, `url`, `enabled`, `lastUpdated`, `etag`, `hash` | Drives fetch/refresh; bundled defaults seeded on first run. |

**On-disk artifacts (app data dir; all via a shared `lib/atomicFile` doing temp-write+rename + crash-safe read), with explicit owners:**
- `engine.bin` (serialized matcher) — owner `adblock/engine.ts`.
- raw list cache — owner `adblock/listManager.ts`.
- `session.json` (last URL/title for restore) — owner `main/session.ts`, written on `did-navigate`, read on boot.

Schema laid out so Phase 3 simply **adds** `favorites` / `history` / `saved_list` tables.

---

## 8. Module structure (isolation-first)

```
aegis/
├─ electron/
│  ├─ main/
│  │  ├─ index.ts              app lifecycle, single-instance, boot order (engine-ready before first nav)
│  │  ├─ window.ts             BrowserWindow + chrome load + CHROME RENDERER LOCKDOWN (deny window.open, app-only nav)
│  │  ├─ viewController.ts     id → WebContentsView + nav state + bounds mgmt + will-navigate/redirect gate + crash state
│  │  ├─ session.ts           session.json read/write (session restore), crash-safe
│  │  ├─ permissions.ts        setPermissionRequestHandler + setPermissionCheckHandler (BOTH deny-by-default)
│  │  ├─ windowOpen.ts         setWindowOpenHandler (gesture-based popup policy, §6.4)
│  │  ├─ downloads.ts          will-download floor (cancel by default)
│  │  ├─ ipc/                  typed handlers per namespace (nav, adblock, lists, settings) + guard.ts (sender validation)
│  │  └─ adblock/
│  │     ├─ engine.ts          ElectronBlocker lifecycle (build/serialize/deserialize/enable) + engine.bin owner
│  │     ├─ listManager.ts     fetch(HTTPS-only)/refresh(injectable timer)/atomic-cache/fallback/size-cap + raw cache owner
│  │     └─ blockedCounter.ts  per-view counters (§6.3 semantics)
│  │  └─ db/
│  │     ├─ sqlite.ts          connection + migrations
│  │     ├─ settingsRepo.ts
│  │     ├─ adblockRepo.ts
│  │     └─ subsRepo.ts
│  ├─ preload/
│  │  ├─ chromePreload.ts      contextBridge API for the React shell
│  │  └─ contentPreload.ts     in-page window.open return-value stub (content session; NOT the gate)
│  └─ lib/
│     └─ atomicFile.ts         temp-write+rename + crash-safe read (shared by engine, listManager, session)
├─ src/ (renderer / React chrome)
│  ├─ App.tsx, main.tsx (ErrorBoundary), index.css (theming custom properties)
│  ├─ components/ AddressBar, NavControls (incl. loading indicator), Toolbar, ErrorOverlay (load+cert+crash),
│  │              BlockedBadge, AdblockButton (toggle + allowlist), WelcomeHint, Toaster (aria-live), SkipLink
│  ├─ hooks/ useNav, useAdblock, useDialog (focus trap + Escape + focus restore — ported pattern)
│  └─ lib/ addressParse, theme, toast, ipcClient
└─ shared/
   └─ types.ts                 IPC contract + data-model types + sender-validation notes (single source of truth)
```

Each unit has one job and a typed interface; `shared/types.ts` is the seam between processes.

---

## 9. Risks & mitigations (verified)

1. **Scriptlet vs strict CSP** — current engine injects scriptlets via main-process `executeJavaScript`, which **bypasses page CSP** (PR #4278), so this is largely handled; residual breakage on exotic pages is accepted. We do **not** ship blanket CSP stripping; `webSecurity` stays `true`. 100% anti-adblock not achievable (brief §7) — accepted.
2. **`WebContentsView` bounds** — no DOM clipping; main positions/resizes on window resize/chrome layout change.
3. **Native modules (`better-sqlite3`) + adblocker preload path** — `electron-rebuild` postinstall; Vite externalize + `asarUnpack` for `better-sqlite3`, `@ghostery/adblocker-electron`, **and** `@ghostery/adblocker-electron-preload` (its path is resolved at runtime).
4. **Hostile-page sandbox** — sandbox + contextIsolation + no nodeIntegration + dedicated partition on content; both permission gates deny-by-default; sender-validated IPC; scheme allowlist; download floor; chrome-renderer lockdown.
5. **Stale Electron = CVE exposure** — pin a current Electron (≥42) in `package.json`; add a **CI dependency-staleness check that fails if Electron is behind the current security release** (the auto-updater itself is Phase 5).
6. **List licensing/attribution** — EasyList/EasyPrivacy/uBO carry CC/GPL-style licenses; record source metadata now; full provenance UI in Phase 4.
7. **Sites that break when blocked** — `$redirect` neutered stubs reduce breakage; per-site allowlist is the one-click escape hatch, present from this slice.
8. **First-run cold start** — bundled seed list + engine-readiness gating (§6.5) ensure the first page is never browsed with zero blocking.
9. **Content-process crash** — `render-process-gone`/`unresponsive` handled with a recovery overlay (§4.3); `did-fail-load` does **not** fire on renderer crashes, so this is a distinct path.

---

## 10. Success criteria for this slice (operationalized; subset of brief §8)

1. **Nav like a browser** (§8.1): Back/Forward/Reload/Stop/Home perform correct actions; `canGoBack`/`canGoForward` flip correctly across a back/forward sequence; the **loading indicator** reflects start/stop-loading; the address bar shows the real URL after every navigation **including** `pushState`/`replaceState`/`hashchange` (all via `did-navigate-in-page`, no full reload); rapid same-URL title events coalesce to one trailing update after the debounce.
2. **Smart address bar** (§8.2): bare term → search; schemeless host → `https://`; full URL → as-is; resubmit current URL → reload.
3. **Ads gone by default** (§8.3): on a pinned local ad-fixture set, network ad/tracker (sub)requests are blocked (`blockedCount > 0`, asserted) and a known ad container (sentinel 300×250) ends up `display:none`/`visibility:hidden`; **no-flash is measured** (see §11) and reported, treated as best-effort per §3.3, not a hard gate.
4. **Anti-adblock pages usable** (§8.4): against a **versioned in-repo fixture set of N detector pages**, **≥ M of N** render the primary content region with the detector-wall selector / "disable your ad blocker" text **absent** and the main content element at non-zero rendered height. M/N target recorded in §11 (encodes the accepted <100%).
5. **Lists update** (§8.5): default lists fetch on first run; **auto-refresh tick fires on the injected timer** (fake-timer test); manual update works; app still functions from cache when offline / on fetch failure; first run with no cache still blocks via the bundled seed list.
6. **Escape-hatch controls** (subset of §8.6): global toggle and per-site allowlist **take effect on the next navigation, not mid-load**; allowlisting a site **restores its ads and makes previously-gated content accessible** on a representative gated fixture.
7. **Resilience** (§8.10): failed load **and** content-process crash each show a recoverable surface (retry/home), not a blank window; a thrown UI error is caught by the error boundary; last session (URL/title) restored on relaunch.
8. **Security posture** (§8.11), as a **config assertion + enumerated probe suite** (no unbounded negatives): the live content `WebContents` reports `{ sandbox:true, contextIsolation:true, nodeIntegration:false, webSecurity:true }`; in the content page's main world `require`/`process`/`module`/`global` are `undefined`; `file://` and `javascript:` navigations are blocked; a hostile page cannot drive any privileged IPC (sender validation); only the documented §5 channels are reachable.
9. **No proxy artifacts** (§8.13): a **source-scan test** finds no `_px_host`, `directHosts`/`clearanceHosts`/`streamExtractHosts`, no `postMessage`-based address-bar bridge, no JWT/`/api/wrapper` layer, no admin/observability components.

*(Brief §8.11's "embedded engine current" is verified by the CI staleness check (§9.5), not a self-satisfying unit assertion.)*

---

## 11. Testing strategy (every time-based behavior driven by injectable clocks)

- **Unit (TDD):**
  - `addressParse` — search/https/full-URL/reload + scheme rejection (§10.2, §10.8).
  - `listManager` — fetch, size-cap (maxContentLength), atomic cache, cache-fallback/offline, **scheduler via fake timers** (one tick per interval; manual `updateNow` doesn't double-fire) (§10.5).
  - `blockedCounter` — increment keyed by viewId; per-page reset on `did-start-navigation`; session total monotonic; payload matches `{page, session}` (§10.3 badge half).
  - settings/adblock/subs repos.
- **Component:** `ErrorBoundary` (child throws → fallback, not blank) and `ErrorOverlay` (load/cert/crash variants render with working retry/home) — UW's `ErrorBoundary.test.tsx`/`ProxyErrorOverlay.test.tsx` are templates; confirm-dialog focus-trap/Escape/focus-restore (a11y).
- **Integration (Electron):**
  - Nav-state correctness incl. SPA `pushState`/`replaceState`/`hashchange` and back/forward enablement; same-URL title debounce (fake timers) (§10.1).
  - Block-on-ad-fixture: `blockedCount>0` + engine logs; cosmetic hide of the sentinel container (§10.3).
  - **No-flash measurement:** on a local fixture with a sentinel ad container, a probe records cosmetic-stylesheet application time vs the first `paint`/FCP `PerformanceObserver` entry (or frame capture via `beginFrameSubscription`) and reports whether the sentinel was ever painted with non-zero area; a **CSP-hostile fixture** asserts the documented behavior holds (§10.3).
  - Anti-adblock fixture set: ≥ M of N usable per §10.4.
  - Toggle timing: blocking on → `blockedCount>0`; `setEnabled(false)` does not reapply mid-load; next navigation → `blockedCount==0`; re-enable → blocking returns next navigation; same pattern for `toggleAllowlist` incl. gated-content access (§10.6).
  - Session restore + offline cache (§10.5/§10.7); **content-process crash** (force `render-process-gone`) → recovery overlay, not blank window (§10.7).
  - **Sandbox suite:** the §10.8 config readback + enumerated main-world probe set + `file://`/`javascript:` block + hostile-page-can't-drive-IPC.
  - **Source-scan** for forbidden proxy tokens (§10.9).
- Dev/test primarily on Linux (developer's box); architecture stays cross-platform — packaging is Phase 5.

---

## 12. Open items to resolve during planning (not blockers)
- Exact electron-vite build wiring for externalizing + asarUnpacking `@ghostery/adblocker-electron(-preload)` and `better-sqlite3`, and verifying the runtime `PRELOAD_PATH` resolves in the packaged app.
- Gesture/disposition detection mechanism for the `setWindowOpenHandler` popunder-vs-legitimate decision (§6.4).
- Whether supplementary anti-adblock stubs add measurable value over uBO `##+js` scriptlets; if so, inject via engine custom scriptlet resource / main-world `executeJavaScript` (not a preload) (§3.3).
- Exact "preparing protection…" vs "wait for readiness" UX during first-run engine build (§6.5).
- Bundled seed-list contents/size and its update/merge with the full lists.

---

## 13. Changelog vs first draft (from the adversarial self-review)
- **Corrected** the cosmetics/scriptlets wiring: engine auto-registers its own preload; injection is main-process `insertCSS` + main-world `executeJavaScript` (bypasses CSP); top-frame-only; async ⇒ "no-flash" is best-effort/measured, not guaranteed.
- **Removed** the inaccurate "modify CSP via onHeadersReceived to allow scriptlets" mitigation; affirmed `webSecurity:true`.
- **Pinned** Electron ≥ 42 (registerPreloadScript needs ≥35; adblocker peer range is stale).
- **Added** packaging: externalize + asarUnpack the adblocker preload package (runtime path resolution).
- **Added security floor:** both permission gates; IPC sender validation; scheme allowlist (content + chrome); `will-download` floor; chrome-renderer nav/window lockdown; dedicated persistent content partition; TLS cert hard-fail.
- **Added resilience:** content-process crash recovery; first-run engine-readiness gating + bundled seed list.
- **Resolved consistency gaps:** address normalization owned by renderer (sends resolved URL; main re-validates); `session.json` owner module; `lib/atomicFile`; `perSiteOverrides`/`customFilters`/`searchEngines[]` marked Phase-4 placeholders; `nav.getState`; popup division of labor; `nav.home` resolves homeUrl from settings.
- **Added completeness:** a11y plumbing; loading indicator; `$redirect` resources; gated-content half of the allowlist criterion.
- **Operationalized** §10/§11: no-flash measurement, sandbox config-assert + probe suite, no-proxy source-scan, anti-adblock M/N fixture ratio, toggle-timing, error/crash surfaces, injectable timers.
- **Reconciled** review false-positives per the critic: gesture-based popup policy (not deny-all); CSP "blocker" downgraded to deleting a stale line; engine-currency via CI check (not a self-satisfying test).
```
