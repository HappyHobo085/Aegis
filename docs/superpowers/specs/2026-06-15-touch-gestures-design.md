# Touch gestures (Android) — design

**Status:** approved (brainstorming) — ready for an implementation plan.
**Date:** 2026-06-15
**Builds on:** the Android mobile shell + live multi-tab (`MainActivity.kt`, the `tabId→WebView` map, the `window.AegisAndroid` bridge).

## Goal

Add two touch gestures to the Aegis Android content WebView:

1. **Edge-swipe back/forward** — a swipe that starts in a thin strip at the screen edge: **left edge → page back, right edge → page forward**, with an **edge arrow indicator** (◀ / ▶) that follows the finger and navigates on release past a threshold.
2. **Pull-to-refresh** — a downward overscroll while the page is scrolled to the top → reload the active tab, with a circular spinner indicator.

Out of scope (explicitly): swipe-between-tabs (dropped — it collides with the horizontal back/forward swipe), and any on/off setting (YAGNI). Back/Forward were already moved off the mobile bottom bar into the ☰ menu so these gestures can own them.

## Why native (not JS)

The content is a **separate native Kotlin `WebView`**, layered over the React chrome webview. The chrome can't observe touches on it, and injecting gesture JS into arbitrary pages is unreliable and a security smell. Both gestures are therefore implemented natively in `MainActivity` / a new `GestureContainer`, calling the **bridge primitives that already exist** (`goBack`/`goForward`/`reload` on the active WebView).

## Architecture — one `GestureContainer`

Today each tab's `WebView` is added directly into `contentParent` (the chrome webview's parent), each carrying the chrome-bar margins. Insert **one custom `FrameLayout`, `GestureContainer`, between them**:

```
contentParent
└── GestureContainer        (MATCH_PARENT + the chrome-bar margins; touch + indicator surface)
    ├── tab WebView 1        (MATCH_PARENT, no margins)   ← active = VISIBLE, others GONE
    ├── tab WebView 2        …
    └── (indicator drawn on top in onDraw: the ◀/▶ arrow + the refresh spinner)
```

- The `tabId→WebView` map and tab lifecycle (`activateTab`/`closeTab`/`discardTab`) are **unchanged**; only the WebViews' **parent** moves from `contentParent` to the `GestureContainer`.
- The chrome-bar margins move from per-WebView to the **single container**: `applyContentMargins()` now targets the `GestureContainer` (a net simplification — one view instead of per-tab), and tab WebViews fill it `MATCH_PARENT` with no margins.
- The container always operates on the **active** WebView (`contentWebView`); only the active tab is visible, so reads of "the current WebView" resolve to it.

### Watch-then-steal touch model

`GestureContainer.onInterceptTouchEvent` observes `ACTION_DOWN`/`ACTION_MOVE` while the child WebView handles them normally, and **returns `true` (stealing the gesture — the WebView receives `ACTION_CANCEL`) only once it positively recognizes one of our two gestures.** Subsequent events then go to `GestureContainer.onTouchEvent`, which drives the gesture + indicator and fires the action on release. If neither gesture is recognized, `onInterceptTouchEvent` always returns `false` and the WebView keeps the touch (taps, links, scroll, carousels, pinch-zoom, long-press/selection all behave normally).

## Gesture behaviors

### Edge-swipe back/forward

- **Arming (DOWN):** record `(x0, y0)`. Left strip = `x0 < EDGE`; right strip = `x0 > width - EDGE`. `EDGE ≈ 20dp`. A DOWN outside both strips never arms the horizontal gesture.
- **Steal condition (MOVE):** horizontal-dominant (`|dx| > touchSlop && |dx| > |dy|`), correct inward direction (**left strip → drag right = back**; **right strip → drag left = forward**), **and** the active WebView reports `canGoBack()` (back) / `canGoForward()` (forward). If the relevant `canGo` is false, never engage — fall through.
- **Multi-touch:** if a second pointer goes down before the gesture is recognized, abort arming (let pinch-zoom proceed).
- **During drag (onTouchEvent MOVE):** draw the arrow (a circle + chevron) tracking the finger's x; `progress = min(travel / THRESHOLD, 1)` drives the arrow's reveal/scale. `invalidate()` per move.
- **Release (UP):** if `travel ≥ THRESHOLD` (a distance such as ~`min(0.25*width, 96dp)`, optionally OR a fling velocity over `VELOCITY_MIN`) → call the activity's `onBack()` / `onForward()`; else animate the arrow out (cancel). Always hide the indicator on UP/CANCEL.

### Pull-to-refresh

- **Steal condition:** `activeWebView.scrollY == 0` (page at the very top) **and** downward-dominant (`dy > touchSlop && dy > |dx|`). Otherwise vertical drags fall through to normal WebView scrolling.
- **During drag:** a circular spinner is pulled down from the top with damping (e.g. `offset = dy * 0.5`, capped); `progress = min(dy / PULL_THRESHOLD, 1)` drives the spinner's sweep before release.
- **Release (UP):** if `dy ≥ PULL_THRESHOLD` → keep the spinner visible + spinning and call the activity's `onReload()`. The container exposes `stopRefresh()`, which the activity calls from the active tab's `WebViewClient.onPageFinished` (only when that tab is the active one) to hide the spinner. Below threshold → spring the spinner back and hide.

## Edge cases & conflicts

- **Android system back-gesture overlap (gesture-nav phones).** The OS reserves the screen edges for its own back gesture. Register `GestureContainer.setSystemGestureExclusionRects()` for the left + right edge strips (API 29+ / `Build.VERSION.SDK_INT >= Q`; `minSdk` is 24, so guard the call) so the system yields those strips. Re-set the rects whenever the container is laid out / resized (rotation, inset changes). **Graceful degradation:** if an OEM still wins the left edge (e.g. Samsung One UI edge panels), system-back already routes to `onBackPressed` → page-back, and **right-edge forward remains the unique gain** Android can't otherwise provide. Android caps exclusion-rect coverage per edge; the thin full-height strips are within limits.
- **History at the ends.** Back at the start / forward at the end: the gesture doesn't engage (the `canGo` guard fails) — no arrow, the touch falls through.
- **All chrome modes.** The container's margins follow `applyContentMargins()`, so gestures work in normal, bottom-bar-hidden, and chrome-hiding-fullscreen modes.
- **Pull-to-refresh vs. a page's own top overscroll.** We only engage at `scrollY == 0`; pages that implement their own pull behavior are rare and acceptable to override (no setting — YAGNI).

## Components & files

- **New — `GestureContainer.kt`** (`com.aegis.browser`): a `FrameLayout` subclass owning touch arbitration, the two gesture state machines, and indicator drawing (`onDraw`). It talks to the activity through a small interface, e.g.:
  ```kotlin
  interface GestureHost {
    fun gestureCanGoBack(): Boolean
    fun gestureCanGoForward(): Boolean
    fun gestureAtTop(): Boolean      // active WebView scrollY == 0
    fun gestureBack()
    fun gestureForward()
    fun gestureReload()
  }
  ```
  One focused file; no knowledge of tabs beyond "the active WebView," provided via the host.
- **Modified — `MainActivity.kt`:**
  - In `onWebViewCreate`: create the `GestureContainer`, add it to `contentParent`, and have `createTabWebView` add tab WebViews into the container instead of `contentParent` (and `closeTab`/`discardTab` remove from it).
  - Retarget `applyContentMargins()` to set the `GestureContainer`'s margins; tab WebViews become `MATCH_PARENT` with no margins.
  - Implement `GestureHost` on the activity (its `back()`/`forward()`/`reload()` logic already exists; `gestureAtTop()` reads `contentWebView?.scrollY == 0`).
  - Register/refresh the system-gesture-exclusion rects.
- **No changes** to the React chrome, `shared/types.ts`, the IPC dispatcher, or any renderer file.

## Data flow

```
finger touch
  → GestureContainer.onInterceptTouchEvent (arbitrate) → onTouchEvent (drive + indicator)
  → on threshold release → GestureHost.gestureBack/Forward/Reload
  → MainActivity acts on the active WebView (goBack/goForward/reload)
  → WebViewClient onPageStarted/doUpdateVisitedHistory → pushNavState(activeTabId, …)
  → chrome address bar + back/forward state update (no extra wiring)
```

The indicator (arrow/spinner) is purely native and visual; navigation reuses the existing nav-state pipeline, so the chrome stays correct automatically.

## Testing & validation

- **No headless tests for the native Kotlin** (same constraint as the multi-tab work). Implement carefully, then **the owner builds + GUI-validates on the device**: `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`, then `adb install -r …`.
- **The 461-test renderer suite must stay green** as a guard that no chrome/renderer code was touched (this feature changes only native Kotlin).
- **On-device validation checklist:**
  1. Left-edge swipe shows the ◀ arrow and goes back; right-edge shows ▶ and goes forward; release-short cancels.
  2. Pull down at the top of a page shows the spinner and reloads; mid-page pull-down scrolls normally (no refresh).
  3. Normal browsing unaffected: taps, links, vertical scroll, horizontal carousels/sliders (started away from the edge), pinch-zoom, text selection/long-press.
  4. System back still works (button and/or system edge gesture).
  5. Gestures are no-ops at history ends (no arrow when `!canGoBack` / `!canGoForward`).
  6. Works across tabs (gesture targets the active tab) and in bottom-bar-hidden + chrome-hiding-fullscreen modes.

## Known risks / unknowns

- **Feel tuning** (edge width, slop, distance/velocity thresholds, damping) needs a round or two of on-device iteration — expected for gesture work; surfaced as a tuning step in the plan, not a redesign.
- **OEM edge behavior** (Samsung One UI edge panels) may contest the left edge despite exclusion rects; mitigated by graceful degradation (system-back still navigates; right-edge forward is the unique win).
- **Indicator smoothness** (`invalidate()` per move + `onDraw`) is standard and low-risk.
