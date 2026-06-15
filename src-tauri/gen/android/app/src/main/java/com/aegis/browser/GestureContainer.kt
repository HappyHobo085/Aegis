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
      Mode.BACK -> if (curX - startX >= hDistance()) host.gestureBack()
      Mode.FORWARD -> if (startX - curX >= hDistance()) host.gestureForward()
      else -> {}
    }
    mode = Mode.NONE
    invalidate()
  }

  /** Called by the host when the active tab finishes (re)loading — hides the spinner. */
  fun stopRefresh() {
    if (refreshing) { refreshing = false; mode = Mode.NONE; invalidate() }
  }

  override fun onDraw(canvas: Canvas) {
    super.onDraw(canvas)
    when (mode) {
      Mode.BACK, Mode.FORWARD -> drawArrow(canvas)
      else -> {}
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
}
