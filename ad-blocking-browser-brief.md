# Product Brief: a desktop ad-blocking browser (working title: "Aegis")
### A desktop web browser with the Universal Wrapper UI shell + built-in, uBlock-grade ad & tracker stripping

> **How to use this document:** It is a self-contained product brief. Hand it to an AI coding agent or a human team to build the app — no access to the Universal Wrapper repository is required. Where Universal Wrapper (UW) is referenced, it is as prior art and as the source of the carried-over UI shell, not as a dependency. The tech stack is intentionally left open; named technologies are **examples only**.

---

## 1. Product summary

**Aegis** is a cross-platform desktop web browser that pairs a clean, focused browsing chrome with aggressive, always-on ad and tracker blocking. It reuses the proven, browser-like UI shell of the Universal Wrapper project — a single address/search bar, a favorites quick-launch bar, an auto-recorded history timeline, a manually curated saved-pages list, and light theming — but replaces Universal Wrapper's proxied-iframe content area with a **real embedded browser engine (webview)** that renders sites directly as their true origin. Because pages load natively, none of Universal Wrapper's proxy, anti-frame, anti-bot, Cloudflare-mitigation, subdomain-routing, or two-origin CSRF machinery is needed or present. The headline feature is **full uBlock-style content filtering**: network-level request blocking from standard, auto-updating filter lists; cosmetic DOM element hiding; and anti-adblock circumvention — all enforced in the browser engine itself. It is for privacy-minded users who want a no-friction, "ads are gone by default" browsing experience on the desktop without installing or configuring extensions.

---

## 2. Goals & non-goals

### Goals
- Deliver a familiar, minimal browser shell (address bar, navigation controls, favorites, history, saved lists, theming, settings) that feels instantly usable.
- Render any website **directly** in a real, sandboxed browser engine — the app *is* the origin it loads.
- Block ads, trackers, and analytics by default with a real, uBlock-grade filter engine: network blocking + cosmetic hiding + anti-adblock defeat.
- Keep filter lists current automatically and let power users tune them (subscriptions, allowlist, per-site toggle, custom rules).
- Persist favorites, history, and saved lists locally with no server dependency.
- Run on Windows, macOS, and Linux from a single codebase.

### Non-goals (explicit)
- **Not a proxy / not a MITM.** No server fetches pages on the user's behalf; no HTML/JS/header rewriting in transit. Pages load over the user's own network connection through the engine.
- **No anti-bot / anti-frame / Cloudflare bypass.** The app does not defeat bot challenges, spoof `window.location`, or impersonate hostnames. Sites that block automation or geographic regions are out of scope — the browser presents itself honestly.
- **No iframe-embedding / URL-rewriting tricks.** No `_px_host` URL wrapping, no subdomain routing, no `directHosts`/`clearanceHosts`/`streamExtractHosts`, no served-as-real-host TLS, and no `postMessage` address-bar bridge. The webview exposes navigation state natively.
  - *Clarification:* Aegis **does** inject content scripts into pages — that is exactly how cosmetic filtering and anti-adblock work (§4.2–4.3). What's dropped is UW's cross-origin **read-bridge** (the `proxy-client.js` + `postMessage` scheme that existed only because a proxied iframe was cross-origin and unreadable). A real webview is readable/controllable by the host directly, so the bridge disappears — content-script injection for filtering stays.
- **No mandated tech stack.** Candidate technologies throughout are illustrative only (see §5).
- **Not (initially) a multi-account sync product.** Auth and server-backed per-user sync are deferred; data is local. A sync backend is a clearly-marked future option (§6), not a launch requirement.
- **Not a full Chrome replacement.** No extension store, no DevTools parity, no enterprise policy management at launch. The scope is "a fast, clean, ad-free single/light-tab browser."

---

## 3. Core experience / user-facing features

The content area is a **real webview**, not a proxied iframe. Everything below is the user-facing chrome carried over (and adapted) from Universal Wrapper's shell.

### 3.1 Address / search bar
A single text input that smart-parses what the user types:
- A bare term with no dot/scheme (e.g. `weather`) becomes a **search query** routed to the configured default search engine (DuckDuckGo by default; configurable — see §3.9).
- Input with a host but no scheme (e.g. `example.com`) gets `https://` prepended.
- A full URL navigates directly.

The bar always displays the **real current URL of the page**, read straight from the webview's navigation state (§3.2). Submitting re-navigates; submitting the URL that's already loaded triggers a genuine reload.

### 3.2 Navigation controls (reworked for a real webview)
Universal Wrapper had *no* back/forward/stop buttons — it re-pointed a single iframe and synced the URL bar via a cross-origin `postMessage` bridge. A real webview exposes its own navigation API and events, so Aegis adds **genuine controls**:
- **Back / Forward** — wired to the webview's history navigation, enabled/disabled based on whether back/forward history exists.
- **Reload / Stop** — a single toggle: reload when idle, stop when a load is in progress.
- **Home** — a clickable logo/site-name that navigates to the configured home/default URL.
- **Loading indicator** — driven by the webview's real start-/stop-loading signals (no imperative spinner hack, no iframe-key remount).

The address bar, page title, and history stay in sync via the webview's **native navigation events** — replacing Universal Wrapper's entire `postMessage` + trust-boundary + origin-validation bridge, which existed only because the proxied iframe was cross-origin and unreadable.

> **Engine-agnostic note:** Wherever this brief names specific events or APIs (e.g. `did-navigate`, `did-navigate-in-page`, `page-title-updated`, `did-fail-load`, `goBack()`/`canGoBack`), treat them as **Electron/Chromium examples**. Every mainstream webview host exposes equivalent navigation-start/commit/in-page-navigation/title-changed/load-failed signals and back/forward APIs; bind to whichever your chosen engine provides.

> **Tabs:** Multi-tab is a candidate enhancement. v1 may ship single-view to keep scope tight; the navigation model (per-view back/forward/reload state) should be designed so adding tabs later is additive, not a rewrite. Decide explicitly in design (§9).

### 3.3 Favorites (quick-launch bar + manager)
- A horizontal **favorites bar** of clickable chips beneath the address bar; clicking one navigates.
- A **Favorites manager** for full CRUD: name, URL, and a **freeform tag editor** with autocomplete.
- **Tag filtering:** a chip row filters the favorites bar and manager by tag.
- **Global tag operations:** rename or delete a tag everywhere it's used.
- (Carried over from Universal Wrapper's `FavoritesModal` + `TagInput`/`TagFilter` + favorites-bar pattern; freeform tags on bookmarks are a worthwhile differentiator.)

### 3.4 History (auto-recorded timeline)
- Every navigation is recorded automatically to a **browsing-history timeline** (URL, title, timestamp).
- **Dedup:** a repeat of the most-recent entry refreshes it rather than appending. A new URL records immediately; same-URL title changes (common with late-rendering SPA titles) are coalesced via a **short debounce** (tune to taste — UW used ~3s for iframe `document.title` churn; with native title-changed events you can keep it small) to one trailing write.
- **Trim:** capped at a maximum (e.g. 500 most-recent) to bound storage.
- A history view (sidebar/panel) lists entries with localized timestamps, **click-to-revisit**, **per-row remove**, **Clear all**, and a **search box**.

### 3.5 Saved content list (manual)
- A user-curated, manually-saved list of pages, distinct from auto-history.
- Add the current page from the toolbar (a bookmark/"+" button that **fills in** when the current page is already saved) or via a manual add form (URL + title).
- The list view supports **click-to-open**, **inline rename**, **search**, and **per-row delete**.

### 3.6 Theming & branding
- **Accent color** (a single primary color) applied app-wide as a CSS custom property (buttons, active states, logo).
- **App/site name** drives the logo text and window-title affordances.
- **Default / home URL** is the startup page.
- Light UX toggles (e.g. hide-chrome-by-default for a distraction-free mode) carry over where they still make sense.

### 3.7 Settings
A consolidated settings surface covering: default search engine (§3.9), home URL, theme/accent color, ad-blocking controls (§4), site permissions (§3.9), downloads location (§3.9), and data management (clear history, export/import favorites). Settings are stored **locally** (see §6).

### 3.8 Supporting chrome (carried over, engine-agnostic)
- **Toasts + confirm dialogs** — an imperative, in-app toast/confirm system replacing native `alert`/`confirm`, with accessible roles (`aria-live`, focus-trapped confirm dialog).
- **First-run welcome hint** — dismissed once, persisted locally.
- **Error surface** — a clean, recoverable error overlay for failed loads (load-failed events), with retry/home actions, modeled on Universal Wrapper's `ProxyErrorOverlay` copy/icon pattern (minus proxy-specific error types).
- **Crash-safe app boot** — restore last-visited URL/title and user settings on startup with defensive, crash-safe local reads; an app-level error boundary instead of a blank window.
- **Accessibility plumbing** — focus traps, Escape-to-close, focus restore, and a "skip to content" affordance, reused from Universal Wrapper's `useDialog` patterns.

### 3.9 Browser essentials (new — things the iframe-proxy never owned)
A real browser engine takes on responsibilities UW's proxied iframe never had. Scope these explicitly:
- **Downloads & file handling.** Intercept download requests; present a save dialog (honoring a configurable default download directory) and a lightweight downloads list/indicator. Handle native PDF viewing and inline media playback. Decide the policy for `blob:`/`data:` downloads.
- **Site permission prompts.** Arbitrary sites will request camera, microphone, geolocation, notifications, clipboard, and similar capabilities. Provide a permission-prompt UX with **deny-by-default** and per-site remembered choices, surfaced and revocable in Settings. (This is a real-browser concern with no UW equivalent.)
- **Custom search engines.** Ship a few presets (DuckDuckGo default, plus e.g. Google/Bing/Brave) and let users add a custom engine via a query template (`https://example.com/search?q=%s`). The default drives bare-term address-bar searches (§3.1).
- **New windows / target=_blank / popups.** Use the engine's new-window controls to route or block popups (see §4.3); intentional new windows open as a new tab (if tabs ship) or in-place.

### 3.10 Dropped from Universal Wrapper
The following are proxy/server-specific and have **no place** in this app: the Admin Observability dashboard and all metrics panels; the direct-host SSE provisioning pipeline (cert/TLS/DNS/Tailscale/Cloudflare-solve); the Cloudflare check and host-suggestion tools; user management; the HLS-via-backend-manifest stream player; and the entire JWT-bearer/`/api/wrapper/*` remote-backend auth layer (deferred to a possible future sync option, §6).

---

## 4. Ad & tracker stripping (headline feature)

Aegis ships **uBlock Origin-class** content filtering, on by default. It is delivered in three layers, all enforced **inside the browser engine** (not via a proxy).

> **Prior art (Universal Wrapper):** UW already proves three of the right *concepts* — a network-blocking decision layer, a filter-list fetch/parse/index/cache pipeline, and anti-adblock JS stubs. But UW's network blocking is **proxy-coupled** (it returns HTTP 204 before an upstream fetch), its parser supports only a **small slice** of Adblock Plus syntax (no `$`-options, no `@@` exceptions, no procedural cosmetics, no scriptlets), and its **cosmetic layer is wired but disabled**. Aegis keeps the *shape* and *intent* but replaces the engine with a real one.

### 4.1 Layer 1 — Network request blocking
- The browser intercepts **every outbound network request** from a page (documents, scripts, XHR/fetch, images, media, beacons) before it goes out, and **cancels** requests that match a block rule.
- Matching is done by a **real filter engine** that compiles standard filter lists into an indexed matcher supporting the **full network grammar**: `||domain^` anchors, hosts-format entries, `$`-option modifiers (`$third-party`, `$script`, `$image`, `$xmlhttprequest`, `$domain=`, `$redirect`, etc.), and **`@@` exception/allowlist** rules.
- **Do not** extend UW's hand-rolled parser. Adopt a proven engine (see §5) that already implements this grammar.
- **Interception API choice matters.** Prefer a **blocking request-interception hook** (e.g. Chromium's blocking `webRequest`, or the engine's equivalent cancel-before-send hook). **Avoid relying solely on a declarative/MV3-style `declarativeNetRequest` ruleset** — its rule-count caps and inability to run dynamic logic mean it *cannot* reach uBO-grade blocking. If you target a host where blocking `webRequest` is unavailable, document the resulting limitations explicitly.
- No app-specific media/host allowlist is hardcoded (UW's per-site streaming exemptions were proxy-streaming workarounds and must **not** carry over).

### 4.2 Layer 2 — Cosmetic DOM element hiding
- For each page, the engine resolves the applicable **cosmetic filters** (generic + per-host CSS selectors, minus exceptions) and injects them as a **content script / user stylesheet at document-start**, so ad placeholders and containers are hidden before paint (no flash of ad content).
- Supports **procedural cosmetics** (e.g. `:has()`-style and other uBO procedural operators) where the chosen engine provides them.
- This is **on by default** — explicitly fixing UW's disabled cosmetic layer.

### 4.3 Layer 3 — Anti-adblock circumvention
- Inject a content script that **stubs anti-adblock and tracker globals** so detector scripts believe ads loaded and pages don't break — e.g. no-op `adsbygoogle.push`, `adBlockerDetected = false`, `isAdBlockActive = false`, and no-op analytics shims (`ga`/`gtag`/`dataLayer`/`_gaq`/`fbq`, etc.).
- **Neutralize popunders / forced new-tab ads:** intercept new-window/`window.open` requests and strip/ignore `target="_blank"` ad redirects, converting hostile new-window attempts into in-place navigation or outright blocks (using the engine's new-window / will-navigate controls).
- **Apply scriptlet (`##+js`) injections** from filter lists where the chosen engine supports them — the modern way lists neutralize specific anti-adblock scripts.
- (UW's `adblock-helper.js` stubs and `proxy-client.js` `window.open`/`target=_blank` kill are directly portable in spirit as injected content scripts.)

### 4.4 Filter-list sourcing & updating
- Ship sensible defaults: **EasyList**, **EasyPrivacy**, **uBlock Origin's own filter lists** (uBO filters / uBO privacy / uBO badware / uBO unbreak / uBO quick-fixes), and a domain blocklist (e.g. Peter Lowe's list), plus the engine's cosmetic/scriptlet resource lists. (uBO's own lists are where much of the modern cosmetic + scriptlet coverage lives — don't omit them.)
- **Fetch over HTTPS on first run and refresh on a schedule** (e.g. every 24h), with an **atomic on-disk cache** (temp-write + rename), a **per-source size cap**, and **cache-fallback** if a fetch fails — mirroring UW's sound `listManager` model.
- Allow **list subscriptions:** users can add/remove list URLs and toggle bundled lists.

### 4.5 User-facing controls (new — UW had essentially none)
UW exposed only an `extraBlocklist` substring array (empty by default). Aegis ships the controls uBO users expect:
- **Global on/off** for ad-blocking.
- **Per-site enable/disable** + **allowlist** (one click to "allow ads on this site" — the primary escape hatch when blocking breaks a page; see §7).
- **List manager:** subscribe/unsubscribe, see last-updated time, force-update.
- **My filters:** a free-text box for custom rules (network + cosmetic).
- **Element picker** (stretch): point-and-click to author a cosmetic hide rule for the current page.
- **Blocked-count indicator:** a per-page badge showing how many requests/elements were blocked, plus a session/total counter — immediate, satisfying feedback that the feature is working.

### 4.6 Engine integration summary
`user types URL → webview navigates → for each outbound request, the filter engine matches (block or allow) → matched requests are cancelled → at document-start, cosmetic CSS + anti-adblock + scriptlet content scripts are injected → the page renders ad-free → the UI shell reads the real title/URL from native nav events and updates the blocked-count badge.`

---

## 5. Architecture

**Stack-agnostic.** Aegis is a desktop application composed of four cooperating parts. Candidate technologies are **examples only** — pick per platform/skill constraints.

### 5.1 Components

1. **UI shell (chrome process)** — renders the address bar, navigation controls, favorites bar, history/saved-list panels, settings, toasts, and theming. This is the carried-over Universal Wrapper shell, decoupled from any proxy logic.
   - *e.g.* a web-tech UI (React/Vite-style) hosted in the desktop runtime's main window, **or** native UI widgets.

2. **Embedded webview(s) (content process)** — one or more real browser-engine views that render target sites as their genuine origin, sandboxed from the host. Exposes native navigation events and a request-interception hook.
   - *e.g.* an Electron webview / `BrowserView` / `WebContentsView` (Chromium), Tauri's webview, a CEF host, or platform WebView2 (Windows) / WKWebView (macOS) / WebKitGTK (Linux). The choice drives §7's interception/permission tradeoffs.

3. **Ad-filter engine** — compiles filter lists into an indexed matcher and answers "block this request?" and "what cosmetic rules apply to this host?" per navigation. Owns list fetching/refresh/caching.
   - *e.g.* a mature library such as **`@ghostery/adblocker`** (the engine lineage behind Brave-style matching) or **`@cliqz/adblocker`**, which ingest EasyList/uBO lists and support `$`-options, allowlisting, cosmetics, and scriptlets, and bind cleanly to a Chromium blocking-`webRequest` hook. On non-Chromium hosts, an equivalent content-filter / URL-scheme-handler API plus the same engine's matching core.

4. **Local persistence** — favorites, history, saved lists, settings, and filter-list/subscription state.
   - *e.g.* embedded **SQLite** (optionally via an ORM), or a structured local store. No network/server required.

### 5.2 Data flow (single navigation)

```
[Address bar submit]
      │  normalize input (search vs URL, add https://)
      ▼
[Webview navigate(target)]
      │  load-start signal ───────────────► UI: show loading state
      │
      ├─ for each outbound request:
      │     filterEngine.match(request) ──► block? → cancel  (++blockedCount)
      │                                     allow? → proceed
      │
      ├─ at document-start (per frame):
      │     inject cosmetic CSS (filterEngine.getCosmeticsForHost)
      │     inject anti-adblock + scriptlet content scripts
      │
      │  navigation-commit / title-changed ─► UI: update address bar + title,
      │                                        record history (dedup+trim),
      │                                        update bookmark-filled state
      │  load-stop signal ──────────────────► UI: clear loading, show blocked-count
      │  load-failed signal ────────────────► UI: error overlay (retry/home)
```

*(Event names above are conceptual; map them to your engine's actual signals — see §3.2.)*

### 5.3 Process & security boundaries
- The webview runs in a **separate, sandboxed process** with no privileged access to the host or to Node/OS APIs. The UI shell communicates with it only through a **narrow, typed IPC surface** (navigate, back/forward, reload/stop, subscribe to nav events, fetch blocked-count).
- The filter engine runs in/alongside the privileged process (it needs request-interception registration) but treats list content and page-origin data as **untrusted input**.
- No remote-content code ever runs with host privileges (see §7).

---

## 6. Data model & persistence

All data is stored **locally** (e.g. a single SQLite database in the app's data directory). No account or server is required at launch. The model preserves Universal Wrapper's clean separation of concerns: **settings vs. favorites vs. history vs. saved-list are distinct stores.**

| Store | Fields (representative) | Notes |
|---|---|---|
| **Favorites** | `id`, `name`, `url`, `tags` (string list) | Tags are freeform; support tag filter + global rename/delete. |
| **History** | `id`, `url`, `title`, `timestamp` | Auto-recorded; **dedup** against most-recent entry; **trim** to a max (e.g. 500). |
| **Saved list** | `id`, `url`, `title`, `timestamp` | Manual; distinct from auto-history. |
| **Settings / theming** | `siteName`, `defaultUrl` (home), `primaryColor`, `searchEngines` + default, `downloadDir`, UX toggles | Collapsed from UW's per-user `UserConfig` into a single local settings object. |
| **Site permissions** | `origin`, `permission`, `decision` (allow/deny) | Per-site remembered camera/mic/geo/notification choices (§3.9). |
| **Ad-block config** | `enabled` (global), `allowlist` (host list), `perSiteOverrides`, `customFilters` (text) | Replaces UW's lone `extraBlocklist` array. |
| **Filter-list subscriptions** | `listId`/`url`, `enabled`, `lastUpdated`, `etag`/`hash`, cached payload ref | Drives fetch/refresh/cache (atomic write, size cap, fallback). |

### Future sync option (explicitly out of v1 scope)
The schema is intentionally compatible with a future, **optional** sync backend: a `User`/account layer plus a server that mirrors favorites/history/saved-list/settings would slot in behind the same local stores (write-through cache pattern). Universal Wrapper's per-user `UserConfig` + JWT-bearer model is the reference design if that path is ever taken — but it is **not** built now, and the app must be fully functional offline and account-less.

---

## 7. Constraints, edge cases & risks

- **Webview engine choice & cross-platform support.** A single embedded Chromium (Electron/CEF/WebView2) gives one consistent rendering + interception model but a larger binary; using each OS's native webview (WebView2/WKWebView/WebKitGTK) shrinks the binary but means **three different request-interception/content-filter/permission APIs** and rendering quirks. Decide early; the filter engine's *matching core* should stay engine-portable even if the *interception glue* differs per platform.
- **Filter-list licensing & attribution.** EasyList/EasyPrivacy/uBO lists carry licenses (typically CC/GPL-style) and attribution/update expectations. Bundle and update them per their terms; surface list provenance in the UI.
- **Sites that break when ads are blocked.** Some sites gate content behind ad/anti-adblock walls or genuinely break on aggressive cosmetic hiding. The **per-site allowlist is the critical escape hatch** — it must be one click from the toolbar, obvious, and reversible. Consider a "page looks broken? allow ads here" affordance on the error/empty-state surface.
- **Anti-adblock arms race.** Detector scripts evolve; static global stubs decay over time. Mitigate by (a) relying on community scriptlet (`##+js`) lists maintained upstream, (b) keeping lists auto-updated, and (c) treating the bundled anti-adblock stubs as a floor, not the whole defense. 100% coverage on hostile sites is not achievable.
- **Performance with large filter lists.** Combined EasyList+EasyPrivacy+uBO lists are large; naive matching per request is too slow. Rely on the engine's **precompiled, indexed matcher** (serialized to disk so startup doesn't re-parse from source), and keep cosmetic resolution per-host cheap. Watch memory: UW capped sources at 64MB and used atomic disk caches — keep equivalent bounds.
- **Security of loading arbitrary sites in a real engine.** This is the biggest new risk vs. the old iframe-proxy. The webview **must** be sandboxed: no Node/host integration in content, context isolation on, a strict IPC allowlist, and careful handling of new-window/downloads/permission prompts (camera/mic/geolocation/notifications — §3.9). Treat every loaded page as hostile. Keep the embedded engine **patched/updated** — shipping an out-of-date Chromium is a standing CVE exposure.
- **Navigation correctness.** SPA in-page navigations, `replaceState`, hash changes, and late-rendering titles must all reflect in the address bar/history via native events. (UW solved this with a fragile `postMessage` bridge; native in-page-navigation + title-changed events are the correct, simpler replacement — still apply a short same-URL title debounce to absorb `document.title` churn.)
- **Downloads, file dialogs, PDFs, media.** A real browser must handle these (§3.9) — all things the iframe-proxy never owned. Scope them explicitly rather than discovering them late.
- **No automation/bypass guarantees.** Because the app loads sites honestly (no anti-bot defeat), some sites that worked through UW's proxy (Cloudflare-gated, host-locked) may behave differently. This is an accepted consequence of the §2 non-goals.

---

## 8. Success criteria (testable)

1. **Navigation works like a browser.** Back, Forward, Reload, Stop, and Home each perform the correct webview action and reflect correct enabled/disabled state; the address bar shows the real current URL after every navigation, including SPA in-page navigations.
2. **Smart address bar.** A bare term performs a search via the default engine; a schemeless host loads over `https://`; a full URL loads as-is. Re-submitting the current URL reloads the page.
3. **Ads are gone by default.** On a representative set of ad-heavy sites, network ad/tracker requests are blocked (verifiable via the blocked-count badge and engine logs) and visible ad slots are hidden with no flash of ad content before paint.
4. **Anti-adblock pages still work.** On sites with adblock detectors, content remains accessible (no "disable your ad blocker" wall) for a representative sample.
5. **Lists update.** Default lists fetch on first run and auto-refresh on schedule; a manual "update now" works; the app still functions (using cache) when offline or when a fetch fails.
6. **User controls function.** Global toggle, per-site allowlist, list subscribe/unsubscribe, and custom filters all take effect on the next navigation; allowlisting a site restores its ads and unblocks gated content.
7. **Data persists locally.** Favorites (with tags), history (deduped, trimmed to the max), saved list, settings, and per-site permissions survive an app restart with no server and no network.
8. **Theming applies.** Changing accent color and site name updates the chrome live; the home URL governs startup and the Home button.
9. **Browser essentials work.** Downloads save to the configured location with a visible indicator; PDFs and media play; permission prompts default to deny and remember per-site choices; popups are routed/blocked per §4.3; custom search engines can be added and set as default.
10. **Resilience.** A failed page load shows a recoverable error surface (retry/home), not a blank window; an unexpected UI error is caught by an error boundary; the app restores the last session on relaunch.
11. **Security posture verified.** The content process has no host/Node privileges; loading a known-malicious test page cannot reach the filesystem or app internals; the embedded engine version is current.
12. **Cross-platform.** The app builds and runs with feature parity on the targeted desktop OSes.
13. **No proxy artifacts.** No `_px_host`/subdomain URL rewriting, no `postMessage` address-bar bridge, no hardcoded site allowlist, and no admin/observability/host-provisioning UI exist anywhere in the product.

---

## 9. Suggested build phases

**Phase 0 — Shell + webview navigation (foundation).**
Stand up the desktop app, embed a sandboxed webview, and port the UI shell (address bar, Home/logo, loading state). Wire real Back/Forward/Reload/Stop and address-bar/title sync from **native navigation events**. Decide single-view vs. multi-tab here. *Exit:* you can browse the web in a sandboxed, branded window with working nav.

**Phase 1 — Network ad-blocking.**
Integrate the filter engine; load default lists (EasyList/EasyPrivacy/uBO/domain list); hook **blocking** request interception to cancel blocked requests; add the blocked-count badge. Implement list fetch + scheduled refresh + atomic disk cache + fallback. *Exit:* network ads/trackers are blocked by default and counted.

**Phase 2 — Cosmetic hiding + anti-adblock.**
Inject per-host cosmetic CSS (and procedural cosmetics) at document-start; inject anti-adblock global stubs + scriptlets; neutralize popunders/forced new-tabs. *Exit:* ad slots are hidden cleanly and adblock-detector sites remain usable.

**Phase 3 — Favorites, history, saved lists.**
Build the local persistence layer (e.g. SQLite) and the favorites bar + manager (with tags + global tag ops), the auto-history timeline (dedup + trim + search + revisit), and the manual saved list. *Exit:* user data persists locally across restarts.

**Phase 4 — Theming, settings & ad-block controls.**
Settings surface: accent color, site name, home URL, search engines, downloads location, data management. Ad-block controls: global toggle, per-site allowlist, list manager, my-filters box. *Exit:* the product is fully configurable without code.

**Phase 5 — Browser essentials + polish.**
Downloads/PDF/media handling, site-permission prompts (deny-by-default + remembered), custom search engines, popup routing. Then: toasts/confirm system, first-run welcome hint, error overlay + boundary, session restore, accessibility (focus traps, skip-to-content, keyboard nav), and the element-picker stretch goal. Cross-platform builds and the security audit (sandbox verification, engine update policy). *Exit:* ship-ready, meets the §8 success criteria.

---

*This brief is self-contained: it can be handed to an AI coding agent or a human team without access to the Universal Wrapper repository. Where Universal Wrapper is referenced, it is as prior art and as the source of the carried-over UI shell — not as a dependency.*
