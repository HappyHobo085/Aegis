# Aegis — Functional Requirements Document

**Version:** 1.0
**Date:** 2026-07-26
**Audience:** Internal Engineering Team
**Status:** Active
**Parent:** `docs/PRD.md`

---

## Table of Contents

1. [Overview](#1-overview)
2. [FR-NAV: Navigation](#2-fr-nav-navigation)
3. [FR-TAB: Tabs](#3-fr-tab-tabs)
4. [FR-ADB: Ad-Blocking](#4-fr-adb-ad-blocking)
5. [FR-SEC: Security](#5-fr-sec-security)
6. [FR-PRI: Privacy](#6-fr-pri-privacy)
7. [FR-VLT: Vault](#7-fr-vlt-vault)
8. [FR-SYN: Sync](#8-fr-syn-sync)
9. [FR-CTX: Content Features](#9-fr-ctx-content-features)
10. [FR-DAT: Data](#10-fr-dat-data)
11. [FR-UI: UI / Chrome](#11-fr-ui-ui--chrome)
12. [Cross-Cutting Requirements](#12-cross-cutting-requirements)
13. [Requirement Index](#13-requirement-index)

---

## 1. Overview

### 1.1 Purpose

This document specifies the functional requirements for every user-facing feature in Aegis. Each requirement is uniquely identified, testable, and specifies input/output contracts, acceptance criteria, platform-specific behavior, and edge cases.

### 1.2 Requirement Format

```
FR-{DOMAIN}-{NNN}: {Title}
  Description: What the system MUST do.
  Input: IPC payload / user action.
  Output: Return value / event payload / UI change.
  Acceptance: Testable pass/fail criterion.
  Platforms: Per-platform behavior if different from "all".
  Edge cases: Error conditions, race states, boundary conditions.
  Depends on: Other FRs this requires.
```

### 1.3 Conventions

- **MUST** = mandatory requirement.
- **SHOULD** = recommended but may have documented exceptions.
- **Platform-specific** behavior is listed under "Platforms"; when omitted, the requirement applies to all platforms equally.
- Channel names reference `shared/types.ts` IPC constants.
- Event names use logical dotted form (`nav.state`); transport rewrites `.` → `:`.

---

## 2. FR-NAV: Navigation

### FR-NAV-001: Navigate to URL

- **Description:** The system MUST navigate the active content webview to a user-entered URL. HTTP URLs are upgraded to HTTPS (FR-SEC-001). Non-HTTP/HTTPS schemes are rejected.
- **Input:** `nav.navigate({ url: string })`
- **Output:** `nav.state` event with updated `{ url, title, canGoBack, canGoForward, loading }`.
- **Acceptance:** Entering `example.com` in the address bar navigates to `https://example.com` and emits `nav.state` with `url: "https://example.com/"`.
- **Platforms:** All.
- **Edge cases:**
  - Invalid URL → error returned to chrome, page unchanged.
  - `about:`, `chrome://`, `file://` schemes → rejected.
  - Navigation blocked by ad-block (FR-ADB-001) → page unchanged, `nav.state` with previous URL.
  - Navigation blocked by malware guard (FR-SEC-001) → safety interstitial shown.
  - Navigation blocked by redirect guard (FR-SEC-003) → `redirect.blocked` event emitted.
- **Depends on:** FR-SEC-001 (HTTPS-Only), FR-ADB-001 (ad-block), FR-SEC-002 (malware guard).

### FR-NAV-002: Back Navigation

- **Description:** The system MUST navigate the active content webview to the previous entry in its history stack when the user triggers back navigation.
- **Input:** `nav.back({ viewId? })` or UI back button.
- **Output:** `nav.state` event with `canGoBack`, `canGoForward` updated.
- **Acceptance:** After navigating A→B, calling `nav.back()` returns to A. `canGoBack` becomes `false` at the start of history.
- **Platforms:** All.
- **Edge cases:**
  - No history → no-op.
  - Private tab → history entry was not recorded (FR-TAB-006); back still works within the webview's session.
- **Depends on:** FR-TAB-001 (tabs exist).

### FR-NAV-003: Forward Navigation

- **Description:** The system MUST navigate the active content webview to the next entry in its history stack.
- **Input:** `nav.forward({ viewId? })` or UI forward button.
- **Output:** `nav.state` event.
- **Acceptance:** After A→B→back, calling `nav.forward()` returns to B. `canGoForward` becomes `false` at end of history.
- **Platforms:** All.
- **Edge cases:** Same as FR-NAV-002.

### FR-NAV-004: Reload / Stop

- **Description:** The system MUST reload the current page when loading, or stop the current load when idle.
- **Input:** `nav.reloadOrStop({ viewId? })` or UI reload/stop button.
- **Output:** `nav.state` event with `loading` toggled.
- **Acceptance:** Clicking reload during a load stops it; clicking reload while idle reloads the page.
- **Platforms:** All.
- **Edge cases:**
  - Reload on `about:blank` → no-op.
  - Reload triggers ad-block re-evaluation (FR-ADB-001).

### FR-NAV-005: Home Navigation

- **Description:** The system MUST navigate to the configured home page (default: `about:blank`).
- **Input:** `nav.home()` or UI home button.
- **Output:** `nav.state` event with URL set to home.
- **Acceptance:** Clicking home navigates to `about:blank` (or configured home URL).
- **Platforms:** All.

### FR-NAV-006: Address Bar URL Tracking

- **Description:** The system MUST update the address bar URL on main-frame navigations only. Subframe loads MUST NOT update the address bar.
- **Input:** Page navigation events (main-frame `on_page_load` + `notify::uri`).
- **Output:** Address bar reflects the main-frame URL.
- **Acceptance:** Navigating to a page with cross-origin iframes shows only the top-frame URL in the address bar. Embedded ad/player URLs do not appear.
- **Platforms:**
  - Linux: `notify::uri` via `connect_url_tracker` (catches same-document `pushState`/`replaceState` + hash).
  - Windows: `SourceChanged` event on `ICoreWebView2`.
  - macOS: KVO on `URL`.
  - Android: `onPageStarted` + `doUpdateVisitedHistory`.
- **Edge cases:**
  - SPA `pushState`/`replaceState` → address bar updates (Linux via `notify::uri`; Android via `doUpdateVisitedHistory`).
  - `hash` navigation → address bar updates.
  - Subframe navigation → address bar unchanged.

### FR-NAV-007: Navigation State Events

- **Description:** The system MUST emit `nav.state` events containing `{ viewId, url, title, canGoBack, canGoForward, loading }` on every navigation state change.
- **Input:** Any navigation event (page load, back, forward, reload).
- **Output:** `nav.state` event to chrome.
- **Acceptance:** Every user-initiated navigation produces exactly one `nav.state` event with correct fields.
- **Platforms:** All.
- **Edge cases:**
  - Rapid navigations → events may be deduped within `DEDUP_WINDOW_MS` (300ms).
  - Private tab → `nav.state` still emitted (chrome needs it for UI), but history not recorded.

### FR-NAV-008: Failed Navigation

- **Description:** The system MUST emit `nav.failed` when a navigation fails (DNS error, connection refused, timeout).
- **Input:** Navigation failure from webview engine.
- **Output:** `nav.failed` event with `{ viewId, url, error }`.
- **Acceptance:** Navigating to `https://nonexistent.invalid` emits `nav.failed`.
- **Platforms:** All.

### FR-NAV-009: Crashed Navigation

- **Description:** The system MUST emit `nav.crashed` when a content webview process crashes.
- **Input:** Webview crash signal.
- **Output:** `nav.crashed` event with `{ viewId }`.
- **Acceptance:** If the content webview crashes, `nav.crashed` is emitted and the tab shows a crash overlay.
- **Platforms:** All.

---

## 3. FR-TAB: Tabs

### FR-TAB-001: Create Tab

- **Description:** The system MUST create a new tab with an optional URL and optional background flag.
- **Input:** `tabs.create({ url?, background? })`
- **Output:** `tabs.state` event with updated tab list and active tab.
- **Acceptance:** Creating a tab adds it to the tab list, spawns a content webview, and switches to it (unless `background: true`).
- **Platforms:** All.
- **Edge cases:**
  - `background: true` → tab created but active tab unchanged.
  - `url` omitted → navigates to home (`about:blank`).
  - Max tabs → no hard limit, but idle sweep (FR-TAB-007) manages memory.

### FR-TAB-002: Close Tab

- **Description:** The system MUST close a tab, destroy its content webview, and activate the nearest remaining tab.
- **Input:** `tabs.close({ tabId })`
- **Output:** `tabs.state` event with tab removed.
- **Acceptance:** Closing the active tab activates the tab to its left (or right if last). Closing a background tab removes it without changing the active tab.
- **Platforms:** All.
- **Edge cases:**
  - Last tab closed → new tab created automatically.
  - Private tab closed → not reopenable (FR-TAB-006).

### FR-TAB-003: Activate Tab

- **Description:** The system MUST switch the active tab, showing its content webview and hiding others.
- **Input:** `tabs.activate({ tabId })` or tab strip click.
- **Output:** `tabs.state` event with new active tab; `nav.state` for the newly active tab.
- **Acceptance:** Clicking a tab in the strip makes it active, shows its page, and updates the address bar.
- **Platforms:** All.
- **Edge cases:**
  - Idle tab activated → content webview reloaded from session state.
  - `find.close` emitted on tab switch so highlights don't linger.

### FR-TAB-004: Reorder Tabs

- **Description:** The system MUST reorder tabs when the user drags them in the tab strip.
- **Input:** `tabs.reorder({ tabIds: number[] })`
- **Output:** `tabs.state` event with new order.
- **Acceptance:** Dragging tab 3 before tab 1 produces order [3, 1, 2, 4].
- **Platforms:** Desktop only (tab strip not shown on mobile).

### FR-TAB-005: Pin Tab

- **Description:** The system MUST pin/unpin a tab. Pinned tabs are smaller, locked to the left, and not closeable via the tab strip close button.
- **Input:** `tabs.setPinned({ tabId, pinned: boolean })`
- **Output:** `tabs.state` event with `pinned` flag updated.
- **Acceptance:** Pinned tab shows reduced UI, stays leftmost, and `pinned: true` persists across sessions.
- **Platforms:** Desktop only.
- **Edge cases:**
  - Pinned tab closed via `tabs.close` → still works (just not via tab strip X).

### FR-TAB-006: Private Tab

- **Description:** The system MUST support private (ephemeral) tabs that do not record history, downloads, or session data to disk.
- **Input:** `tabs.create({ url?, background?, isPrivate: true })` or `Ctrl+Shift+N` or "New private tab" button.
- **Output:** Tab created with `private: true` flag; tab strip shows visual indicator.
- **Acceptance:** A private navigation leaves no history row. A private tab's content uses an ephemeral web context.
- **Platforms:**
  - Desktop: `WebviewBuilder::incognito(true)` → `WebContext::new_ephemeral` (Linux), `SetIsInPrivateModeEnabled` (Windows), `nonPersistentDataStore` (macOS).
  - Android: `LOAD_NO_CACHE` + 3rd-party cookie refusal + cache/history clear on close. **Honest limit:** first-party cookies linger in process-global jar after close.
- **Edge cases:**
  - Tab opened from private tab → inherits privateness.
  - Closed private tab → not reopenable (`reopen_closed` creates non-private tabs).
  - Private tab exempt from idle sweep (closing ephemeral webview destroys session).
  - History/downloads-list/session-persistence all skip private tabs.

### FR-TAB-007: Idle Sweep

- **Description:** The system MUST discard background tabs that have been idle beyond a configurable timeout, freeing memory. The tab's URL is preserved for reload on next activation.
- **Input:** Timer-based (`tabIdleTimeout` setting).
- **Output:** Background tab webview destroyed; tab remains in list with `live: false`.
- **Acceptance:** A tab idle for longer than `tabIdleTimeout` has its webview destroyed. Activating it reloads the page.
- **Platforms:** Desktop only (Android manages tabs natively).
- **Edge cases:**
  - Private tabs are exempt (destroying ephemeral webview loses session).
  - Pinned tabs are not swept.

### FR-TAB-008: Reopen Closed Tab

- **Description:** The system MUST reopen the most recently closed tab (non-private only).
- **Input:** `tabs.reopenClosed()` or `Ctrl+Shift+T`.
- **Output:** Tab restored with its last URL.
- **Acceptance:** After closing a tab, calling `reopenClosed` restores it at its original position.
- **Platforms:** All.
- **Edge cases:**
  - No closed tabs → no-op.
  - Private tabs → excluded from reopen list.

### FR-TAB-009: Session Persistence

- **Description:** The system MUST persist the tab list (excluding private tabs) to disk and restore it on next launch.
- **Input:** App shutdown / tab structure change.
- **Output:** `tabs.json` written; restored on next `lib.rs` setup.
- **Acceptance:** Restarting the app restores the same tabs at the same positions with the same pinned state.
- **Platforms:** Desktop only.
- **Edge cases:**
  - Private tabs filtered out of `to_persisted`.
  - Corrupt `tabs.json` → fallback to single home tab.

### FR-TAB-010: Tab State Events

- **Description:** The system MUST emit `tabs.state` on every structural change (create, close, activate, reorder, pin, title update).
- **Input:** Any tab mutation.
- **Output:** `tabs.state` event with `{ tabs: TabMeta[], activeId: number }`.
- **Acceptance:** Every tab mutation produces a `tabs.state` event.
- **Platforms:** All.

### FR-TAB-011: Tab Title Tracking

- **Description:** The system MUST track and emit page titles for each tab.
- **Input:** Page title changes from webview engine.
- **Output:** `tabs.state` event includes `title` per tab.
- **Acceptance:** Navigating to a page updates the tab strip label to the page title.
- **Platforms:**
  - Desktop: webview `title-changed` signal.
  - Android: chrome relays title via `tabs.setTitle` (no native title signal).

### FR-TAB-012: Mobile Tab Switcher

- **Description:** The system MUST provide a vertical-list tab switcher on Android with search, new tab, new private tab, and close per tab.
- **Input:** Bottom bar "Tabs" button.
- **Output:** `MobileTabSwitcher` sheet shown with tab list.
- **Acceptance:** Tapping a tab in the switcher activates it. Tapping X closes it. Tapping "+ New tab" creates one.
- **Platforms:** Android only.

### FR-TAB-013: Background Tab Opening

- **Description:** The system MUST open `target=_blank` / `window.open` / Ctrl+click links as background tabs without switching the active tab. Ctrl+click triggers the engine's new-window behavior, which is caught by `on_new_window` and routed to `tabs::open_background()`.
- **Input:** `on_new_window` from content webview (triggered by middle-click, Ctrl+click, `target=_blank`, `window.open`); `window.__aegisOpenTab(url)` on Android.
- **Output:** New tab created with `background: true`.
- **Acceptance:** Middle-clicking or Ctrl+clicking a link opens it in a background tab. The active tab remains unchanged.
- **Platforms:** All.
- **Edge cases:**
  - Ad-block pop-under check: if destination is an ad/tracker domain, the request is dropped (not opened as a tab).
  - Private tab opener → new tab inherits privateness.

---

## 4. FR-ADB: Ad-Blocking

### FR-ADB-001: Ad/Tracker Blocking

- **Description:** The system MUST block requests to known ad and tracker domains using the Brave `adblock` engine loaded with EasyList + EasyPrivacy + Peter Lowe's + abuse-TLDs.
- **Input:** Any network request from a content webview.
- **Output:** Request cancelled or allowed.
- **Acceptance:** Navigating to a page with ad subresources (e.g., DoubleClick `gpt.js`) with ad-block ON results in those requests being blocked. With ad-block OFF, they load.
- **Platforms:** All (engine runs on all platforms).
- **Edge cases:**
  - Engine is `!Send` — lives on one dedicated thread; queries cross via mpsc.
  - Allowlisted domains → requests pass through.
  - Custom rules + user subscriptions layer on top.

### FR-ADB-002: Platform-Specific Blocking Tiers

- **Description:** The system MUST apply platform-specific blocking tiers in addition to the engine.
- **Input:** Network requests from content webviews.
- **Output:** Request blocked at the platform tier.
- **Acceptance:** Each platform's tier blocks requests independently of the engine.
- **Platforms:**
  - **Linux:** WebKit content filters (declarative, per-tab, chunked ~25k rules, disk-cached by hash).
  - **Windows:** `WebResourceRequested` COM handler on `ICoreWebView2`.
  - **Android:** `shouldInterceptRequest` in `MainActivity.kt`.
  - **Windows + macOS:** Injected JS tier (document-start fetch/XHR/sendBeacon blocking).

### FR-ADB-003: Pop-Under Guard

- **Description:** The system MUST override `window.open` to block cross-origin scripted popups before any window/tab opens, on every platform.
- **Input:** `window.open()` call from page script.
- **Output:** Cross-origin scripted popup blocked; same-origin / `about:blank` / real `<a target=_blank>` passes through.
- **Acceptance:** A page script calling `window.open('https://ad.example.com')` is blocked. A user clicking `<a href="https://example.com" target=_blank>` opens normally.
- **Platforms:** All.
- **Edge cases:**
  - Legit cross-origin scripted popups (e.g., OAuth) are also blocked — documented trade-off.

### FR-ADB-004: Shield Badge Counter

- **Description:** The system SHOULD display a blocked-request count on the shield icon, reflecting per-tab page count and session total.
- **Input:** `note_blocked` calls from each platform tier.
- **Output:** `adblock.blockedCount` event with `{ pageBlocked, sessionBlocked }`.
- **Acceptance:** Navigating to an ad-heavy page increases the page count. The badge reflects the count.
- **Platforms:** All (each tier counts what its own layer sees).
- **Edge cases:**
  - Linux: content-filter-blocked requests cancel before `resource-load-started` fires → under-count (real blocking, invisible count).
  - `getState` returns the active tab's `pageBlocked` for mount/tab-switch recovery.
  - `reset_page` called on navigation start.

### FR-ADB-005: Ad-Block Enable/Disable

- **Description:** The user MUST be able to toggle ad-blocking on/off globally.
- **Input:** `adblock.setEnabled({ enabled: boolean })`
- **Output:** `adblock.getState` reflects new state; engine re-synced.
- **Acceptance:** Disabling ad-block allows previously blocked requests to load. Re-enabling blocks them again.
- **Platforms:** All.
- **Edge cases:**
  - Toggle applies immediately to new navigations.
  - Existing loaded content is not re-evaluated.

### FR-ADB-006: Per-Site Allowlist

- **Description:** The user MUST be able to allowlist specific sites, disabling ad-blocking for those origins.
- **Input:** `adblock.toggleAllowlist({ host })` / `adblock.removeAllowlist({ host })` / `adblockClearAllowlist()`
- **Output:** `adblock.getState` reflects updated allowlist.
- **Acceptance:** Adding `example.com` to the allowlist causes ad requests on that site to load.
- **Platforms:** All.
- **Edge cases:**
  - Subdomain matching: `example.com` allowlists `www.example.com` too.
  - Allowlist persists across sessions.
  - Allowlist is syncable (FR-SYN-001).

### FR-ADB-007: Filter Subscriptions

- **Description:** The system MUST support user-manageable filter list subscriptions (add, remove, enable/disable, update).
- **Input:** `subs.add({ url })` / `subs.remove({ listId })` / `subs.setEnabled({ listId, enabled })` / `lists.updateNow()`
- **Output:** `subs.list` returns current subscriptions; `lists.updateResult` event on update.
- **Acceptance:** Adding a subscription URL fetches the list, parses it, and applies its rules.
- **Platforms:** All.
- **Edge cases:**
  - Built-in defaults (EasyList, EasyPrivacy, Peter Lowe's) seeded on first run; `builtin: true`.
  - Default rows are tombstone-aware (removed default is never resurrected).
  - No boot fetch (deliberate): baked-in copies provide day-one blocking.
  - `abuse-tlds` is baked-only (no upstream URL).

### FR-ADB-008: Custom Filters

- **Description:** The user MUST be able to add custom filter rules.
- **Input:** `customFiltersSet({ rules: string })`
- **Output:** `customFiltersGet` returns current rules; engine re-synced.
- **Acceptance:** Adding `||example.com^` blocks all requests to `example.com`.
- **Platforms:** All.

### FR-ADB-009: Per-Tab Content Filters (Linux)

- **Description:** On Linux, WebKit content filters MUST be applied per-tab (per-webview), not globally.
- **Input:** Tab spawn / filter update.
- **Output:** Filters applied to the new tab's `UserContentManager`.
- **Acceptance:** A tab opened after a filter update has the new filters. An already-open tab retains its original filters until reloaded.
- **Platforms:** Linux only.
- **Edge cases:**
  - Filters cached to disk by hash.
  - `remove_all` clears all webview filters.

### FR-ADB-010: Ad-Block Injected JS Tier

- **Description:** On Windows and macOS, the system MUST inject a document-start script that blocks fetch/XHR/sendBeacon to ad domains and applies cosmetic hiding.
- **Input:** Content webview creation.
- **Output:** Injected script blocks ad-network requests at the JS level.
- **Acceptance:** Pages on Windows/macOS have ad-related fetch/XHR calls blocked by the injected tier.
- **Platforms:** Windows, macOS only.

---

## 5. FR-SEC: Security

### FR-SEC-001: HTTPS-Only Upgrade

- **Description:** The system MUST upgrade top-level `http://` navigations to `https://` (localhost exempt). If the HTTPS load fails, a warning interstitial is shown.
- **Input:** User navigates to `http://example.com`.
- **Output:** Navigates to `https://example.com`. If HTTPS fails, `safety.interstitial` event shown.
- **Acceptance:** `http://example.com` silently upgrades to `https://`. `http://http.badssl.com` shows the HTTPS-Only interstitial.
- **Platforms:** All.
- **Edge cases:**
  - `localhost` / `127.0.0.1` exempt from upgrade.
  - Subframes with `http://` are also upgraded (check runs in `on_navigation`).

### FR-SEC-002: MalwareGuard Blocking

- **Description:** The system MUST check navigations and subresources against a bundled URLhaus host blocklist and block matches with a warning interstitial.
- **Input:** Any navigation or subresource request.
- **Output:** If host matches blocklist → navigation cancelled, `safety.interstitial` event emitted.
- **Acceptance:** Navigating to a known malware host shows the interstitial. Subresource loads from malware hosts are blocked.
- **Platforms:** All.
- **Edge cases:**
  - Session exceptions: user can opt to proceed (records exception, bypasses future blocks for that host).
  - `safety.proceed` records the exception.
  - `safety.listExceptions` / `safety.removeException` manage the list.

### FR-SEC-003: Redirect Guard

- **Description:** The system MUST block scripted cross-origin top-frame redirects that were not initiated by a user gesture or the app.
- **Input:** Top-frame navigation with `is_redirect=true` and `scripted=true` and cross-origin.
- **Output:** Navigation cancelled; `redirect.blocked` event emitted with `{ viewId, from, to }`.
- **Acceptance:** A page script redirecting the top frame to a cross-origin domain is blocked. User-gesture redirects pass.
- **Platforms:**
  - Linux: Two-phase (NavigationAction records chain + ResponsePolicyDecision makes the call, using `is_main_frame_main_resource()` from webkit2gtk `v2_40`).
  - Windows: `block_at_start` via `NavigationStarting` (top-frame only, resolves app-initiated at the hop).
  - macOS: `WKNavigationDelegate`.
  - Android: `shouldOverrideUrlLoading`.
- **Edge cases:**
  - Redirect chains: judge by who STARTED the chain, not the hop.
  - App-initiated navs (PendingNavs-matched) pass.
  - Blocked redirect destination is automatically opened in a new background tab via `tabs.create(url, true)`.

### FR-SEC-004: Site Permissions

- **Description:** The system MUST deny site permission requests (geolocation, camera, microphone, notifications, pointer-lock) by default and prompt the user on first use. The decision is remembered per origin.
- **Input:** Permission prompt from webview engine.
- **Output:** `permissions.prompt` event → chrome shows prompt; `permissions.resolve` records the decision.
- **Acceptance:** First visit to a site requesting geolocation shows a prompt. Denying it blocks the request. The next visit to the same origin auto-denies without prompting.
- **Platforms:** All.
- **Edge cases:**
  - `permissions.list` returns all saved decisions.
  - `permissions.remove({ origin })` revokes a saved decision.
  - `permissionsClear()` removes all saved decisions.

### FR-SEC-005: Content-Security-Policy

- **Description:** The chrome webview MUST enforce a strict CSP: `default-src 'self'`, `script-src 'self'`, `object-src 'none'`, `frame-src 'none'`, `form-action 'none'`.
- **Input:** Any resource load in the chrome webview.
- **Output:** Resources outside `self` are blocked by the engine.
- **Acceptance:** An attempt to load an external script in the chrome is blocked.
- **Platforms:** All.
- **Edge cases:**
  - No inline scripts, no remote scripts, no frames, no forms to external origins.

---

## 6. FR-PRI: Privacy

### FR-PRI-001: Anti-Fingerprinting (Farbling)

- **Description:** The system MUST inject a document-start JavaScript shim that perturbs fingerprinting surfaces with deterministic per-frame-origin noise. Three levels: `off`, `standard`, `strict`.
- **Input:** Content webview creation + `antiFingerprint` setting.
- **Output:** Injected shim modifies canvas/audio/navigator (standard) or adds WebGL (strict).
- **Acceptance:** With `standard` level, `canvas.toDataURL()` returns a slightly different result each session for the same page. With `off`, no shim is injected.
- **Platforms:**
  - Desktop: injected via `adblock_inject::script`.
  - Android: injected via `NativeFarble.farbleScript()` JNI getter.
- **Edge cases:**
  - Per-site fp-allowlist: allowlisted hosts receive no shim (desktop only; Android hardcodes `host_allowlisted = false` — parity gap).
  - Per-spawn: level/allowlist apply at webview creation; toggling applies to new/reloaded tabs only.
  - `off` level → `""` → no injection (fail-safe).
  - Seed is `HKDF-SHA256(SESSION_SALT)` baked inside the IIFE closure, never as a top-level `var` or `window.*`.
  - Session salt is `OnceLock<[u8;32]>` — CSPRNG, never persisted, never in any store.

### FR-PRI-002: Farbling Levels

- **Description:** The system MUST support three farbling levels with distinct coverage:
  - `off`: no shim.
  - `standard`: canvas (`getImageData`/`toDataURL`/`toBlob`), audio (`getFloatFrequencyData`/`getChannelData`), navigator/UA-CH (`hardwareConcurrency`/`deviceMemory`/`userAgentData.brands` kept consistent with Chrome-148 UA).
  - `strict`: adds WebGL (`getParameter` UNMASKED_*/`readPixels`/`getSupportedExtensions`/`getShaderPrecisionFormat`).
- **Input:** `settings.set({ antiFingerprint: 'off' | 'standard' | 'strict' })`
- **Output:** Level persisted; `fingerprint.getState` reflects new level.
- **Acceptance:** Changing from `off` to `standard` on a reloaded page shows perturbed canvas output. Changing to `strict` additionally perturbs WebGL parameters.
- **Platforms:** All.
- **Edge cases:**
  - `strict`/WebGL is highest-risk and opt-in-within-opt-in.
  - A same-world JS shim is detectable (Proxy/toString probing) — documented, accepted trade-off.

### FR-PRI-003: Fingerprint Allowlist Management

- **Description:** The user MUST be able to manage a per-site fp-allowlist: add the current browsing host, remove individual hosts, clear all.
- **Input:** `fingerprint.toggleAllowlist({ host })` / `fingerprint.removeAllowlist({ host })` / `fingerprint.clearAllowlist()`
- **Output:** `fingerprint.getState` reflects updated allowlist.
- **Acceptance:** Adding `example.com` to the fp-allowlist causes the farble shim to be skipped for that host.
- **Platforms:** Desktop only (Android parity gap — `host_allowlisted` always `false`).
- **Edge cases:**
  - Separate from the ad-block allowlist.
  - Allowlist is syncable.

### FR-PRI-004: WebRTC IP-Leak Defense

- **Description:** The system MUST inject a document-start JavaScript shim that wraps `RTCPeerConnection` to filter local/private ICE candidates while preserving TURN/relay candidates.
- **Input:** `webrtcPolicy` setting (`default`/`public-only`/`disable`).
- **Output:** Shim filters `icecandidate` events, `createOffer`/`Answer` SDP, `localDescription` getters, and `getStats()`.
- **Acceptance:** With `public-only`, `getStats()` shows no local/private candidates. With `disable`, WebRTC is fully disabled.
- **Platforms:**
  - All: JS shim injected via `adblock_inject::script`.
  - Linux/Windows: native backstop (`set_enable_webrtc(false)` for `disable`; `--force-webrtc-ip-handling-policy` for `public-only`).
  - macOS/Android: shim only.
- **Edge cases:**
  - Per-site escape hatch reuses the ad-block allowlist (`adblock::host_allowlisted`).
  - Per-spawn: policy applies at webview creation.
  - `public-only` is the default.
  - TURN/relay candidates preserved so calls survive.

### FR-PRI-005: Private Tab Data Guards

- **Description:** The system MUST ensure private tabs do not persist history, downloads, or session data to disk.
- **Input:** Any data-persistence call from a private tab.
- **Output:** Data skipped (not written to store).
- **Acceptance:** Navigating in a private tab produces no history entry. Downloading in a private tab produces no downloads-list entry (file still lands on disk).
- **Platforms:**
  - Desktop: `history::record` / `update_title` early-return on `is_private`; `downloads::on_requested` skips list entry; `to_persisted` filters private tabs.
  - Android: `LOAD_NO_CACHE` + cache/history clear on close. First-party cookies linger (documented, accepted, fix if posible).
- **Edge cases:**
  - Downloaded FILE still lands on disk (matches Chrome/Firefox incognito behavior).
  - Closed private tab is not reopenable.

---

## 7. FR-VLT: Vault

### FR-VLT-001: Vault State Query

- **Description:** The system MUST return the vault's summary state at any time without requiring unlock.
- **Input:** `vault.getState()`
- **Output:** `VaultState { exists: boolean, unlocked: boolean, count: number, undecryptable: number }`
- **Acceptance:** Before any vault exists, returns `{ exists: false, unlocked: false, count: 0, undecryptable: 0 }`.
- **Platforms:** All.

### FR-VLT-002: Create Vault

- **Description:** The system MUST initialize a new vault with a master password, generating a per-vault salt and verifier.
- **Input:** `vault.create({ masterPassword: string })`
- **Output:** `VaultState` with `exists: true, unlocked: true, count: 0`. `vault.state` event emitted.
- **Acceptance:** Creating a vault with a valid password succeeds. Creating a second vault errors.
- **Platforms:** All.
- **Edge cases:**
  - Password strength: no minimum enforced (user responsibility).
  - Vault file written via `write_atomic` (temp→fsync→rename).

### FR-VLT-003: Unlock Vault

- **Description:** The system MUST unlock an existing vault by deriving the DEK from the master password via Argon2id and decrypting the records.
- **Input:** `vault.unlock({ masterPassword: string })`
- **Output:** `VaultState` with `unlocked: true, count: N`. `vault.state` event emitted.
- **Acceptance:** Correct password unlocks; wrong password returns error.
- **Platforms:** All.
- **Edge cases:**
  - `undecryptable > 0` → UI shows warning banner (records preserved but not decryptable).
  - Wrong password → error string returned, vault remains locked.
  - `Zeroizing` wipes DEK on failed unlock.

### FR-VLT-004: Lock Vault

- **Description:** The system MUST wipe the in-memory DEK and all decrypted records.
- **Input:** `vault.lock()`
- **Output:** `VaultState` with `unlocked: false, count: 0`. `vault.state` event emitted.
- **Acceptance:** After locking, `vault.list()` returns "vault is locked" error.
- **Platforms:** All.
- **Edge cases:**
  - `Zeroizing` on drop ensures DEK is wiped from memory.
  - `revealedUuids` in UI cleared on lock.

### FR-VLT-005: List Records

- **Description:** The system MUST return all decrypted vault records when unlocked.
- **Input:** `vault.list()`
- **Output:** `VaultRecord[]` — `{ uuid, updatedAt, site, username, password, notes }`.
- **Acceptance:** After adding 3 records, `vault.list()` returns all 3.
- **Platforms:** All.
- **Edge cases:**
  - Errors if vault is locked.
  - Decrypted records are NEVER held in React state between operations.

### FR-VLT-006: Add Record

- **Description:** The system MUST add a new record to the vault, seal it with XChaCha20-Poly1305, and persist.
- **Input:** `vault.add({ site, username, password, notes? })`
- **Output:** Updated `VaultRecord[]`. `vault.state` event emitted.
- **Acceptance:** Adding a record increases `count` by 1. The record appears in `vault.list()`.
- **Platforms:** All.
- **Edge cases:**
  - AAD binds `ns|uuid|updatedAt` so record splicing fails authentication.
  - Atomic write (temp→fsync→rename).

### FR-VLT-007: Update Record

- **Description:** The system MUST partially update a record by UUID.
- **Input:** `vault.update({ uuid, partial: { site?, username?, password?, notes? } })`
- **Output:** Updated `VaultRecord[]`. `vault.state` event emitted.
- **Acceptance:** Updating a record's password persists the change. `updatedAt` is updated.
- **Platforms:** All.

### FR-VLT-008: Remove Record

- **Description:** The system MUST remove a record by UUID and persist.
- **Input:** `vault.remove({ uuid })`
- **Output:** Updated `VaultRecord[]`. `vault.state` event emitted.
- **Acceptance:** Removing a record decreases `count` by 1. The record no longer appears in `vault.list()`.
- **Platforms:** All.

### FR-VLT-009: Search Records

- **Description:** The system MUST perform a case-insensitive search across site, username, and notes fields.
- **Input:** `vault.search({ q: string })`
- **Output:** `VaultRecord[]` matching the query.
- **Acceptance:** Searching "gmail" returns records where site, username, or notes contain "gmail".
- **Platforms:** All.

### FR-VLT-010: Vault State Events

- **Description:** The system MUST emit `vault.state` events after every create/unlock/lock/add/update/remove.
- **Input:** Any vault mutation.
- **Output:** `vault.state` event with `{ exists, unlocked, count, undecryptable }`.
- **Acceptance:** Every vault mutation produces a `vault.state` event. The event carries NO credential data.
- **Platforms:** All.

### FR-VLT-011: At-Rest Encryption

- **Description:** The vault file on disk MUST contain only ciphertext and non-secret KDF parameters. No plaintext credentials at rest.
- **Input:** Vault persistence.
- **Output:** `vault.json` with `{ v, kdf, salt, verifier{nonce, ct}, records[{uuid, updatedAt, nonce, ct}] }`.
- **Acceptance:** Inspecting `vault.json` reveals no plaintext site, username, password, or notes fields.
- **Platforms:** All.

### FR-VLT-012: OS-Keychain Anchoring

- **Description:** The system SHOULD anchor the vault seed in the OS keychain when available.
- **Input:** Vault creation / unlock.
- **Output:** Seed stored in OS keychain (desktop) or hardware keystore (Android).
- **Acceptance:** On a system with a keychain, the vault seed is stored there. On Android, StrongBox/TEE is preferred.
- **Platforms:**
  - Desktop: `keyring` crate (Secret Service / Credential Manager / Keychain).
  - Android: `AegisKeystore.kt` with `KeyGenParameterSpec` AES-GCM wrap; StrongBox preferred, TEE fallback.
  - Fallback: passphrase-wrapped file when no keychain is available.

---

## 8. FR-SYN: Sync

### FR-SYN-001: Enable Sync (New Device)

- **Description:** The system MUST enable E2E sync by generating a new Ed25519 device keypair, deriving a recovery phrase from the root secret, and registering with the sync server.
- **Input:** `sync.enableNew({ serverUrl, serverPassword? })`
- **Output:** `sync.state` event with `{ enabled: true, deviceId, serverUrl }`. Recovery phrase returned.
- **Acceptance:** Enabling sync on a fresh profile generates a device key, registers with the server, and returns a recovery phrase.
- **Platforms:** All.
- **Edge cases:**
  - Recovery phrase is the ONLY way to recover sync data. Shown once.
  - Server password required if server is configured with one.

### FR-SYN-002: Enable Sync (From Phrase)

- **Description:** The system MUST enable sync on a new device using an existing recovery phrase, deriving the root secret and registering the device.
- **Input:** `sync.enableFromPhrase({ recoveryPhrase, serverUrl, serverPassword? })`
- **Output:** `sync.state` event with `{ enabled: true, deviceId }`.
- **Acceptance:** Entering a valid recovery phrase on a second device syncs its data from the server.
- **Platforms:** All.
- **Edge cases:**
  - Wrong phrase → error.
  - Account-root signature required for device registration.

### FR-SYN-003: Sync Unlock

- **Description:** The system MUST unlock sync on an already-enabled device (e.g., after restart) using the stored root secret.
- **Input:** `sync.unlock()`
- **Output:** `sync.state` event with `{ enabled: true, unlocked: true }`.
- **Acceptance:** After restart, calling `sync.unlock()` restores sync capability without re-entering the phrase.
- **Platforms:** All.

### FR-SYN-004: Disable Sync

- **Description:** The system MUST disable sync and remove the local device from the server.
- **Input:** `sync.disable()`
- **Output:** `sync.state` event with `{ enabled: false }`.
- **Acceptance:** Disabling sync removes the device registration and stops background sync passes.
- **Platforms:** All.

### FR-SYN-005: Manual Sync

- **Description:** The user MUST be able to trigger an immediate sync pass.
- **Input:** `sync.syncNow()`
- **Output:** Pull→merge→push cycle completes; `sync.changed` event if records were updated.
- **Acceptance:** After adding a favorite on device A, triggering sync on device B shows the favorite.
- **Platforms:** All.

### FR-SYN-006: Background Sync

- **Description:** The system MUST perform periodic background sync passes (debounced).
- **Input:** Timer-based.
- **Output:** Pull→merge→push; `sync.changed` targeted refetch on merge.
- **Acceptance:** Changes on one device appear on another within the sync interval.
- **Platforms:** All.

### FR-SYN-007: Record Merge (HLC-LWW)

- **Description:** The system MUST merge records using Hybrid Logical Clock last-writer-wins semantics with tombstone support.
- **Input:** Records from server pull.
- **Output:** Merged local state; `sync.changed` event for targeted refetch.
- **Acceptance:** Two devices modifying the same record independently results in the latest timestamp winning.
- **Platforms:** All.
- **Edge cases:**
  - Tombstones preserve deletions across sync.
  - Never a full reload — targeted refetch per store.
  - Tombstones should not be synced to devices(server only).

### FR-SYN-008: Device Management

- **Description:** The system MUST support listing and removing paired devices.
- **Input:** `sync.listDevices()` / `sync.removeDevice({ deviceId })`
- **Output:** List of devices or removal confirmation.
- **Acceptance:** `sync.listDevices()` returns all registered devices. Removing a device revokes its token.
- **Platforms:** All.
- **Edge cases:**
  - Cannot remove the current device (must disable sync instead).

### FR-SYN-009: Recovery Phrase

- **Description:** The system MUST provide the recovery phrase via explicit user request.
- **Input:** `sync.getRecoveryPhrase()`
- **Output:** The recovery phrase string.
- **Acceptance:** The phrase matches the one generated at sync enablement.
- **Platforms:** All.
- **Edge cases:**
  - Phrase is derived from the root secret (one-way). The root secret itself is never exposed.

### FR-SYN-010: Sync Server (Self-Hosted)

- **Description:** The system MUST support a self-hosted sync server (Rust/axum) that stores opaque ciphertext only.
- **Input:** HTTP requests to `/v1/records`, `/v1/devices*`, `/healthz`.
- **Output:** HLC-LWW record upsert, device registration/listing/removal.
- **Acceptance:** The server never holds encryption keys. It cannot decrypt any data.
- **Platforms:** All (server is standalone).
- **Edge cases:**
  - Replay defense: per-(device, nonce) tracking.
  - Quotas: per-request record count, per-field lengths, per-account total.
  - Optional persistence via `AEGIS_SYNC_DATA` env var.

---

## 9. FR-CTX: Content Features

### FR-CTX-001: Find-in-Page (Start)

- **Description:** The system MUST begin a find-in-page session, searching for a query string in the content webview.
- **Input:** `find.start({ query, caseSensitive?, viewId? })`
- **Output:** `find.state` event with `{ viewId, query, matchCount, activeMatchIndex }`.
- **Acceptance:** Typing "hello" in the find bar highlights all matches and reports the count.
- **Platforms:** All (capabilities vary — see FR-CTX-002).
- **Edge cases:**
  - Empty query → no search.
  - `viewId` omitted → searches the active tab.
  - Debounced ~120ms to avoid rapid-fire searches.

### FR-CTX-002: Find-in-Page (Platform Capabilities)

- **Description:** Per-platform find capabilities:
  - **Linux:** Real match count (via `found-text` signal), full highlight, no active index (reports 1 when >0).
  - **Windows:** Real count + real active index + highlight-all (`ICoreWebView2Find`). Requires 2024+ WebView2 Runtime.
  - **macOS:** Bool only (`WKFindResult.matchFound`). Shows "1 match" / "0 matches". No highlight-all.
  - **Android:** Real count + active index + highlight. Case-insensitive only (API limitation).
- **Input:** Platform-specific find engine.
- **Output:** `find.state` event with platform-appropriate data.
- **Acceptance:** Each platform reports results consistent with its capabilities.
- **Edge cases:**
  - Windows: `cast::<ICoreWebView2_28>()` fails silently on older runtimes → find is no-op.

### FR-CTX-003: Find-in-Page (Next/Prev)

- **Description:** The system MUST navigate to the next/previous match within the current find session.
- **Input:** `find.next({ viewId? })` / `find.prev({ viewId? })`
- **Output:** `find.state` event with updated `activeMatchIndex`.
- **Acceptance:** Clicking "next" moves the active highlight to the next match.
- **Platforms:** All.

### FR-CTX-004: Find-in-Page (Close)

- **Description:** The system MUST close the find session and clear all highlights.
- **Input:** `find.close({ viewId? })`
- **Output:** Highlights cleared; find bar hidden.
- **Acceptance:** Closing find removes all yellow highlights from the page.
- **Platforms:** All.
- **Edge cases:**
  - `find.close` is also emitted on tab switch.

### FR-CTX-005: Page Zoom (Set)

- **Description:** The system MUST set the page zoom factor for a specific tab.
- **Input:** `zoom.set({ viewId, factor })`
- **Output:** `zoom.changed` event with `{ viewId, factor }`.
- **Acceptance:** Setting zoom to 1.5 on the active tab makes the page 150% size.
- **Platforms:**
  - Linux: `WebViewExt::set_zoom_level(factor)`.
  - Windows: `SetZoomFactor(factor)` on `ICoreWebView2Controller`.
  - macOS: `WKWebView::setPageZoom(CGFloat)`.
  - Android: `WebSettings.textZoom = round(factor * 100)` (text-only, not true page zoom).
- **Edge cases:**
  - Factor clamped to valid range.
  - Zoom is session-only (not persisted; discarded tabs reload at 100%).
  - Applied at spawn via `apply_to_tab` so reloaded tabs keep their zoom.

### FR-CTX-006: Page Zoom (Reset)

- **Description:** The system MUST reset the page zoom to 100%.
- **Input:** `zoom.reset({ viewId })`
- **Output:** `zoom.changed` event with `factor: 1.0`.
- **Acceptance:** After zooming to 150%, resetting returns the page to 100%.
- **Platforms:** All.

### FR-CTX-007: Page Zoom (Get)

- **Description:** The system MUST return the current zoom factor for a tab.
- **Input:** `zoom.get({ viewId })`
- **Output:** `{ factor: number }`.
- **Acceptance:** After setting zoom to 1.25, `zoom.get` returns `{ factor: 1.25 }`.
- **Platforms:** All.

### FR-CTX-008: Proxy (Set Config)

- **Description:** The system MUST configure a content-webview proxy with scheme, host, port, and optional bypass hosts.
- **Input:** `proxy.setConfig({ scheme: 'http' | 'socks5', host, port, bypassHosts? })`
- **Output:** `proxy.state` event with updated config.
- **Acceptance:** Setting a proxy config routes subsequent content-webview requests through the proxy.
- **Platforms:**
  - Linux: live per-webview `set_network_proxy_settings`.
  - Windows: spawn-time `--proxy-server` arg (applies to new/reloaded tabs only).
  - Android: process-global `ProxyController` (covers all WebViews; chrome excluded via bypass).
  - macOS: no-op (not implemented).
- **Edge cases:**
  - `bypassHosts` uses canonical key `"bypassHosts"` everywhere (serde rename lesson).
  - UI copy says "Proxy" — never "VPN".

### FR-CTX-009: Proxy (Clear)

- **Description:** The system MUST clear the proxy configuration and restore direct connections.
- **Input:** `proxy.clear()`
- **Output:** `proxy.state` with `mode: 'off'`.
- **Acceptance:** After clearing, content-webview requests go direct.
- **Platforms:** All (macOS already direct).

### FR-CTX-010: Proxy (Test Connection)

- **Description:** The system MUST test proxy reachability via a TCP socket probe.
- **Input:** `proxy.testConnection({ scheme, host, port })`
- **Output:** `{ ok: boolean, latencyMs?: number, error?: string }`.
- **Acceptance:** Testing a reachable proxy returns `{ ok: true, latencyMs: <ms> }`. An unreachable proxy returns `{ ok: false, error: "..." }`.
- **Platforms:** All.
- **Edge cases:**
  - This tests TCP reachability, not egress (the proxy may be reachable but not forward traffic).

### FR-CTX-011: Element Picker

- **Description:** The system MUST provide an element picker that highlights DOM elements on hover and returns a CSS selector on click.
- **Input:** `picker.start()` or UI button.
- **Output:** Selected element's CSS selector returned; cosmetic filter applied.
- **Acceptance:** Activating the picker and clicking an element returns its selector and hides it.
- **Platforms:** Linux only (cross-platform planned).
- **Edge cases:**
  - Non-Linux returns `{ ok: false }`.
  - Uses `document.title` sentinel pattern caught by `linux_layout::connect_title_label`.

---

## 10. FR-DAT: Data

### FR-DAT-001: Favorites (Add)

- **Description:** The system MUST add a URL to the favorites list.
- **Input:** `favorites.add({ url, title })`
- **Output:** Updated favorites list.
- **Acceptance:** Adding a URL to favorites makes it appear in the favorites bar.
- **Platforms:** All.
- **Edge cases:**
  - Deduplication: same URL not added twice.

### FR-DAT-002: Favorites (Update)

- **Description:** The system MUST update a favorite's title or URL.
- **Input:** `favorites.update({ id, url?, title? })`
- **Output:** Updated favorites list.
- **Acceptance:** Renaming a favorite updates its label in the bar.
- **Platforms:** All.

### FR-DAT-003: Favorites (Remove)

- **Description:** The system MUST remove a favorite by ID.
- **Input:** `favorites.remove({ id })`
- **Output:** Updated favorites list.
- **Acceptance:** Removing a favorite removes it from the bar.
- **Platforms:** All.

### FR-DAT-004: Favorites (Reorder)

- **Description:** The system MUST reorder favorites via drag-and-drop.
- **Input:** `favorites.reorder({ ids: number[] })`
- **Output:** Updated favorites list in new order.
- **Acceptance:** Dragging favorite 3 before favorite 1 produces the new order.
- **Platforms:** All.

### FR-DAT-005: Saved Items (Add)

- **Description:** The system MUST save a URL to the read-later list with optional tags.
- **Input:** `saved.add({ url, title, tags? })`
- **Output:** Updated saved list.
- **Acceptance:** Saving a URL makes it appear in the saved sidebar.
- **Platforms:** All.

### FR-DAT-006: Saved Items (Tag Management)

- **Description:** The system MUST support renaming and deleting tags, and computing tag unions.
- **Input:** `saved.renameTag({ old, new })` / `saved.deleteTag({ tag })` / `saved.tagUnion({ ids })`
- **Output:** Updated saved list with tags modified.
- **Acceptance:** Renaming a tag updates all records with that tag.
- **Platforms:** All.

### FR-DAT-007: Saved Items (Remove)

- **Description:** The system MUST remove a saved item by ID.
- **Input:** `saved.remove({ id })`
- **Output:** Updated saved list.
- **Acceptance:** Removing a saved item removes it from the sidebar.
- **Platforms:** All.

### FR-DAT-008: Saved Items (Check)

- **Description:** The system MUST check if a URL is already saved.
- **Input:** `saved.has({ url })`
- **Output:** `{ saved: boolean }`.
- **Acceptance:** Visiting a saved URL shows the "saved" indicator.
- **Platforms:** All.

### FR-DAT-009: History (Record)

- **Description:** The system MUST record navigated URLs (non-private only).
- **Input:** Page navigation events.
- **Output:** History entry persisted.
- **Acceptance:** Navigating to a page produces a history entry visible in the sidebar.
- **Platforms:** All.
- **Edge cases:**
  - Private tabs → no history recorded.
  - Deduplication within `DEDUP_WINDOW_MS`.

### FR-DAT-010: History (Search)

- **Description:** The system MUST support searching history by URL or title.
- **Input:** `history.search({ query })`
- **Output:** `HistoryEntry[]` matching the query.
- **Acceptance:** Searching "example" returns history entries containing "example" in URL or title.
- **Platforms:** All.

### FR-DAT-011: History (Remove / Clear)

- **Description:** The system MUST support removing individual history entries and clearing all history.
- **Input:** `history.remove({ id })` / `history.clear()`
- **Output:** Updated history list.
- **Acceptance:** Clearing history removes all entries from the sidebar.
- **Platforms:** All.

### FR-DAT-012: Downloads (List / Remove / Clear)

- **Description:** The system MUST manage a downloads list with list, remove, and clear operations.
- **Input:** `downloads.list()` / `downloads.remove({ id })` / `downloads.clear()`
- **Output:** `DownloadEntry[]` or confirmation.
- **Acceptance:** Downloaded files appear in the downloads list. Removing an entry hides it.
- **Platforms:** All.
- **Edge cases:**
  - Private tabs → no downloads-list entry (file still lands on disk).
  - `clear` keeps in-progress downloads.

### FR-DAT-013: Downloads (Open / Show)

- **Description:** The system MUST support opening a downloaded file and showing it in the file manager.
- **Input:** `downloads.openFile({ id })` / `downloads.showInFolder({ id })`
- **Output:** File opened in default app / file manager folder shown.
- **Acceptance:** Clicking "Open" opens the file. Clicking "Show in folder" opens the file manager.
- **Platforms:** Desktop only (Android uses system share).

### FR-DAT-014: Data Export

- **Description:** The system MUST export all stores + settings as a bundled archive.
- **Input:** `data.export()`
- **Output:** Bundle file (v2 format) with every store present.
- **Acceptance:** Exporting produces a bundle that can be imported into a fresh profile.
- **Platforms:** All.
- **Edge cases:**
  - `data.export` does NOT carry the session salt (OnceLock, never in any store).
  - Vault records are exported as ciphertext (not decrypted).
  - Should not export tombstones.

### FR-DAT-015: Data Import

- **Description:** The system MUST import a previously exported bundle, restoring all stores + settings.
- **Input:** `data.import({ data: string })`
- **Output:** All stores restored.
- **Acceptance:** Importing a bundle on a fresh profile restores favorites, saved, history, downloads, allowlist, settings, and customFilters.
- **Platforms:** All.
- **Edge cases:**
  - Garbage input → error.
  - Partial bundle → only present stores restored.

---

## 11. FR-UI: UI / Chrome

### FR-UI-001: Settings Modal

- **Description:** The system MUST provide a tabbed settings modal with grouped sections and roving arrow-key navigation.
- **Input:** Settings button click or keyboard shortcut.
- **Output:** Settings modal shown with tab rail.
- **Acceptance:** Opening settings shows all configured tabs. Arrow keys navigate the tab rail.
- **Platforms:** All.
- **Edge cases:**
  - On mobile/narrow viewport, tab rail becomes horizontal strip.
  - `TAB_GROUPS` defines section grouping; `TAB_ORDER` defines flat order.

### FR-UI-002: Theme (Dark / Light / System)

- **Description:** The system MUST support dark, light, and system-following themes.
- **Input:** `settings.set({ themeMode: 'dark' | 'light' | 'system' })`
- **Output:** `<html data-theme>` attribute updated; palette switches.
- **Acceptance:** Switching to light theme changes all chrome surfaces to light colors. System mode follows OS preference.
- **Platforms:** All.
- **Edge cases:**
  - `<html data-theme="dark">` in `index.html` prevents first-paint flash.
  - Desktop TabStrip, mobile chrome, and SafetyInterstitial are fully tokenized.

### FR-UI-003: Onboarding

- **Description:** The system MUST show a first-run welcome modal with feature overview and search engine picker.
- **Input:** First app launch (localStorage-gated).
- **Output:** Onboarding modal shown; dismissed on completion.
- **Acceptance:** First launch shows onboarding. Subsequent launches do not. Not shown during autopilot.
- **Platforms:** All.

### FR-UI-004: Favorites Bar

- **Description:** The system MUST show a favorites bar below the toolbar with clickable favorite entries.
- **Input:** Favorites data from `favorites.list`.
- **Output:** Horizontal bar with favorite buttons.
- **Acceptance:** Adding a favorite makes it appear in the bar. Clicking it navigates to its URL.
- **Platforms:** Desktop only (mobile has `MobileFavourites` strip).

### FR-UI-005: Sidebar

- **Description:** The system MUST provide a right-side sidebar for history, saved items, and favorites manager.
- **Input:** Sidebar toggle button.
- **Output:** `view.setSidebar` called; content insets from the right.
- **Acceptance:** Opening the sidebar shows the page inset from the right (page stays visible).
- **Platforms:** Desktop only.
- **Edge cases:**
  - Width remembered in localStorage.
  - Sidebar is NOT a chrome overlay (page stays visible).

### FR-UI-006: Shield Popover

- **Description:** The system MUST show a popover on shield-icon click with ad-block stats and controls.
- **Input:** Shield icon click.
- **Output:** Popover with blocked count, enable/disable toggle, allowlist controls.
- **Acceptance:** Clicking the shield shows the current page's blocked count and the allowlist option.
- **Platforms:** All.

### FR-UI-007: Fullscreen

- **Description:** The system MUST support hiding all chrome (toolbar, tab strip, etc.) for a fullscreen browsing experience.
- **Input:** `view.setFullscreen(true)` or UI button.
- **Output:** All chrome hidden; content fills the window. Back/Escape exits.
- **Acceptance:** Entering fullscreen hides all chrome. The page fills the window. Pressing Escape exits.
- **Platforms:**
  - Desktop: `Window::set_fullscreen(on)` + content webview relayout.
  - Android: immersive mode (`WindowInsetsControllerCompat.hide(systemBars())`).
- **Edge cases:**
  - Linux: Esc / floating exit button calls `set_fullscreen(false)`.
  - Android: Back button exits fullscreen.

### FR-UI-008: Auto-Open Blocked Redirect

- **Description:** The system MUST automatically open a blocked redirect destination in a new background tab when the native redirect guard cancels a scripted cross-origin top-frame redirect.
- **Input:** `redirect.blocked` event.
- **Output:** `tabs.create(url, true)` called with the blocked destination URL.
- **Acceptance:** When a redirect is blocked, the destination opens in a new background tab without user interaction.
- **Platforms:** All.
- **Edge cases:**
  - Chrome-initiated navigation grace period: redirects from the old page during a fresh chrome nav are suppressed to avoid spurious background tabs.

### FR-UI-009: Find Bar

- **Description:** The system MUST show a Ctrl+F infobar with text input, match count, prev/next buttons, and close button.
- **Input:** Ctrl+F or menu action.
- **Output:** FindBar rendered above content; auto-focused.
- **Acceptance:** Pressing Ctrl+F opens the find bar. Typing highlights matches. Prev/Next navigate them.
- **Platforms:** All.

### FR-UI-010: Zoom Indicator

- **Description:** The system MUST show a toolbar zoom widget with current percent and a popover for zoom controls.
- **Input:** Zoom widget click.
- **Output:** Popover with Zoom-out / percent / Zoom-in / Reset buttons.
- **Acceptance:** Clicking the zoom label opens the popover. Buttons adjust zoom.
- **Platforms:** Desktop only (mobile uses `MobileMenuSheet` zoom controls).

### FR-UI-011: Split View

- **Description:** The system MUST support displaying 2-4 content webviews side-by-side with equal-width initial sizing, resize, and focus tracking.
- **Input:** `split.enter({ tabIds })` / `split.resize({ paneId, width })` / `split.focus({ paneId })` / `split.exit()`
- **Output:** `split.state` event with layout.
- **Acceptance:** Entering split view with 2 tabs shows them side-by-side. Resizing adjusts widths.
- **Platforms:** Desktop (Linux, Windows, macOS). Android: not supported.
- **Edge cases:**
  - State machine in `split.rs` (423 lines), fully wired in `lib.rs`.
  - `split.state` event drives content webview positioning.

### FR-UI-012: Workspaces

- **Description:** The system MUST support named, color-coded workspace groups with separate tab lists.
- **Input:** `workspace.create({ name, color })` / `workspace.switch({ id })` / `workspace.rename({ id, name })` / `workspace.setColor({ id, color })` / `workspace.remove({ id })` / `workspaceReorder({ ids })`
- **Output:** `workspace.state` event with workspace list + active workspace.
- **Acceptance:** Creating a workspace and switching to it shows only that workspace's tabs.
- **Platforms:** All.
- **Edge cases:**
  - React hooks + tests exist; Rust backend not yet implemented.
  - IPC channels defined in `shared/types.ts`.

### FR-UI-013: Responsive Desktop Shell

- **Description:** The system MUST adapt the desktop chrome layout for narrow viewports (≤680px).
- **Input:** Window resize below 680px.
- **Output:** `.aegis-narrow` class toggled; toolbar overflow ("More tools") menu activated.
- **Acceptance:** Resizing the window below 680px shows the overflow menu for toolbar buttons.
- **Platforms:** Desktop only.
- **Edge cases:**
  - Desktop never swaps to `MobileApp` shell (that shell requires the native content bridge).

### FR-UI-014: Mobile Shell

- **Description:** On Android, the system MUST render `MobileApp` instead of `DesktopApp`, with a touch-optimized shell.
- **Input:** `isMobile` detected from `.aegis-mobile` class.
- **Output:** `MobileTopBar` + `MobileBottomBar` + `MobileMenuSheet` + `MobileTabSwitcher`.
- **Acceptance:** On Android, the UI shows the mobile chrome with bottom bar, swipe gestures, and sheets.
- **Platforms:** Android only.

### FR-UI-015: Auto-Update

- **Description:** The system MUST check for updates via tauri-plugin-updater, verify the signature, and offer to restart.
- **Input:** `update.checkNow()` or automatic check.
- **Output:** `update.state` event with `{ available, version }`. `update.restartToInstall()` applies.
- **Acceptance:** When a new version is available, the user is notified and can restart to install.
- **Platforms:** All.
- **Edge cases:**
  - Signature verification against public key in `tauri.conf.json`.
  - Without signing keys, build succeeds but no signature → auto-update won't verify.

### FR-UI-016: Downloads Modal

- **Description:** The system MUST provide a downloads modal showing the download list with open/show/remove/clear actions.
- **Input:** Downloads button click.
- **Output:** Downloads modal shown.
- **Acceptance:** Opening downloads shows the list. Each entry has Open, Show in folder, and Remove actions.
- **Platforms:** All.

---

## 12. Cross-Cutting Requirements

### FR-CC-001: IPC Contract Integrity

- **Description:** Every IPC channel MUST be defined in `shared/types.ts`, dispatched in `src-tauri/src/lib.rs`, and implemented in `src/lib/ipcClient.ts`. All three must stay in sync.
- **Acceptance:** The `coverage.test.ts` drift guard fails the build if any `IPC.*` channel has no catalog entry.
- **Platforms:** All.

### FR-CC-002: Autopilot Catalog Coverage

- **Description:** Every IPC feature MUST have a catalog entry in `src/autopilot/catalog.ts` and every reachable UI state MUST have a screen entry in `src/autopilot/screens.ts`.
- **Acceptance:** `coverage.test.ts` and `screens.test.ts` pass. New features require catalog/screen entries in the same commit.
- **Platforms:** All.

### FR-CC-003: Interaction Spec Coverage

- **Description:** Every interactive control MUST have at least one `InteractionSpec` in the interactions catalog.
- **Acceptance:** `interactions.coverage.test.ts` passes. New controls require specs in the same commit.
- **Platforms:** All.

### FR-CC-004: Event Name Transport

- **Description:** Logical event names use dotted form in `shared/types.ts`. The Rust side MUST translate `.` → `:` when emitting. The JS side MUST translate `:` → `.` when subscribing.
- **Acceptance:** No raw dotted event names are emitted via `app.emit`. All go through `emit_event()`.
- **Platforms:** All.

### FR-CC-005: Per-Webview Isolation

- **Description:** The chrome and content webviews MUST remain isolated. Browsed pages MUST NOT have access to the IPC surface.
- **Acceptance:** `window.aegis` is undefined in the content webview. CSP blocks external resources.
- **Platforms:** All.

### FR-CC-006: Atomic Writes

- **Description:** All persistent stores MUST be written atomically (temp→fsync→rename).
- **Acceptance:** Power loss during a write results in the previous version, not corruption.
- **Platforms:** All.

### FR-CC-007: Zeroize Sensitive Data

- **Description:** All cryptographic keys, master passwords, and DEKs MUST use `Zeroizing` / `ZeroizeOnDrop` to wipe from memory when dropped.
- **Acceptance:** Vault lock wipes the DEK. Sync unlock failure wipes the derived key.
- **Platforms:** All.

---

## 13. Requirement Index

| ID         | Domain   | Title                                |
| ---------- | -------- | ------------------------------------ |
| FR-NAV-001 | Nav      | Navigate to URL                      |
| FR-NAV-002 | Nav      | Back Navigation                      |
| FR-NAV-003 | Nav      | Forward Navigation                   |
| FR-NAV-004 | Nav      | Reload / Stop                        |
| FR-NAV-005 | Nav      | Home Navigation                      |
| FR-NAV-006 | Nav      | Address Bar URL Tracking             |
| FR-NAV-007 | Nav      | Navigation State Events              |
| FR-NAV-008 | Nav      | Failed Navigation                    |
| FR-NAV-009 | Nav      | Crashed Navigation                   |
| FR-TAB-001 | Tabs     | Create Tab                           |
| FR-TAB-002 | Tabs     | Close Tab                            |
| FR-TAB-003 | Tabs     | Activate Tab                         |
| FR-TAB-004 | Tabs     | Reorder Tabs                         |
| FR-TAB-005 | Tabs     | Pin Tab                              |
| FR-TAB-006 | Tabs     | Private Tab                          |
| FR-TAB-007 | Tabs     | Idle Sweep                           |
| FR-TAB-008 | Tabs     | Reopen Closed Tab                    |
| FR-TAB-009 | Tabs     | Session Persistence                  |
| FR-TAB-010 | Tabs     | Tab State Events                     |
| FR-TAB-011 | Tabs     | Tab Title Tracking                   |
| FR-TAB-012 | Tabs     | Mobile Tab Switcher                  |
| FR-TAB-013 | Tabs     | Background Tab Opening               |
| FR-ADB-001 | Adblock  | Ad/Tracker Blocking                  |
| FR-ADB-002 | Adblock  | Platform-Specific Blocking Tiers     |
| FR-ADB-003 | Adblock  | Pop-Under Guard                      |
| FR-ADB-004 | Adblock  | Shield Badge Counter                 |
| FR-ADB-005 | Adblock  | Ad-Block Enable/Disable              |
| FR-ADB-006 | Adblock  | Per-Site Allowlist                   |
| FR-ADB-007 | Adblock  | Filter Subscriptions                 |
| FR-ADB-008 | Adblock  | Custom Filters                       |
| FR-ADB-009 | Adblock  | Per-Tab Content Filters (Linux)      |
| FR-ADB-010 | Adblock  | Ad-Block Injected JS Tier            |
| FR-SEC-001 | Security | HTTPS-Only Upgrade                   |
| FR-SEC-002 | Security | MalwareGuard Blocking                |
| FR-SEC-003 | Security | Redirect Guard                       |
| FR-SEC-004 | Security | Site Permissions                     |
| FR-SEC-005 | Security | Content-Security-Policy              |
| FR-PRI-001 | Privacy  | Anti-Fingerprinting (Farbling)       |
| FR-PRI-002 | Privacy  | Farbling Levels                      |
| FR-PRI-003 | Privacy  | Fingerprint Allowlist Management     |
| FR-PRI-004 | Privacy  | WebRTC IP-Leak Defense               |
| FR-PRI-005 | Privacy  | Private Tab Data Guards              |
| FR-VLT-001 | Vault    | Vault State Query                    |
| FR-VLT-002 | Vault    | Create Vault                         |
| FR-VLT-003 | Vault    | Unlock Vault                         |
| FR-VLT-004 | Vault    | Lock Vault                           |
| FR-VLT-005 | Vault    | List Records                         |
| FR-VLT-006 | Vault    | Add Record                           |
| FR-VLT-007 | Vault    | Update Record                        |
| FR-VLT-008 | Vault    | Remove Record                        |
| FR-VLT-009 | Vault    | Search Records                       |
| FR-VLT-010 | Vault    | Vault State Events                   |
| FR-VLT-011 | Vault    | At-Rest Encryption                   |
| FR-VLT-012 | Vault    | OS-Keychain Anchoring                |
| FR-SYN-001 | Sync     | Enable Sync (New Device)             |
| FR-SYN-002 | Sync     | Enable Sync (From Phrase)            |
| FR-SYN-003 | Sync     | Sync Unlock                          |
| FR-SYN-004 | Sync     | Disable Sync                         |
| FR-SYN-005 | Sync     | Manual Sync                          |
| FR-SYN-006 | Sync     | Background Sync                      |
| FR-SYN-007 | Sync     | Record Merge (HLC-LWW)               |
| FR-SYN-008 | Sync     | Device Management                    |
| FR-SYN-009 | Sync     | Recovery Phrase                      |
| FR-SYN-010 | Sync     | Sync Server (Self-Hosted)            |
| FR-CTX-001 | Content  | Find-in-Page (Start)                 |
| FR-CTX-002 | Content  | Find-in-Page (Platform Capabilities) |
| FR-CTX-003 | Content  | Find-in-Page (Next/Prev)             |
| FR-CTX-004 | Content  | Find-in-Page (Close)                 |
| FR-CTX-005 | Content  | Page Zoom (Set)                      |
| FR-CTX-006 | Content  | Page Zoom (Reset)                    |
| FR-CTX-007 | Content  | Page Zoom (Get)                      |
| FR-CTX-008 | Content  | Proxy (Set Config)                   |
| FR-CTX-009 | Content  | Proxy (Clear)                        |
| FR-CTX-010 | Content  | Proxy (Test Connection)              |
| FR-CTX-011 | Content  | Element Picker                       |
| FR-DAT-001 | Data     | Favorites (Add)                      |
| FR-DAT-002 | Data     | Favorites (Update)                   |
| FR-DAT-003 | Data     | Favorites (Remove)                   |
| FR-DAT-004 | Data     | Favorites (Reorder)                  |
| FR-DAT-005 | Data     | Saved Items (Add)                    |
| FR-DAT-006 | Data     | Saved Items (Tag Management)         |
| FR-DAT-007 | Data     | Saved Items (Remove)                 |
| FR-DAT-008 | Data     | Saved Items (Check)                  |
| FR-DAT-009 | Data     | History (Record)                     |
| FR-DAT-010 | Data     | History (Search)                     |
| FR-DAT-011 | Data     | History (Remove / Clear)             |
| FR-DAT-012 | Data     | Downloads (List / Remove / Clear)    |
| FR-DAT-013 | Data     | Downloads (Open / Show)              |
| FR-DAT-014 | Data     | Data Export                          |
| FR-DAT-015 | Data     | Data Import                          |
| FR-UI-001  | UI       | Settings Modal                       |
| FR-UI-002  | UI       | Theme (Dark / Light / System)        |
| FR-UI-003  | UI       | Onboarding                           |
| FR-UI-004  | UI       | Favorites Bar                        |
| FR-UI-005  | UI       | Sidebar                              |
| FR-UI-006  | UI       | Shield Popover                       |
| FR-UI-007  | UI       | Fullscreen                           |
| FR-UI-008  | UI       | Auto-Open Blocked Redirect           |
| FR-UI-009  | UI       | Find Bar                             |
| FR-UI-010  | UI       | Zoom Indicator                       |
| FR-UI-011  | UI       | Split View                           |
| FR-UI-012  | UI       | Workspaces                           |
| FR-UI-013  | UI       | Responsive Desktop Shell             |
| FR-UI-014  | UI       | Mobile Shell                         |
| FR-UI-015  | UI       | Auto-Update                          |
| FR-UI-016  | UI       | Downloads Modal                      |
| FR-CC-001  | CC       | IPC Contract Integrity               |
| FR-CC-002  | CC       | Autopilot Catalog Coverage           |
| FR-CC-003  | CC       | Interaction Spec Coverage            |
| FR-CC-004  | CC       | Event Name Transport                 |
| FR-CC-005  | CC       | Per-Webview Isolation                |
| FR-CC-006  | CC       | Atomic Writes                        |
| FR-CC-007  | CC       | Zeroize Sensitive Data               |

**Total: 113 functional requirements** across 10 domains + cross-cutting.
