# Android touch gestures Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add edge-swipe back/forward (with a ◀/▶ arrow indicator) and pull-to-refresh to the Aegis Android content WebView.

**Architecture:** One new native `FrameLayout` — `GestureContainer` — is inserted between `contentParent` and the per-tab `WebView`s. It uses the standard watch-then-steal touch model (`onInterceptTouchEvent`) to recognize a horizontal edge-swipe or a top-overscroll pull, draws the indicator while dragging, and on release calls back/forward/reload on the active WebView through a `GestureHost` interface the activity implements. Navigation reuses the existing `WebViewClient → pushNavState` pipeline, so the chrome's address bar stays correct with no renderer changes.

**Tech Stack:** Android Kotlin (`MainActivity.kt` + new `GestureContainer.kt`); no React/TypeScript/IPC changes. Spec: `docs/superpowers/specs/2026-06-15-touch-gestures-design.md`.

---

## Testing reality (read first)

- This feature is **100% native Kotlin** — the project has no JVM/JUnit harness for the Android module, so it **cannot be unit-tested headlessly** (same constraint as the already-merged multi-tab native work). Each task is implement → **compile-build** → **owner builds + GUI-validates on the device**. Don't claim a gesture works without an on-device check.
- **Compile-build (the agent can run this):** `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`. JDK 21 is required (the machine default JDK 25 fails Gradle config). A green build proves the Kotlin compiles + links + bundles an APK; it does NOT prove runtime behavior.
- **Owner validation:** the repo owner runs `adb install -r src-tauri/gen/android/app/build/outputs/apk/universal/debug/app-universal-debug.apk` and tests on the device (device serial `RFCW323LSXD`). Headless rendering is black, so on-screen confirmation is the owner's.
- **The renderer suite stays green** as a guard that no chrome code was touched: `npm test` (461 tests). It is not otherwise exercised by Kotlin changes.
- **Gesture feel (edge width, slop, thresholds, damping) needs on-device tuning** — expected; Task 4 is the dedicated tuning + docs + finish pass. Constants are concrete here as sensible starting values.

Commands: compile-build (owner or agent) → the `android:build` line above; renderer gate → `npm test`.

---

## File structure

**New (native)**
- `src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt` — the gesture layer: touch arbitration, the two gesture state machines, indicator drawing, and the `GestureHost` interface. One focused file (~170 lines).

**Modified (native)**
- `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt` — create + wire the `GestureContainer`, re-parent tab WebViews into it, retarget `applyContentMargins()`, implement `GestureHost`, and call `gestureContainer.stopRefresh()` from the active tab's `onPageFinished`.

**Docs**
- `src-tauri/CLAUDE.md` — document the gesture layer in the Android section.

No renderer, `shared/types.ts`, or IPC changes.

---

## Milestone 1 — Structural: insert the GestureContainer (behavior-preserving)

### Task 1: `GestureContainer` scaffold + re-parent the tab WebViews

**Files:**
- Create: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

The goal of this task is purely structural: insert the container so the WebViews are its children and the chrome-bar margins live on it, with **no gesture behavior yet** — the app must browse exactly as before. This de-risks the re-parent before any gesture logic is added.

- [ ] **Step 1: Create `GestureContainer.kt`** with the interface, fields, a system-gesture-exclusion setup, and pass-through touch handlers (no recognition yet):

```kotlin
package com.aegis.browser

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.Rect
import android.graphics.RectF
import android.os.Build
import android.view.MotionEvent
import android.view.ViewConfiguration
import android.widget.FrameLayout
import kotlin.math.abs
import kotlin.math.min

/**
 * Native gesture layer over the active content WebView. Tab WebViews are this view's
 * children (MATCH_PARENT; only the active one is visible). Uses the standard
 * watch-then-steal model: onInterceptTouchEvent lets the WebView handle touches until we
 * positively recognize one of our gestures, then steals it (the WebView gets CANCEL).
 *
 * Gestures (added in later tasks): edge-swipe back/forward (a horizontal drag from a thin
 * screen-edge strip) and pull-to-refresh (a downward drag while the page is at the top).
 */
class GestureContainer(context: Context, private val host: GestureHost) : FrameLayout(context) {

  interface GestureHost {
    fun gestureCanGoBack(): Boolean
    fun gestureCanGoForward(): Boolean
    fun gestureAtTop(): Boolean
    fun gestureBack()
    fun gestureForward()
    fun gestureReload()
  }

  private enum class Mode { NONE, BACK, FORWARD, REFRESH }

  private val density = resources.displayMetrics.density
  private val edgePx = 20f * density
  private val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val pullMaxPx = 140f * density

  private var mode = Mode.NONE
  private var startX = 0f
  private var startY = 0f
  private var curX = 0f
  private var curY = 0f
  private var refreshing = false
  private var spin = 0f

  private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1f6feb") }
  private val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2.5f * density
    strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 3f * density; strokeCap = Paint.Cap.ROUND
  }

  init { setWillNotDraw(false) }

  private fun hDistance() = min(0.25f * width, 96f * density)
  private fun pullThreshold() = 96f * density

  override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
    super.onSizeChanged(w, h, ow, oh)
    // Claim the left/right edge strips from Android's system back gesture (gesture-nav
    // phones reserve the edges) so our edge-swipe can win there. No-op below API 29.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val e = edgePx.toInt()
      systemGestureExclusionRects = listOf(Rect(0, 0, e, h), Rect(w - e, 0, w, h))
    }
  }

  // Touch recognition is added in later tasks; for now the container is a transparent
  // pass-through so the WebView behaves exactly as before.
  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean = false

  override fun onTouchEvent(ev: MotionEvent): Boolean = false

  /** Called by the host when the active tab finishes (re)loading — hides the spinner. */
  fun stopRefresh() {
    if (refreshing) { refreshing = false; mode = Mode.NONE; invalidate() }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    // Indicator drawing is added with each gesture in later tasks.
  }
}
```

> The unused private members (`startX`, `disc`, `arc`, `hDistance`, etc.) are consumed by the gesture logic in Tasks 2–3. Kotlin compiles with unused-private warnings, not errors — that's fine for this scaffold task.

- [ ] **Step 2: In `MainActivity.kt`, declare the host + a field for the container.** Change the class declaration to implement the interface and add a field near `contentParent`:

Class header — from:
```kotlin
class MainActivity : TauriActivity() {
```
to:
```kotlin
class MainActivity : TauriActivity(), GestureContainer.GestureHost {
```

Add the field next to `private var contentParent: ViewGroup? = null`:
```kotlin
  // The gesture layer that wraps the tab WebViews (edge-swipe + pull-to-refresh).
  private var gestureContainer: GestureContainer? = null
```

- [ ] **Step 3: Create the container in `onWebViewCreate` and re-parent through it.** In the `webView.post { ... }` block, after `contentParent = parent` and the height caching, create the container and add it to the parent:

Find:
```kotlin
      contentParent = parent
      val density = resources.displayMetrics.density
      val top = (72 * density).toInt()
      val bottomBar = (56 * density).toInt()
      topChromePx = top
      bottomBarPx = bottomBar
```
and add immediately after it:
```kotlin
      val gc = GestureContainer(this, this)
      val gcLp = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
      gcLp.topMargin = top
      gcLp.bottomMargin = bottomBar
      parent.addView(gc, gcLp)
      gestureContainer = gc
```

- [ ] **Step 4: Re-parent tab WebViews into the container (no per-WebView margins).** In `createTabWebView`, replace the margin'd add to `contentParent`:

Find:
```kotlin
    val lp = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    lp.topMargin = topChromePx + statusTop
    lp.bottomMargin = bottomBarPx + navBottom
    wv.visibility = View.GONE
    contentParent?.addView(wv, lp)
```
and replace with (WebView fills the container; the container carries the margins):
```kotlin
    val lp = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    wv.visibility = View.GONE
    gestureContainer?.addView(wv, lp)
```

- [ ] **Step 5: Remove tab WebViews from the container on close/discard.** In both `closeTab` and `discardTab`, change `contentParent?.removeView(it)` to `gestureContainer?.removeView(it)` (two occurrences — one in each method).

- [ ] **Step 6: Retarget `applyContentMargins()` to the container.** Replace the whole method:

Find:
```kotlin
  private fun applyContentMargins() {
    val c = contentWebView ?: return
    (c.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
      p.topMargin = (if (fullscreen) 0 else topChromePx) + statusTop
      p.bottomMargin = (if (fullscreen || bottomBarHidden) 0 else bottomBarPx) + navBottom
      c.layoutParams = p
    }
  }
```
with (margins now live on the single container; tab WebViews fill it):
```kotlin
  private fun applyContentMargins() {
    val gc = gestureContainer ?: return
    (gc.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
      p.topMargin = (if (fullscreen) 0 else topChromePx) + statusTop
      p.bottomMargin = (if (fullscreen || bottomBarHidden) 0 else bottomBarPx) + navBottom
      gc.layoutParams = p
    }
  }
```

- [ ] **Step 7: Implement the `GestureHost` methods on the activity.** Add these (e.g. just above the `companion object`):

```kotlin
  // --- GestureContainer.GestureHost: the gesture layer acts on the active tab. ---
  override fun gestureCanGoBack(): Boolean = contentWebView?.canGoBack() == true
  override fun gestureCanGoForward(): Boolean = contentWebView?.canGoForward() == true
  override fun gestureAtTop(): Boolean = (contentWebView?.scrollY ?: 1) == 0
  override fun gestureBack() { contentWebView?.let { if (it.canGoBack()) it.goBack() } }
  override fun gestureForward() { contentWebView?.let { if (it.canGoForward()) it.goForward() } }
  override fun gestureReload() { contentWebView?.reload() }
```

- [ ] **Step 8: Compile-build.** Run:
```
JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64
```
Expected: `BUILD SUCCESSFUL` / `Finished 1 APK at … app-universal-debug.apk`. Fix any Kotlin compile error (e.g. a missed `contentParent`→`gestureContainer` rename) before continuing.

- [ ] **Step 9: Owner GUI-validation.** Owner installs (`adb install -r …app-universal-debug.apk`) and confirms **browsing is unchanged**: pages load, the address bar tracks, tabs open/switch/close, ad-block works, and the content sits correctly under the top chrome + above the bottom bar in normal, bottom-bar-hidden, and chrome-hiding-fullscreen modes (i.e. the margins moved cleanly to the container). No gestures yet. Paste the build result / a device confirmation.

- [ ] **Step 10: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt \
        src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): insert GestureContainer (re-parent tab WebViews; no gestures yet)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Milestone 2 — The gestures

### Task 2: Edge-swipe back/forward (arbitration + arrow indicator)

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt`

- [ ] **Step 1: Replace `onInterceptTouchEvent`** with the arming + horizontal steal logic (the pull-to-refresh branch is added in Task 3):

```kotlin
  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        mode = Mode.NONE
        startX = ev.x; startY = ev.y; curX = ev.x; curY = ev.y
      }
      MotionEvent.ACTION_MOVE -> {
        if (ev.pointerCount > 1 || refreshing) return false
        val dx = ev.x - startX
        val dy = ev.y - startY
        // Left edge, drag right -> back.
        if (startX <= edgePx && dx > slop && dx > abs(dy) && host.gestureCanGoBack()) {
          mode = Mode.BACK; curX = ev.x; curY = ev.y; return true
        }
        // Right edge, drag left -> forward.
        if (startX >= width - edgePx && -dx > slop && abs(dx) > abs(dy) && host.gestureCanGoForward()) {
          mode = Mode.FORWARD; curX = ev.x; curY = ev.y; return true
        }
      }
    }
    return false
  }
```

- [ ] **Step 2: Replace `onTouchEvent`** to drive the active gesture and finish on release:

```kotlin
  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (mode == Mode.NONE) return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> { curX = ev.x; curY = ev.y; invalidate() }
      MotionEvent.ACTION_UP -> finishGesture()
      MotionEvent.ACTION_CANCEL -> { mode = Mode.NONE; invalidate() }
    }
    return true
  }
```

- [ ] **Step 3: Add `finishGesture()`** (back/forward only for now; the refresh case is added in Task 3):

```kotlin
  private fun finishGesture() {
    when (mode) {
      Mode.BACK -> if (curX - startX >= hDistance()) host.gestureBack()
      Mode.FORWARD -> if (startX - curX >= hDistance()) host.gestureForward()
      else -> {}
    }
    mode = Mode.NONE
    invalidate()
  }
```

- [ ] **Step 4: Update `onDraw` to render the arrow, and add `drawArrow`:**

Replace `onDraw`:
```kotlin
  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    when (mode) {
      Mode.BACK, Mode.FORWARD -> drawArrow(canvas)
      else -> {}
    }
  }
```
Add the helper:
```kotlin
  private fun drawArrow(canvas: Canvas) {
    val travel = if (mode == Mode.BACK) curX - startX else startX - curX
    val progress = min(travel / hDistance(), 1f).coerceAtLeast(0f)
    val r = 18f * density
    val cy = curY.coerceIn(r, height - r)
    val cx = if (mode == Mode.BACK) r + progress * 10f * density
             else width - r - progress * 10f * density
    disc.alpha = (160 + 95 * progress).toInt().coerceIn(0, 255)
    canvas.drawCircle(cx, cy, r, disc)
    val a = 6f * density
    val p = Path()
    if (mode == Mode.BACK) { p.moveTo(cx + a, cy - a); p.lineTo(cx - a, cy); p.lineTo(cx + a, cy + a) }
    else { p.moveTo(cx - a, cy - a); p.lineTo(cx + a, cy); p.lineTo(cx - a, cy + a) }
    canvas.drawPath(p, glyph)
  }
```

- [ ] **Step 5: Compile-build** — `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`. Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Owner GUI-validation.** Confirm on-device: a **left-edge swipe shows the ◀ arrow and goes back**; a **right-edge swipe shows ▶ and goes forward**; a short swipe cancels (no navigation); at history ends the gesture doesn't engage (no arrow when `!canGoBack`/`!canGoForward`); **normal browsing is unaffected** — taps, links, vertical scroll, in-page horizontal carousels (started away from the edge), pinch-zoom, and text selection all still work; the address bar updates after a gesture nav. Works in fullscreen + bottom-bar-hidden modes and across tabs. Paste the build result / device confirmation.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt
git commit -m "feat(mobile): edge-swipe back/forward with arrow indicator

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

### Task 3: Pull-to-refresh (top-overscroll + spinner)

**Files:**
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt`
- Modify: `src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt`

- [ ] **Step 1: Add the vertical branch to `onInterceptTouchEvent`.** Inside the `ACTION_MOVE` arm, immediately before the final `return false` of that arm (i.e. after the FORWARD `if`), add:

```kotlin
        // Pull to refresh: downward drag while the page is at the very top.
        if (dy > slop && dy > abs(dx) && host.gestureAtTop()) {
          mode = Mode.REFRESH; curX = ev.x; curY = ev.y; return true
        }
```

- [ ] **Step 2: Add the refresh case to `finishGesture()`.** Replace `finishGesture` with:

```kotlin
  private fun finishGesture() {
    when (mode) {
      Mode.BACK -> { if (curX - startX >= hDistance()) host.gestureBack(); mode = Mode.NONE }
      Mode.FORWARD -> { if (startX - curX >= hDistance()) host.gestureForward(); mode = Mode.NONE }
      Mode.REFRESH -> {
        if (curY - startY >= pullThreshold()) {
          refreshing = true; spin = 0f; host.gestureReload(); postInvalidateOnAnimation()
        } else {
          mode = Mode.NONE
        }
      }
      else -> mode = Mode.NONE
    }
    invalidate()
  }
```

> Note: in `REFRESH` we keep `mode = Mode.REFRESH` while `refreshing` is true so the spinner stays drawn; `stopRefresh()` clears it. The other modes reset immediately.

- [ ] **Step 3: Add the refresh case to `onDraw`, and add `drawSpinner`.** Replace `onDraw`:

```kotlin
  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    when (mode) {
      Mode.BACK, Mode.FORWARD -> drawArrow(canvas)
      Mode.REFRESH -> drawSpinner(canvas)
      else -> {}
    }
  }
```
Add:
```kotlin
  private fun drawSpinner(canvas: Canvas) {
    val r = 16f * density
    val cx = width / 2f
    val cy: Float
    if (refreshing) {
      cy = pullThreshold() * 0.5f
      spin = (spin + 9f) % 360f
      canvas.drawCircle(cx, cy, r + 3f * density, disc)
      canvas.drawArc(RectF(cx - r, cy - r, cx + r, cy + r), spin, 270f, false, arc)
      postInvalidateOnAnimation()
    } else {
      val pull = curY - startY
      cy = min(pull * 0.5f, pullMaxPx)
      val progress = min(pull / pullThreshold(), 1f).coerceAtLeast(0f)
      disc.alpha = (160 + 95 * progress).toInt().coerceIn(0, 255)
      canvas.drawCircle(cx, cy, r + 3f * density, disc)
      canvas.drawArc(RectF(cx - r, cy - r, cx + r, cy + r), -90f, progress * 300f, false, arc)
    }
  }
```

- [ ] **Step 4: Hide the spinner when the active tab finishes loading.** In `MainActivity.kt`, in `makeContentClient(id)`, update `onPageFinished` to also stop the spinner when this tab is the active one:

Find:
```kotlin
    override fun onPageFinished(view: WebView, url: String) = pushNavState(id, url, false, view)
```
Replace with:
```kotlin
    override fun onPageFinished(view: WebView, url: String) {
      pushNavState(id, url, false, view)
      if (id == activeTabId) gestureContainer?.stopRefresh()
    }
```

- [ ] **Step 5: Compile-build** — `JAVA_HOME=/home/happyhobo/development/android-studio/jbr npm run android:build -- --target aarch64`. Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 6: Owner GUI-validation.** Confirm on-device: **pulling down at the top of a page shows the spinner and reloads** (spinner hides when the reload finishes); **a downward drag mid-page scrolls normally** (no refresh); the spinner springs back if released below the threshold; back/forward edge-swipes still work; normal browsing unaffected. Paste the build result / device confirmation.

- [ ] **Step 7: Commit**

```bash
git add src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt \
        src-tauri/gen/android/app/src/main/java/com/aegis/browser/MainActivity.kt
git commit -m "feat(mobile): pull-to-refresh (top-overscroll + spinner)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Milestone 3 — Tuning, docs, finish

### Task 4: On-device tuning pass + docs + finish

**Files:**
- Modify (as needed): `src-tauri/gen/android/app/src/main/java/com/aegis/browser/GestureContainer.kt`
- Modify: `src-tauri/CLAUDE.md`

- [ ] **Step 1: Tuning pass (owner-driven).** With the owner testing on-device, adjust only the constants in `GestureContainer` if the feel is off, rebuilding between changes:
  - `edgePx` (edge strip width, default `20f * density`) — raise if the edge is hard to hit, lower if it triggers too easily.
  - `hDistance()` (back/forward commit distance, default `min(0.25f*width, 96f*density)`) — raise to require a longer swipe.
  - `pullThreshold()` (refresh commit distance, default `96f * density`) and the `* 0.5f` pull damping — adjust pull resistance.
  - Arrow/spinner sizes (`18f`/`16f * density`) and the disc colour (`#1f6feb`).
  Commit any change with `fix(mobile): tune gesture <constant>`. If the feel is already good, skip this step (no empty commit).

- [ ] **Step 2: Renderer gate.** Confirm the chrome is untouched: `npm test`. Expected: `Tests 461 passed`. (No renderer files changed, so this is a guard, not a new test.)

- [ ] **Step 3: Document the gesture layer.** In `src-tauri/CLAUDE.md`, in the Android "Mobile chrome (`MainActivity.kt`)" section, add a bullet:

```markdown
- **Touch gestures (`GestureContainer.kt`).** One native `FrameLayout` wraps the tab
  WebViews (the chrome-bar margins live on it via `applyContentMargins()`, not per-tab).
  It uses the watch-then-steal model (`onInterceptTouchEvent`) to recognize an **edge-swipe
  back/forward** (a horizontal drag from a thin screen-edge strip — left=back, right=forward,
  with a ◀/▶ arrow) and **pull-to-refresh** (a downward drag while the active WebView is at
  `scrollY==0`, with a spinner), calling `goBack`/`goForward`/`reload` on the active WebView
  via the `GestureHost` interface the activity implements. `setSystemGestureExclusionRects`
  claims the edge strips from Android's system back gesture (API 29+); the activity calls
  `gestureContainer.stopRefresh()` from the active tab's `onPageFinished`. Nav reuses the
  existing `pushNavState` pipeline, so the chrome's address bar updates with no renderer code.
```

- [ ] **Step 4: Commit the docs**

```bash
git add src-tauri/CLAUDE.md
git commit -m "docs(mobile): document the Android touch-gesture layer

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

- [ ] **Step 5: Finish the branch.** Use superpowers:finishing-a-development-branch (the owner GUI-validates first; present the merge/PR/keep/discard options).

---

## Self-review notes (author)

- **Spec coverage:** architecture/GestureContainer → Task 1; edge-swipe back/forward + arrow + arbitration → Task 2; system-gesture-exclusion rects → Task 1 (`onSizeChanged`); pull-to-refresh + spinner + `stopRefresh` from `onPageFinished` → Task 3; "no renderer/IPC changes" → respected (only `.kt` + `CLAUDE.md`); data-flow reuse of `pushNavState` → automatic (Tasks 2–3 call `goBack`/`goForward`/`reload`); testing/owner-validation → each task's build + validate steps + Task 4 gate; feel-tuning risk → Task 4 Step 1.
- **Type consistency:** `GestureHost` methods (`gestureCanGoBack/Forward/AtTop/Back/Forward/Reload`) are declared in Task 1's interface, implemented on the activity in Task 1 Step 7, and called in Tasks 2–3. `Mode` enum (`NONE/BACK/FORWARD/REFRESH`) is defined in Task 1 and used in 2–3. `stopRefresh()` defined in Task 1, called in Task 3 Step 4. `gestureContainer` field defined in Task 1, used in Tasks 1/3.
- **Native caveat:** no headless tests — every task is owner-built/GUI-validated. Constants are starting values; Task 4 is the explicit on-device tuning pass.
- **Behavior-preservation:** Task 1 is a pure structural re-parent validated to browse exactly as before, so any regression is caught before gesture logic is added.

## As-built deltas (post-implementation)

Three divergences from the steps above, discovered during execution + on-device validation:

1. **Indicator draws in `dispatchDraw()`, not `onDraw()`.** On-device the arrow was invisible: a `ViewGroup`'s `onDraw()` paints *behind* its children, so the indicator was occluded by the opaque `MATCH_PARENT` content WebView. Fixed by drawing in `dispatchDraw()` after `super.dispatchDraw()` (and dropping the now-pointless `setWillNotDraw(false)`). Tasks 2 & 3's draw dispatch use `dispatchDraw`. (Captured as gotcha 11 in `src-tauri/CLAUDE.md`.)
2. **Defensive `mode` guards** added to `onInterceptTouchEvent`: an `ACTION_CANCEL -> { mode = Mode.NONE }` arm, and the `ACTION_DOWN` reset guarded as `if (!refreshing) mode = Mode.NONE` — the latter fixes a defect where touching the screen during an in-flight pull-to-refresh reload reset `mode` away from `REFRESH`, freezing/hiding the spinner until the load finished.
3. **Known follow-up gaps (accepted, not fixed):** a stalled load that never fires `onPageFinished` leaves the refresh spinner spinning indefinitely (matches platform `SwipeRefreshLayout`); switching tabs mid-refresh clears the spinner via the new active tab's page-finish rather than the originating tab's. Both are benign (`stopRefresh()` is idempotent) — candidates for a future timeout / `onReceivedError` stop.
