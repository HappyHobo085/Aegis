# Mobile-friendly UI — touch chrome + panels (design spec)

- **Date:** 2026-06-15
- **Status:** Approved (brainstorming). Next: implementation plan.
- **Sub-project:** First of the "mobile-friendly UI" effort. **Mobile tabs** (a tab
  switcher + Android multi-WebView) and **touch gestures beyond auto-hide** are
  separate later sub-projects.

## 1. Goal

Make the Android chrome feel like a native mobile browser: a slim top address bar
+ a compact favourites strip, a thumb-reachable **bottom action bar** that
auto-hides while scrolling, and phone-friendly **full-screen sheets** for the
secondary features (Settings / History / Saved / Downloads) instead of the
cramped desktop modals/sidebar.

## 2. Target & current state

- **Target:** Android (the only running mobile path today; iOS is blocked on
  macOS/Xcode). The renderer/CSS work benefits any mobile webview; the native work
  is Android-specific (`MainActivity.kt`).
- **Current:** Android runs the **chrome webview** (Tauri, full-screen, the React
  app) with a **native content `WebView`** layered on top of it, bridged via
  `window.AegisAndroid`. The content WebView has `topMargin = 96dp` (the old
  two-row toolbar) + status-bar inset and only a nav-bar `bottomMargin`. The chrome
  is the desktop UI reflowed to two top rows (`.aegis-mobile` CSS); the sidebar,
  Settings modal, and downloads are desktop layouts shown on a phone; tabs are
  desktop-only. See `src-tauri/gen/android/.../MainActivity.kt`,
  `src/lib/ipcClient.ts` (`AegisAndroid` bridge + `.aegis-mobile` tagging), and the
  `.aegis-mobile` block in `src/index.css`.

## 3. Non-goals (this sub-project)

- **Mobile tabs / tab switcher** and the Android **multi-WebView** work — separate
  sub-project (the desktop multi-tab `tabs.*` contract already compiles on mobile).
- **Gestures** beyond the bottom-bar scroll auto-hide (no swipe-back, pull-to-refresh).
- **iOS** (needs macOS/Xcode).
- Any change to the **desktop** chrome — it stays byte-for-byte untouched.

## 4. Architecture

A **dedicated mobile chrome shell** rendered only when `isMobile`, which **reuses
the existing presentational feature components** (`HistoryPanel`, `SavedPanel`, the
downloads list, the Settings tabs, `AddressBar`, `AdblockShield`, and the hooks
`useNav`/`useFavorites`/`useAdblock`/etc.) inside mobile wrappers. `App.tsx`
branches `isMobile ? <MobileShell/> : <existing desktop chrome>`. No desktop
component changes.

*(Alternatives rejected: cram a bottom bar + sheets into the desktop
components via CSS — hacky, since the desktop Toolbar/Sidebar are structurally
different; a fully separate mobile app tree — duplicates orchestration.)*

### 4.1 New components (`src/components/mobile/`)

- **`MobileShell`** — the orchestrator: owns "which sheet/menu is open", renders the
  top bar + bottom bar + the active full-screen sheet. The `isMobile` branch target.
- **`MobileTopBar`** — slim address bar (`[🔒 security] [URL …] [↻ reload/stop]`,
  reusing `AddressBar`) **plus** the compact favourites strip below it.
- **`MobileFavourites`** — a **24dp**, horizontally-scrollable row of favourite
  chips (reuses `useFavorites`); tap → `nav.navigate`. Smaller than the address bar.
- **`MobileBottomBar`** — `[← back] [→ forward] [⌂ home] [🛡 shield] [☰ menu]`.
  The shield reuses `AdblockShield` (blocked-count badge + tap-to-toggle).
- **`MobileMenuSheet`** — the ☰ drawer: a list launching the secondary features
  (Settings, History, Saved, Downloads) + a **★ Bookmark this page** toggle.
- **`MobileSheet`** — a generic **full-screen** sheet (top app-bar `← Title` +
  scrollable body), used to host History and Saved (which on desktop live inside the
  Sidebar). Settings and Downloads reuse their **existing modals**, made full-screen
  via `.aegis-mobile` CSS (they already have headers/close).

### 4.2 Layout (logical px / dp; kept in sync with native margins)

```
 [ 🔒  example.com            ↻ ]   address bar   ~48
 [ ★Home  News  Docs  … →       ]   favourites    24
 ───────────────────────────────
            page content
 ───────────────────────────────
 [  ←    →    ⌂    🛡    ☰      ]   bottom bar    56  (auto-hides)
```

Mobile chrome heights are defined as shared constants in `src/lib/layout.ts`
(`MOBILE_ADDRESS_H = 48`, `MOBILE_FAV_H = 24`, `MOBILE_BOTTOMBAR_H = 56`) and the
native `MainActivity` margins are kept in sync with them — the same convention the
current `96px ↔ 96dp` uses.

### 4.3 Secondary-feature routing (the ☰ menu)

| Menu item | Opens | Reuses |
|---|---|---|
| Settings | existing `SettingsModal`, full-screen on mobile | the Settings tab components |
| Downloads | existing `DownloadsModal`, full-screen on mobile | the downloads list |
| History | `MobileSheet` | `HistoryPanel` |
| Saved | `MobileSheet` | `SavedPanel` |
| ★ Bookmark this page | toggles saved (no sheet) | `useSaved` |

Only one sheet/menu is open at a time (`MobileShell` state). When any sheet/menu is
open, the chrome calls the **existing** `aegis.view.setChromeOverlay` →
`AegisAndroid.setContentHidden(true)` so the native content WebView lowers and the
sheet (in the chrome webview) shows over it — the mechanism already used for desktop
overlays on mobile.

## 5. Native changes (`MainActivity.kt`)

All in `MainActivity.kt`; the chrome reuses the existing `AegisAndroid` bridge plus
small additions.

1. **Margins (required).** Content WebView `topMargin` ≈ `MOBILE_ADDRESS_H(48) +
   MOBILE_FAV_H(24) = 72dp` + status-bar inset; `bottomMargin = MOBILE_BOTTOMBAR_H(56)dp
   + nav-bar inset`. (Replaces the current `96dp` top / nav-only bottom.)

2. **Android Back handler (required).** Override the activity Back press with this
   precedence: **(a)** if a chrome sheet/menu is open → tell the chrome to close it
   and consume the press; **(b)** else if the content WebView `canGoBack()` → go back;
   **(c)** else default (exit). Wiring:
   - New bridge method `AegisAndroid.setBackInterceptActive(active: boolean)` — the
     `MobileShell` calls it `true` whenever a sheet/menu is open, `false` when none is.
     The native side reads this flag (UI-thread `@Volatile`) for branch (a).
   - Native → chrome "close the top sheet": `chromeWebView.evaluateJavascript(
     "window.__aegisMobileBack && window.__aegisMobileBack()")`, which `MobileShell`
     installs to pop the open sheet/menu.

3. **Bottom-bar scroll auto-hide (the "if possible" stretch).** Because the bar lives
   in the *chrome* (behind the native content WebView) and only shows in the gap the
   content leaves, auto-hide animates the content's `bottomMargin`:
   - `content.setOnScrollChangeListener` (or `onScrollChanged`) computes scroll
     **direction** from the `scrollY` delta (with a small threshold to ignore jitter).
   - Scroll **down** past the threshold → animate `bottomMargin` to **0** (content
     expands over the bar → bar hidden). Scroll **up** → animate back to
     `MOBILE_BOTTOMBAR_H + navInset` (bar reappears). Always show the bar at the top of
     the page and when a sheet opens.
   - This is a **push** model (content reflows as the bar shows/hides), not a true
     overlay — the architecture can't float the chrome bar over the native content.
     Acceptable; if it's janky on-device, ship items 1–2 and defer this.

## 6. Data flow & reuse

- **Nav / back / forward / reload / home** → the existing `AegisAndroid` bridge
  (`ipcClient` already routes these to it on Android).
- **Favourites / history / saved / downloads / settings** → the existing `aegis.*`
  IPC (these reach the Rust core via Tauri `invoke`, which works on Android), through
  the existing hooks (`useFavorites`, `useHistory`, `useSaved`, `useDownloads`,
  `useSettings`). No new IPC contract.
- **Overlay z-order** → existing `view.setChromeOverlay` → `setContentHidden` bridge.

## 7. Testing

- **jsdom unit tests** (mocked `aegis`) for `MobileBottomBar`, `MobileMenuSheet`,
  `MobileSheet`, `MobileFavourites`, `MobileTopBar` — render, button→action wiring,
  sheet open/close, favourites→navigate, `setBackInterceptActive` on sheet open/close.
- **`App.tsx` branch test:** with `.aegis-mobile` set, the mobile shell renders the
  bottom bar (not the desktop Toolbar); without it, the desktop chrome is unchanged.
- **Desktop suite stays green** (desktop chrome untouched).
- **On-device (you):** the native margins, the Android Back precedence, the
  setContentHidden overlay behaviour, and the scroll auto-hide are GUI-validated on
  the emulator/device after an APK rebuild (`npm run android:build`).

## 8. Risks

1. **Android Back interception** — overriding the activity back press while keeping
   Tauri/wry's own handling correct; verify the flag-based precedence on-device.
2. **Auto-hide smoothness** — the push (margin-animation) model reflows content;
   confirm it isn't janky. It's the deferrable stretch piece.
3. **Renderer heights ↔ native margins drift** — keep `MOBILE_*_H` constants and the
   `MainActivity` margins in sync (shared-constant convention; document in both).
4. **Sheet ↔ content overlay** — sheets must reliably lower the native content
   (existing `setContentHidden`); confirm each mobile sheet routes through it.

## 9. Build order (for the plan)

Renderer first (unit-testable, desktop unaffected): layout constants → mobile
components (bottom bar, favourites, top bar, menu sheet, generic sheet) → `MobileShell`
+ `App.tsx` branch + `.aegis-mobile` CSS (full-screen modals). Then native:
margins → Back handler (+ `setBackInterceptActive` bridge) → scroll auto-hide (stretch).
The native layer is GUI-validated on-device at the end.
