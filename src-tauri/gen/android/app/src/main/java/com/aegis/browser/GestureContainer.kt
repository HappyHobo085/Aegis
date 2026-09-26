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
    /** The tab the gestures act on — the pull-to-refresh latch is keyed on it. */
    fun gestureActiveTabId(): Int
    fun gestureBack()
    fun gestureForward()
    fun gestureReload()
  }

  private enum class Mode { NONE, BACK, FORWARD, REFRESH }

  private val density = resources.displayMetrics.density
  private val edgePx = 20f * density
  private val slop = ViewConfiguration.get(context).scaledTouchSlop.toFloat()
  private val pullMaxPx = 140f * density
  // Android's per-edge budget for system-gesture exclusion. A request LARGER than this is
  // IGNORED, not clamped — so a full-height strip on a tall phone drops the request
  // entirely (see updateGestureExclusion).
  private val exclusionBudgetPx = 200f * density

  private var mode = Mode.NONE
  private var startX = 0f
  private var startY = 0f
  private var curX = 0f
  private var curY = 0f
  // Pull-to-refresh latch, keyed by the OWNING TAB. The container is shared by every tab,
  // and the gesture always runs on the active one — but a tab that switched away before
  // its load finished never got the old single stopRefresh() (its onPageFinished was
  // filtered out on activeTabId), which left the latch set for the rest of the process:
  // onInterceptTouchEvent then refused every edge-swipe AND pull-to-refresh, mode stayed
  // REFRESH, and drawSpinner's postInvalidateOnAnimation() spun at 60fps forever. There
  // are now three ways out — this tab's onPageFinished, a tab switch (cancelRefresh), and
  // the hard timeout in startRefresh for a load that never finishes at all.
  private var refreshing = false
  private var refreshTabId = -1
  private var spin = 0f

  private val disc = Paint(Paint.ANTI_ALIAS_FLAG).apply { color = Color.parseColor("#1f6feb") }
  private val glyph = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 2.5f * density
    strokeCap = Paint.Cap.ROUND; strokeJoin = Paint.Join.ROUND
  }
  private val arc = Paint(Paint.ANTI_ALIAS_FLAG).apply {
    color = Color.WHITE; style = Paint.Style.STROKE; strokeWidth = 3f * density; strokeCap = Paint.Cap.ROUND
  }

  private fun hDistance() = min(0.25f * width, 96f * density)
  private fun pullThreshold() = 96f * density

  override fun onSizeChanged(w: Int, h: Int, ow: Int, oh: Int) {
    super.onSizeChanged(w, h, ow, oh)
    updateGestureExclusion()
  }

  /**
   * (Re)declare the edge strips we claim from Android's system gestures. No-op below
   * API 29 (the setter doesn't exist there).
   *
   * Two things the naive `Rect(0, 0, e, h)` request got wrong, both of which made the
   * feature silently dead on exactly the gesture-nav phones it targets:
   *  - Android IGNORES an over-budget exclusion request instead of clamping it. The cap
   *    is ~200dp per edge, and a full-height strip on a tall phone is several times that,
   *    so the whole request was dropped and the system back gesture won every swipe. The
   *    height is therefore capped at the budget and anchored to the BOTTOM of the
   *    container (the thumb end).
   *  - It claimed the right edge unconditionally even though the system back gesture is
   *    single-edge, and claimed edges the app cannot use. Now each edge is claimed only
   *    when the active tab can actually go that way, so an edge we would ignore is left
   *    to the system. The host re-runs this on tab activation and on every nav-state
   *    change (back/forward availability flips with each navigation).
   */
  fun updateGestureExclusion() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) return
    val h = height
    val e = edgePx.toInt()
    val cap = min(h, exclusionBudgetPx.toInt())
    val rects = ArrayList<Rect>(2)
    if (host.gestureCanGoBack()) rects.add(Rect(0, h - cap, e, h))
    if (host.gestureCanGoForward()) rects.add(Rect(width - e, h - cap, width, h))
    systemGestureExclusionRects = rects
  }

  override fun onInterceptTouchEvent(ev: MotionEvent): Boolean {
    when (ev.actionMasked) {
      MotionEvent.ACTION_DOWN -> {
        if (!refreshing) mode = Mode.NONE
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
        // Pull to refresh: downward drag while the page is at the very top.
        if (dy > slop && dy > abs(dx) && host.gestureAtTop()) {
          mode = Mode.REFRESH; curX = ev.x; curY = ev.y; return true
        }
      }
      MotionEvent.ACTION_CANCEL -> { mode = Mode.NONE }
    }
    return false
  }

  override fun onTouchEvent(ev: MotionEvent): Boolean {
    if (mode == Mode.NONE) return false
    when (ev.actionMasked) {
      MotionEvent.ACTION_MOVE -> { curX = ev.x; curY = ev.y; invalidate() }
      MotionEvent.ACTION_UP -> finishGesture()
      MotionEvent.ACTION_CANCEL -> { mode = Mode.NONE; invalidate() }
    }
    return true
  }

  private fun finishGesture() {
    when (mode) {
      Mode.BACK -> { if (curX - startX >= hDistance()) host.gestureBack(); mode = Mode.NONE }
      Mode.FORWARD -> { if (startX - curX >= hDistance()) host.gestureForward(); mode = Mode.NONE }
      Mode.REFRESH -> {
        if (curY - startY >= pullThreshold()) {
          startRefresh(host.gestureActiveTabId())
        } else {
          mode = Mode.NONE
        }
      }
      else -> mode = Mode.NONE
    }
    invalidate()
  }

  /** Latch the spinner on for [tabId]. It is released by that tab's onPageFinished, by a
   *  tab switch, or by the hard timeout — a load the WebView never reports finishing (an
   *  aborted navigation, a discarded tab) can no longer wedge every gesture forever. */
  private fun startRefresh(tabId: Int) {
    refreshing = true
    refreshTabId = tabId
    spin = 0f
    postInvalidateOnAnimation()
    postDelayed({ stopRefresh(tabId) }, REFRESH_TIMEOUT_MS)
  }

  /** Called by the host when tab [tabId] finishes (re)loading — hides the spinner. Only
   *  clears THIS tab's latch: a background tab finishing must not stop the spinner the
   *  user is currently watching on the active tab. */
  fun stopRefresh(tabId: Int) {
    if (refreshTabId == tabId) clearRefresh()
  }

  /** Drop the latch outright, whoever owns it — the host calls this on a tab switch (the
   *  spinner belonged to the tab being left behind, whose onPageFinished may never come). */
  fun cancelRefresh() = clearRefresh()

  private fun clearRefresh() {
    refreshTabId = -1
    if (!refreshing) return
    refreshing = false
    mode = Mode.NONE
    invalidate()
  }

  // Draw the indicator AFTER the child WebViews so it isn't occluded by the active
  // (opaque, MATCH_PARENT) tab WebView. A ViewGroup's onDraw() paints *behind* its
  // children; dispatchDraw() after super.dispatchDraw() paints on top.
  override fun dispatchDraw(canvas: Canvas) {
    super.dispatchDraw(canvas)
    when (mode) {
      Mode.BACK, Mode.FORWARD -> drawArrow(canvas)
      Mode.REFRESH -> drawSpinner(canvas)
      else -> {}
    }
  }

  private fun drawSpinner(canvas: Canvas) {
    val r = 16f * density
    val cx = width / 2f
    val cy: Float
    if (refreshing) {
      disc.alpha = 255
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

  companion object {
    /** Hard cap on the pull-to-refresh latch. Generous enough for a slow real page, short
     *  enough that a never-finishing load costs the user 15s of dead gestures, not a
     *  wedged session. */
    private const val REFRESH_TIMEOUT_MS = 15_000L
  }
}
