# Mobile tabs / tab switcher (design spec)

- **Date:** 2026-06-15
- **Status:** Approved (brainstorming). Next: implementation plan.
- **Sub-project:** First of the two follow-ons to the mobile-friendly UI
  ([[aegis-mobile-ui]]). **Touch gestures** (swipe-back/forward, pull-to-refresh,
  swipe-between-tabs) are the separate next sub-project and are out of scope here.

## 1. Goal

Give Android real multi-tab browsing with **live tabs** — each tab is its own native
`WebView`, so switching back resumes exactly where you left off (scroll, playing
video, typed forms) — plus a **tab switcher** to see/create/close/switch tabs. The
desktop tab model already exists; this brings it to mobile.

## 2. Target & current state

- **Target:** Android (the only running mobile path; iOS is blocked on macOS/Xcode).
- **Current:** `tab_registry.rs` (pure, unit-tested) fully models tabs
  (create/activate/close/reopen/reorder/pin/back-forward/idle-sweep/restore) and
  `tabs.*` IPC reaches it on **all** platforms including Android. But Android is
  **single-WebView**: `nav::spawn_tab` is a `#[cfg(mobile)]` no-op, `MainActivity`
  creates exactly **one** native `WebView`, and `MobileApp` drives it via
  `useNav(PRIMARY_VIEW_ID)` — it does not use the registry or render any tab UI.
  Navigation loads URLs into that one WebView in place. So the **model is ready**;
  the **native multi-WebView + mobile tab UI** is what's missing.

## 3. Non-goals (this sub-project)

- **Touch gestures** (swipe-back/forward, pull-to-refresh, swipe-between-tabs) —
  the next sub-project. Tab switching here is via the switcher list + the Tabs button.
- **Card/thumbnail switcher** — the switcher is a vertical **list** (no per-tab
  screenshot capture).
- **Desktop changes** — desktop tabs/chrome stay untouched.
- **iOS.**

## 4. Architecture

The **chrome coordinates; the registry is the model; native owns the per-tab Webviews.**

- **The registry is unchanged.** `tab_registry.rs` already returns every lifecycle
  decision; `tabs.*` IPC + the Rust `start_idle_sweep` thread already run on Android
  (they just drive no native views today).
- **The chrome** switches `MobileApp` from `useNav(PRIMARY_VIEW_ID)` to **`useTabs()`
  + `useNav(activeId)`** — the same hooks desktop uses. Every chrome feature (address
  bar, ad-block shield, overlays) keys on the **active tab id**.
- **Native owns the WebViews.** Rust cannot touch native Android views, so
  `MainActivity` keeps a **`Map<tabId, WebView>`** and the chrome drives that map
  through new `AegisAndroid` bridge calls as the registry state changes. The
  registry decides *what* the tabs are; the chrome *relays* those decisions to native.

*(Alternatives rejected: a single WebView that reloads on switch — loses live state,
the user explicitly chose live tabs; managing native WebViews from Rust — impossible,
Rust has no handle to the Android views.)*

### 4.1 New / changed units

- **Native:** `MainActivity` gains a `tabId → WebView` map + the lifecycle bridge
  methods (§5). The single-WebView assumptions become per-tab.
- **Chrome (`src/components/mobile/`):**
  - `MobileTabSwitcher` — the full-screen switcher sheet (vertical list).
  - `MobileBottomBar` — reworked slots (§6).
  - `MobileMenuSheet` — reworked items (§6).
  - `MobileApp` — rewired from single-view to `useTabs` + `useNav(activeId)`, owns
    the switcher open/close state, and runs the **diff-and-sync** effect that drives
    the native bridge from the tabs state (§7).
  - A small **`useMobileTabSync`** hook (or an effect in `MobileApp`) that diffs the
    tabs state and calls the bridge — kept isolated so it's understandable/testable.

## 5. Native changes (`MainActivity.kt`)

`MainActivity` keeps `private val tabs = mutableMapOf<Int, WebView>()` and
`activeTabId`. New `AegisAndroid` bridge methods (UI-thread):

1. **`activateTab(id, url)`** — if `tabs[id]` is absent, create a `WebView` (apply the
   same settings/UA, its **own** `WebViewClient`, the shared `WebChromeClient`, the
   content margins), add it to the content `FrameLayout`, and load `url`. Then set
   `activeTabId = id`, show that WebView and **hide all others**. Handles both
   switching and re-creating a discarded tab.
2. **`closeTab(id)`** — destroy + remove `tabs[id]` (forget it).
3. **`discardTab(id)`** — destroy `tabs[id]`'s WebView but treat the tab as still
   existing (idle-sweep); a later `activateTab(id, url)` recreates it.
4. **`navigate(url)` / `back()` / `forward()` / `reload()`** now target the **active**
   tab's WebView (via `activeTabId`), replacing the single-WebView versions.
5. **Per-WebView `WebViewClient`** so each tab has its **own** `currentPageUrl` (the
   ad-block first-party context — today a single field) and pushes nav-state **carrying
   its own tab id** (not a hardcoded `1`), so `useNav(activeId)` filters correctly.
6. **`target=_blank` / `window.open`** → open a new **background** tab: the
   `WebChromeClient.onCreateWindow` asks the chrome to create a tab (via a
   bridge→chrome call or by routing the URL through `tabs.create`), mirroring desktop's
   `on_new_window`/`open_background`.
7. **Memory:** only the active WebView is shown; background tabs are hidden, and the
   registry's existing **time-based idle-sweep** discards them (chrome relays to
   `discardTab`). Reuses the existing Settings idle-timeout. If needed, cap the number
   of simultaneously-live WebViews (discard the least-recently-active beyond the cap).

The existing `setContentHidden` (overlay) and the inset/margin logic (`applyContentMargins`,
`setBottomBarHidden`, `setFullscreen`, the `--aegis-inset-*` push) apply to the **active**
WebView.

## 6. Chrome UI

- **Bottom bar** → `[Saved, History, Tabs(count), Shield, Menu]`.
  - Back/Forward **leave** the bar (touch gestures will own them next sub-project).
  - **Saved** and **History** promote from the ☰ menu onto the bar.
  - **Tabs** shows the **open-tab count** and opens `MobileTabSwitcher`.
  - Shield and Menu unchanged.
- **☰ Menu drawer (`MobileMenuSheet`)** → `Back, Forward, Home, Bookmark this page,
  Downloads, Settings`.
  - Back/Forward added as the **just-in-case fallback** (gestures are primary).
  - Saved/History **removed** (now on the bar); Home stays here.
- **`MobileTabSwitcher`** — a full-screen sheet (reusing `MobileSheet`):
  - A **vertical list** of tabs, each row: favicon (or a globe placeholder) + page
    **title** (host fallback) + a **close (×)** button. The active tab is highlighted.
  - A **+ New tab** button (header or a pinned footer row).
  - Tap a row → switch to that tab + close the switcher. Close (×) → `tabs.close`.
  - All actions go through `useTabs` → `tabs.*` (no new IPC contract).
  - Opening the switcher is a chrome overlay → `view.setChromeOverlay` lowers the
    active native WebView (existing mechanism); native **Back** closes it (extend the
    existing `__aegisMobileBack` precedence: sheet/switcher → fullscreen → page-back).

## 7. Data flow & coordination

- **Tab list/state** → `useTabs()` (the `tabs.*` IPC + `tabs.onState` event), exactly
  as desktop. `TabsState` already carries per-tab `{id, pinned, live, title, url}`.
- **Driving native from state (the crux)** — a diff-and-sync effect/hook compares the
  latest tabs state to what native currently has and calls the bridge:
  - active id changed → `activateTab(activeId, activeUrl)`.
  - a tab disappeared from the list → `closeTab(id)`.
  - a tab went `live: true → false` (idle-swept by the Rust thread) → `discardTab(id)`.
  - a brand-new active tab with no native WebView → `activateTab` lazily creates it.
- **Per-tab navigation** → `useNav(activeId)`; on Android `nav.*` routes to the bridge,
  which targets the active WebView. Nav-state events carry the tab id; `useNav(activeId)`
  reacts only to its own id (the mobile `__aegisNavState` path must pass the `viewId`
  through to subscribers so the filter works with multiple tabs).
- **No new IPC contract** — `tabs.*` and `nav.*` already exist; only the `AegisAndroid`
  bridge gains the per-tab WebView lifecycle methods.

## 8. Testing

- **jsdom unit tests** (mocked `aegis`, mocked bridge) for: `MobileTabSwitcher`
  (renders rows, switch/close/new-tab wiring), the reworked `MobileBottomBar` (Saved/
  History/Tabs+count/Shield/Menu) and `MobileMenuSheet` (Back/Forward/Home/Bookmark/
  Downloads/Settings), and the `MobileApp`/`useMobileTabSync` diff-and-sync logic
  (given a tabs-state change, the right bridge calls fire).
- **Desktop suite stays green** (desktop untouched).
- **On-device (owner):** the native multi-WebView lifecycle (create/show-one/hide/
  discard/recreate, per-tab live state, `target=_blank` → background tab, memory under
  many tabs, per-tab ad-block) is GUI-validated on the device after `npm run
  android:build` (JDK 21). This is the part that can't be headless-tested.

## 9. Risks

1. **Phone memory** — many live WebViews OOM. Mitigated by show-one + the registry's
   idle-sweep `discardTab`, with an optional live-tab cap. Validate with many tabs.
2. **Per-tab ad-block context** — each WebView must use its **own** `currentPageUrl`;
   today it's one field. The design makes it per-WebView (the request thread reads the
   originating WebView's URL).
3. **Chrome-drives-native coordination** — the diff-and-sync must stay consistent with
   registry state (no orphaned/leaked WebViews, no missing active view). Keep it in one
   small, tested unit.
4. **Per-tab nav-state routing** — multiple WebViews each push nav-state; the mobile
   `__aegisNavState` path must carry `viewId` so `useNav(activeId)` filters correctly
   (today there's only one, so it's unfiltered).
5. **`target=_blank` loop/foreground** — new-window must open a *background* tab and not
   steal focus or recurse.

## 10. Build order (for the plan)

Chrome first (jsdom-testable, desktop unaffected): `MobileTabSwitcher` → reworked
`MobileBottomBar` + `MobileMenuSheet` → `MobileApp` rewire to `useTabs`/`useNav(activeId)`
+ the `useMobileTabSync` diff-and-sync (driving a mock bridge in tests). Then native
(`MainActivity.kt`): the `tabId → WebView` map + `activateTab`/`closeTab`/`discardTab` +
per-WebView `WebViewClient` (per-tab `currentPageUrl` + tab-id nav-state) + active-target
`navigate`/`back`/`forward`/`reload` + `onCreateWindow` background tab. The native layer
is GUI-validated on-device at the end (JDK-21 build).
