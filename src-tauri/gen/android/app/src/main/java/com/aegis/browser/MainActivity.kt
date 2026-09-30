package com.aegis.browser

import android.Manifest
import android.app.DownloadManager
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.GeolocationPermissions
import android.webkit.JavascriptInterface
import android.webkit.PermissionRequest
import android.webkit.URLUtil
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.OnBackPressedCallback
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.ProxyConfig
import androidx.webkit.ProxyController
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import java.io.ByteArrayInputStream
import java.io.File
import java.util.concurrent.ConcurrentHashMap
import org.json.JSONObject

/**
 * Mobile is single-webview, so the desktop multi-webview content view
 * (Window::add_child) is a no-op on Android. We add a native content WebView below
 * the chrome's toolbar and bridge it to the React chrome via a JS interface
 * (window.AegisAndroid), so the app actually browses. Navigation events flow the
 * other way — the content WebView's WebViewClient pushes nav state into the chrome
 * webview (window.__aegisNavState) so the address bar tracks the current page.
 *
 * Multi-tab: the chrome drives per-tab native WebViews via activateTab/closeTab/discardTab.
 * The active tab's WebView is mirrored into contentWebView so all existing active-tab
 * logic (margins, overlay, nav, ad-block) keeps targeting "the active tab" unchanged.
 */
class MainActivity : TauriActivity(), GestureContainer.GestureHost {
  private var contentWebView: WebView? = null

  // Written on the UI thread (onWebViewCreate) but READ from a WebView network thread
  // (pushBlockedCount ← shouldInterceptRequest), so it needs a memory barrier — @Volatile,
  // like the other cross-thread scalars below.
  @Volatile private var chromeWebView: WebView? = null

  // One native WebView per tab (live tabs); the active one is mirrored into contentWebView
  // so the existing margin/overlay/nav logic keeps targeting "the active tab".
  private val tabWebViews = HashMap<Int, WebView>()
  // Per-tab WebChromeClient, kept so an HTML5-fullscreen view added to window.decorView
  // (which no tab owns) can be taken back down on teardown / Activity destroy. UI thread only.
  private val chromeClients = HashMap<Int, WebChromeClient>()
  // Live popup-capture WebViews (onCreateWindow). Each is a full WebView (~30-80 MB), so
  // every escape route has to destroy it: the URL capture, window.close(), a bounded
  // timeout for the about:blank + document.write pop-under that never navigates at all,
  // and onDestroy. UI thread only.
  private val popupTemps = HashSet<WebView>()
  // Per-tab zoom (textZoom percent, 100 == 1.0). Session-only (not persisted), matching
  // the desktop v1 design. Kept on discard so a reactivated tab restores its zoom;
  // dropped on close (session ends).
  //
  // Concurrent because `getZoom` is a @JavascriptInterface method and therefore runs on
  // the JS-bridge thread, not the UI thread (see the note above `Bridge`), while
  // `setZoom` writes it on the UI thread. A plain HashMap read across those two threads
  // is a data race. Only this map is read off the UI thread, so the type change is
  // local — the five call sites (clear, []?.let, remove, []=, and the new getter) all
  // take the same shape on a ConcurrentHashMap.
  private val tabZoom = ConcurrentHashMap<Int, Int>()
  // IDs of private (incognito-mode) tabs. Android WebView has no per-WebView data partition,
  // so strict privacy here means: while a private tab is ALIVE, the process-global cookie
  // manager is in no-cookie mode (see syncCookieAcceptance for why "alive", not "active");
  // private WebViews run with DOM storage + form data persistence disabled; and
  // cache/history/state are cleared at teardown. Cookie acceptance is restored when the last
  // private tab goes away.
  private val privateTabs = HashSet<Int>()
  private var activeTabId = -1
  // Per-tab current page URL (the ad-block first-party context), read on the network
  // thread in shouldInterceptRequest; concurrent for safe cross-thread reads.
  private val pageUrls = java.util.concurrent.ConcurrentHashMap<Int, String>()
  // Shield badge counters (the Android analog of the Rust adblock.rs counters; there's no
  // AppHandle in the JNI block path and no Tauri event bus on the content side, so they
  // live here and push window.__aegisBlockedCount to the chrome). sessionBlocked is the
  // monotonic session total; pageBlocked is per-tab and reset on each top-frame load.
  // Touched only from shouldInterceptRequest (a WebView network thread) and onPageStarted
  // (UI thread), so use thread-safe primitives.
  private val sessionBlocked = java.util.concurrent.atomic.AtomicInteger(0)
  private val pageBlocked = java.util.concurrent.ConcurrentHashMap<Int, Int>()
  // The gesture layer that wraps the tab WebViews (edge-swipe + pull-to-refresh); it's
  // the child of the chrome webview's parent that hosts the per-tab content WebViews.
  private var gestureContainer: GestureContainer? = null

  // The native content WebView is shown only when a real page is loaded AND no chrome
  // overlay (settings/sidebar/shield popover/…) is covering it. Tauri's setChromeOverlay
  // can't reach this native view, so the chrome drives it via the bridge instead. Both
  // flags are touched only on the UI thread.
  private var hasPage = false
  private var overlayHidden = false

  // True while a chrome sheet/menu is open — the Back button should close it (via the
  // chrome) before navigating the page. Set by the chrome through AegisAndroid.
  @Volatile private var backInterceptActive = false

  // System-bar insets (top status bar, bottom nav bar) captured in the insets listener;
  // applyContentMargins() uses them so the content sits in the safe area + chrome gaps.
  @Volatile private var statusTop = 0
  @Volatile private var navBottom = 0
  @Volatile private var sideLeft = 0
  @Volatile private var sideRight = 0

  // Chrome heights (px), cached for the bridges: top chrome = address bar + favourites
  // (72dp); bottom action bar = 56dp.
  private var topChromePx = 0
  private var bottomBarPx = 0

  // Chrome-hiding flags driven by the chrome via AegisAndroid; read by applyContentMargins()
  // so they survive rotation / inset changes. bottomBarHidden = the top-bar chevron;
  // fullscreen = the desktop-parity hide-all-chrome mode (content fills, Back exits).
  @Volatile private var bottomBarHidden = false
  @Volatile private var fullscreen = false

  // Current find-in-page query on the active tab (set by Bridge.find, cleared by
  // Bridge.findClose). Android's FindListener doesn't report the query back, so we
  // cache it here to include in the __aegisFindState push.
  @Volatile private var currentFindQuery = ""

  // A web permission request the user has not answered yet (camera, microphone or
  // geolocation). The `answer` lambda captures whichever platform callback the request
  // arrived with — a `PermissionRequest` to grant/deny, or a geolocation callback to
  // invoke — so the two very different WebView APIs share ONE queue, ONE prompt and ONE
  // `PermissionPrompt.requestId` space. Keyed by a counter this class owns: unlike
  // Linux's `NEXT_ID`, the id is minted on the platform that HOLDS the request, because
  // that is the side that must be able to answer it.
  private val pendingPermissions = HashMap<Int, PendingPermission>()
  private var nextPermissionId = 1

  /**
   * One unanswered web permission request. [tab] is the tab whose WebView raised it, so
   * closing that tab can answer it (a callback belonging to a destroyed WebView can only
   * be denied, never granted).
   */
  private class PendingPermission(
    val tab: Int,
    val origin: String,
    val permission: String,
    val answer: (allow: Boolean) -> Unit,
  )

  // Coalescing for the chrome pushes. noteBlocked → pushBlockedCount fires once per
  // BLOCKED request (a heavy ad-heavy page = dozens per navigation), and pushNavState
  // fires three times per navigation (onPageStarted + doUpdateVisitedHistory +
  // onPageFinished) — each one a separate evaluateJavascript round-trip into the chrome.
  // The chrome only ever renders the LATEST value, so we keep the newest payload per tab
  // and flush at most once per PUSH_FLUSH_MS. pushBlockedCount is reached from a WebView
  // network thread, hence the lock; the flush itself always runs on the UI thread.
  private val pushLock = Any()
  private val pendingNavJs = LinkedHashMap<Int, String>()
  private val pendingBlockedJs = LinkedHashMap<Int, String>()
  private var flushQueued = false
  private val pushHandler = Handler(Looper.getMainLooper())

  private fun updateContentVisibility() {
    contentWebView?.visibility = if (hasPage && !overlayHidden) View.VISIBLE else View.GONE
  }

  /** Position the content webview: fill the safe area minus the chrome gaps currently
   *  showing — the top chrome (unless fullscreen) and the bottom action bar (unless it's
   *  toggled off or fullscreen). Called from the insets listener and the chrome bridges. */
  private fun applyContentMargins() {
    val gc = gestureContainer ?: return
    (gc.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
      p.topMargin = (if (fullscreen) 0 else topChromePx) + statusTop
      p.bottomMargin = (if (fullscreen || bottomBarHidden) 0 else bottomBarPx) + navBottom
      p.leftMargin = if (fullscreen) 0 else sideLeft
      p.rightMargin = if (fullscreen) 0 else sideRight
      gc.layoutParams = p
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    // Hand the sync Keystore class to native BEFORE super.onCreate(), because that is what runs
    // Rust.create() → the Rust setup() hook → the boot-time sync restore, which up-calls
    // AegisKeystore. See NativeSyncKeystore for why Rust can't look the class up itself.
    try {
      NativeSyncKeystore.provideClass(AegisKeystore::class.java)
    } catch (t: Throwable) {
      Log.w("AegisSync", "could not provide the Keystore class to native", t)
    }
    super.onCreate(savedInstanceState)
    // Draw into the display cutout on every edge so notches / punch-holes / curved
    // edges are reported as insets (which we push to the chrome) instead of letterboxed.
    // minSdk is 24: _ALWAYS is API 30, _SHORT_EDGES is API 28, below 28 has no cutouts.
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_ALWAYS
      }
    } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
      window.attributes = window.attributes.apply {
        layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES
      }
    }
    // One receiver for the whole Activity rather than one per download: it recovers the
    // URL from the DownloadManager row itself (see settleDownload), so it needs no map to
    // keep in sync, it cannot leak a registration per file, and a transfer that completes
    // after a process restart still settles its row.
    registerDownloadReceiver()
    // Back has to go through the androidx dispatcher (see installBackCallback), and this
    // is the first point where the Activity owns a dispatcher with a live lifecycle.
    installBackCallback()
  }

  // --- Lifecycle ---------------------------------------------------------------------
  //
  // The tab WebViews are the app's memory. Each one pins this Activity's Context and a
  // renderer process, so without this teardown every tab survived an Activity destroy
  // (rotation, a font-scale/density change before configChanges covered it, a task
  // eviction) — and a background tab kept running page JS, timers and polling.

  override fun onPause() {
    super.onPause()
    for (wv in tabWebViews.values) wv.onPause()
    for (wv in popupTemps) wv.onPause()
    // Per-view onPause() does NOT stop JavaScript (platform doc) — it only pauses playback
    // and animations. pauseTimers() is what stops JS timers, and although it is an
    // INSTANCE method it is a process-GLOBAL request ("for all WebViews", platform doc), so
    // one call on the chrome webview — which always exists — freezes page JS, timers and
    // polling in every background tab.
    chromeWebView?.pauseTimers()
  }

  override fun onResume() {
    super.onResume()
    for (wv in tabWebViews.values) wv.onResume()
    for (wv in popupTemps) wv.onResume()
    chromeWebView?.resumeTimers()
  }

  override fun onDestroy() {
    // Undo the global timer pause FIRST: pauseTimers() is sticky, so an Activity destroyed
    // while paused would otherwise leave every WebView the process creates next frozen.
    chromeWebView?.resumeTimers()
    // Take down the HTML5-fullscreen views: they are added to window.decorView, not to a
    // tab, so no tab teardown would ever remove them.
    for (client in chromeClients.values) {
      try {
        client.onHideCustomView()
      } catch (t: Throwable) {
        Log.w("AegisLifecycle", "hide custom view on destroy failed", t)
      }
    }
    chromeClients.clear()
    // Popup capture WebViews are not in tabWebViews; destroy them through the same
    // once-only path (clearing the set first means the TTL timers become no-ops).
    val temps = popupTemps.toList()
    popupTemps.clear()
    for (wv in temps) destroyWebView(wv)
    for (wv in tabWebViews.values) {
      destroyWebView(wv, gestureContainer)
    }
    tabWebViews.clear()
    tabZoom.clear()
    privateTabs.clear()
    // Every private WebView is destroyed by this point, so no live tab is owed no-cookie mode.
    syncCookieAcceptance()
    pageUrls.clear()
    pageBlocked.clear()
    gestureContainer = null
    contentWebView = null
    chromeWebView = null
    activeTabId = -1
    pushHandler.removeCallbacksAndMessages(null)
    synchronized(pushLock) {
      pendingNavJs.clear()
      pendingBlockedJs.clear()
    }
    unregisterDownloadReceiver()
    super.onDestroy()
  }

  /** Destroy one WebView: stop it, drop its clients (so no callback can re-enter a dead
   *  view), detach it from the view system, then destroy it — the platform requires the
   *  removal BEFORE destroy(). Best-effort per step: a WebView that is already half-dead
   *  throws, and that must not abort the rest of the teardown. */
  private fun destroyWebView(wv: WebView, parent: ViewGroup? = null) {
    try {
      wv.stopLoading()
      // Drop our clients so no callback can re-enter a view we are tearing down.
      // setWebViewClient is @NonNull in the platform stub (so `null` is not assignable
      // from Kotlin) while setWebChromeClient is @Nullable — an empty client releases the
      // same reference.
      wv.webChromeClient = null
      wv.webViewClient = WebViewClient()
      // detach BEFORE destroy(): the platform requires the view out of the hierarchy first
      parent?.removeView(wv)
      wv.destroy()
    } catch (t: Throwable) {
      Log.w("AegisLifecycle", "webview teardown failed", t)
    }
  }

  // Back-press precedence, ONE definition in handleBackPress(), reached from two
  // entry points. The override below is only the LEGACY platform path: on API 33+ the
  // system delivers Back to the androidx OnBackPressedDispatcher (ComponentActivity
  // registers an OnBackInvokedDispatcher observer on ON_CREATE), and with no callback
  // enabled on it the dispatcher's fallback runnable calls
  // androidx.core.app.ComponentActivity.onBackPressed() NON-virtually, so a deprecated
  // override alone is never reached and Back just exits the app. installBackCallback()
  // registers the real path; the override stays so an OEM that still uses it behaves the
  // same. WryActivity registers its own callback only `if (handleBackNavigation)`, which
  // TauriActivity pins to false, so nothing else on this dispatcher.
  @Deprecated("Back press precedence: close an open chrome sheet, else page-back, else default")
  override fun onBackPressed() {
    if (!handleBackPress()) {
      @Suppress("DEPRECATION")
      super.onBackPressed()
    }
  }

  // (a) a chrome sheet/menu is open -> tell the chrome to close it
  // (window.__aegisMobileBack) and consume the press; (b) else the content page can go
  // back -> navigate it back; (c) else return false so the caller falls through to the
  // platform default (exit). The chrome sets backInterceptActive via the AegisAndroid
  // bridge whenever a sheet is open.
  private fun handleBackPress(): Boolean = when {
    backInterceptActive -> {
      chromeWebView?.evaluateJavascript(
        "window.__aegisMobileBack && window.__aegisMobileBack()", null,
      )
      true
    }
    contentWebView?.canGoBack() == true -> {
      contentWebView?.goBack()
      true
    }
    else -> false
  }

  // Tier (c) disables this callback before re-dispatching, so the press lands on the
  // platform default instead of re-entering handleOnBackPressed (a call to
  // super.onBackPressed() would come straight back here: it resolves to
  // androidx.activity.ComponentActivity.onBackPressed(), which is
  // getOnBackPressedDispatcher().onBackPressed()).
  private fun installBackCallback() {
    onBackPressedDispatcher.addCallback(
      this,
      object : OnBackPressedCallback(true) {
        override fun handleOnBackPressed() {
          if (!handleBackPress()) {
            isEnabled = false
            onBackPressedDispatcher.onBackPressed()
            isEnabled = true
          }
        }
      },
    )
  }

  /** Count one blocked ad/tracker subresource on tab [id] and record the running totals —
   *  the Android mirror of the Rust adblock::note_blocked → adblock.blockedCount event.
   *  Runs on a WebView network thread; the push to the chrome is coalesced (see
   *  [queuePush]). */
  private fun noteBlocked(id: Int) {
    val session = sessionBlocked.incrementAndGet()
    val page = pageBlocked.merge(id, 1, Integer::sum) ?: 1
    pushBlockedCount(id, page, session)
  }

  /** Reset tab [id]'s per-page count on a new top-frame navigation (badge page → 0,
   *  session unchanged) and push it — the Android mirror of adblock::reset_page. */
  private fun resetPageBlocked(id: Int) {
    pageBlocked[id] = 0
    pushBlockedCount(id, 0, sessionBlocked.get())
  }

  /** Push a BlockedCount { viewId, page, session } to the chrome webview's
   *  window.__aegisBlockedCount (installed by ipcClient.ts on Android). */
  private fun pushBlockedCount(id: Int, page: Int, session: Int) {
    val obj = JSONObject()
      .put("viewId", id)
      .put("page", page)
      .put("session", session)
    queuePush(pendingBlockedJs, id, "window.__aegisBlockedCount && window.__aegisBlockedCount($obj)")
  }

  /** Keep the newest [js] for tab [id] in [pending] and schedule a flush. Several tabs can
   *  be pending at once; the flush sends the newest payload for each. Reached from the UI
   *  thread (nav events) and from WebView network threads (the blocked-count path). */
  private fun queuePush(pending: MutableMap<Int, String>, id: Int, js: String) {
    val schedule = synchronized(pushLock) {
      pending[id] = js
      if (flushQueued) false else { flushQueued = true; true }
    }
    if (schedule) pushHandler.postDelayed({ flushPushes() }, PUSH_FLUSH_MS)
  }

  /** Take everything queued since the last flush: the newest payload per tab, nav state
   *  first so the address bar is never a frame behind the badge. */
  private fun drainPendingPushes(): List<String> = synchronized(pushLock) {
    flushQueued = false
    val out = ArrayList<String>(pendingNavJs.size + pendingBlockedJs.size)
    out.addAll(pendingNavJs.values)
    out.addAll(pendingBlockedJs.values)
    pendingNavJs.clear()
    pendingBlockedJs.clear()
    out
  }

  /** Deliver the coalesced chrome pushes. Runs on the UI thread (main-looper Handler),
   *  so evaluateJavascript is safe here and no per-call post is needed. */
  private fun flushPushes() {
    val payloads = drainPendingPushes()
    if (payloads.isEmpty()) return
    val chrome = chromeWebView ?: return
    try {
      payloads.forEach { chrome.evaluateJavascript(it, null) }
    } catch (t: Throwable) {
      Log.w("AegisPush", "chrome push failed", t)
    }
  }

  /** Build a per-tab WebViewClient. All fields (pageUrls, pushNavState) are threaded
   *  through [id] so each tab's navigation events carry the right tab identity — and so
   *  the reactive UI (malware interstitial, popup first-party context) acts on the tab
   *  that actually fired the event, never on whichever tab happens to be active. */
  private fun makeContentClient(id: Int): WebViewClient = object : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      pageUrls[id] = url
      resetPageBlocked(id)
      pushNavState(id, url, true, view)
    }

    override fun onPageFinished(view: WebView, url: String) {
      pushNavState(id, url, false, view)
      // Record the visit in the Rust core's history store. On desktop this comes from
      // wry's on_page_load (nav.rs); here the content view is a native WebView, so
      // Kotlin is the only side that sees the load and has to report it down. The core
      // resolves the tab's privateness itself from `id` — never pass a flag from here.
      // Wrapped: a native failure here must not take down a page that loaded fine.
      try {
        NativeHistory.recordVisit(id, url, view.title ?: "")
      } catch (t: Throwable) {
        Log.w("AegisHistory", "recordVisit failed for $url", t)
      }
      // Per-TAB, not "the active tab": the pull-to-refresh spinner belongs to the tab the
      // gesture ran on, and this is the only reliable end to it. Filtering on activeTabId
      // left the latch set whenever the user switched tabs mid-load, which killed
      // edge-swipe back/forward AND pull-to-refresh for the rest of the process.
      gestureContainer?.stopRefresh(id)
    }

    override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
      pageUrls[id] = url
      pushNavState(id, url, view.progress < 100, view)
    }

    // Per-request guard (runs on a WebView network thread; native calls block
    // briefly on their engine thread). Block malware-host subresources and
    // ad/tracker requests with an empty response; allow the rest (null) so the
    // WebView fetches them normally.
    override fun shouldInterceptRequest(
      view: WebView,
      request: WebResourceRequest,
    ): WebResourceResponse? {
      val url = request.url?.toString() ?: return null
      if (!url.startsWith("http")) return null // skip about:/data:/blob:/file:
      return try {
        val host = request.url?.host
        // First-party context. For the top-level DOCUMENT, the document is by definition its
        // own first party — and `pageUrls[id]` is still the PREVIOUS page at this point
        // (onPageStarted/doUpdateVisitedHistory for this navigation have not run yet), so using
        // it here evaluated document-type ad rules against the wrong origin and could block a
        // legitimate first-party document into a blank page. Subresources keep using the
        // committed page URL.
        val firstParty =
          if (request.isForMainFrame) url else (pageUrls[id] ?: "")
        when {
          host != null && NativeSafety.isMalwareHost(host) -> {
            Log.i("AegisSafety", "BLOCK malware $url")
            blockedResponse()
          }
          NativeAdblock.shouldBlock(url, firstParty, requestType(url, request)) -> {
            Log.i("AegisAdblock", "BLOCK $url")
            noteBlocked(id)
            blockedResponse()
          }
          else -> null
        }
      } catch (t: Throwable) {
        Log.w("AegisGuard", "intercept failed for $url", t)
        null
      }
    }

    // Main-frame navigations the page initiates (link clicks; some redirects):
    // block malware (→ warning page), upgrade http→https (HTTPS-Only). Typed and
    // programmatic navigations are guarded in Bridge.navigate instead.
    override fun shouldOverrideUrlLoading(
      view: WebView,
      request: WebResourceRequest,
    ): Boolean {
      val raw = request.url?.toString() ?: return true
      // ONE scheme allowlist, the same [isLoadableUrl] every load site funnels
      // through. This used to read `if (!raw.startsWith("http")) return false`, and
      // `false` means "let the WebView proceed" — so a page-initiated main-frame
      // navigation to data:/file:/content:/blob: was ALLOWED here while the typed
      // path (Bridge.navigate -> [blockReason]) refused the very same URL, and the
      // allowlist the app already had ([isLoadableUrl]) was never consulted for a
      // navigation the PAGE started. That is a second scheme list by another name:
      // a prefix test standing in for the allowlist. Refuse it, and say why, on the
      // SAME block page the other two refusals use — a silent block would look like
      // a broken page.
      if (!isLoadableUrl(raw)) {
        Log.i("AegisNav", "refused $raw: $SCHEME_REASON")
        showMalwareWarning(id, view, raw, SCHEME_REASON)
        return true
      }

      // A full-window chrome overlay (Settings/Downloads/shield) covers the page, so
      // the user is not driving it — any navigation the CONTENT initiates is a
      // script/ad redirect, which is exactly what malvertising fires on the
      // resize/blur that opening an overlay causes. Desktop cancels those in
      // `nav::decide_navigation` (`lay.overlay && !lay.sidebar`); this is the same
      // rule, and it is checked in the same ORDER (after the scheme allowlist,
      // before the redirect guard). Without it the overlay was VISIBILITY-ONLY:
      // the page kept loading underneath, so the destination still reached
      // `pageUrls[id]` and `NativeHistory.recordVisit` recorded a visit the user
      // never asked for. Deliberately SILENT — the page is covered, so nothing is
      // visible, and the user returns to the page they were on when the overlay
      // closes, which is precisely the desktop behaviour. There is no sidebar
      // tier on Android (the mobile chrome never calls `view.setSidebar`), so
      // `lay.overlay && !lay.sidebar` reduces to this one flag; `setContentHidden`
      // is the Android mirror of `view.setChromeOverlay`.
      if (overlayHidden) {
        Log.i("AegisNav", "refused $raw: a chrome overlay covers the page")
        return true
      }

      // Scripted cross-origin top-frame redirect guard (anti-malvertising).
      val current = pageUrls[id] ?: ""
      val scripted = !request.hasGesture()
      if (current.isNotEmpty() && redirectBlocked(current, raw, scripted, request.isForMainFrame)) {
        Log.i("AegisRedirect", "BLOCK $raw (from $current)")
        showRedirectBlocked(current, raw)
        return true
      }

      return when (val target = secureUrl(raw)) {
        // Act on THIS tab: a background tab hitting a malware host must show the warning in
        // its own webview, not replace the page the user is actually looking at.
        null -> {
          showMalwareWarning(id, view, raw, MALWARE_REASON)
          true
        }
        raw -> false // unchanged: let the WebView proceed
        else -> {
          view.loadUrl(target)
          true
        }
      }
    }
  }

  /** Build tab [id]'s WebChromeClient: HTML5 fullscreen (video etc.) and multi-window
   *  (target=_blank / window.open → background tab via __aegisOpenTab). It is per-tab
   *  because the popup path needs the OPENER's identity (its first-party ad-block context
   *  and its "no gesture" answer), not the active tab's. */
  private fun makeChromeClient(id: Int): WebChromeClient = object : WebChromeClient() {
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    /** A page that changes its OWN title after load \u2014 an SPA route change, a Gmail unread
     *  count, a YouTube video title. Without this the tab strip keeps showing the title from
     *  page load: visibly stale, and it never self-corrects.
     *
     *  This is Android's half of the desktop `on_document_title_changed` hook in nav.rs. wry
     *  has an equivalent (`RustWebChromeClient.onReceivedTitle`) but it never sees this tab:
     *  the content WebView here is OUR OWN Kotlin view, not a wry webview \u2014 `spawn_tab` is
     *  `#[cfg(desktop)]` and its Android counterpart is a no-op.
     *
     *  Re-uses [pushNavState] rather than a new push: it already carries `title` in exactly
     *  the desktop `nav.state` shape, so the chrome needs one handler for both platforms.
     *  `loading` is false \u2014 nothing is loading when a page merely renames itself. */
    override fun onReceivedTitle(view: WebView, title: String?) {
      super.onReceivedTitle(view, title)
      pushNavState(id, view.url ?: "", false, view)
    }

    override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
      if (customView != null) onHideCustomView()
      customView = view
      customCallback = callback
      view.setBackgroundColor(Color.BLACK)
      (window.decorView as ViewGroup).addView(
        view,
        FrameLayout.LayoutParams(
          FrameLayout.LayoutParams.MATCH_PARENT,
          FrameLayout.LayoutParams.MATCH_PARENT,
        ),
      )
      WindowInsetsControllerCompat(window, window.decorView).apply {
        systemBarsBehavior =
          WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        hide(WindowInsetsCompat.Type.systemBars())
      }
    }

    override fun onHideCustomView() {
      val v = customView ?: return
      (window.decorView as ViewGroup).removeView(v)
      customView = null
      WindowInsetsControllerCompat(window, window.decorView)
        .show(WindowInsetsCompat.Type.systemBars())
      customCallback?.onCustomViewHidden()
      customCallback = null
    }

    // A site asking for the camera or the microphone. Without this override the
    // WebView DENIES every request silently, which is why the mobile permissions list
    // could never be populated and a geolocation site simply never worked: there was no
    // prompt, and no remembered decision either.
    override fun onPermissionRequest(request: PermissionRequest) {
      val resources = request.resources
      // The resource set is a SET, so one request can be for the camera, the microphone
      // or both, and the store keys one (origin, permission) row per NAME — the same
      // vocabulary the desktop `classify` produces, so a store row written on one
      // platform means the same thing on the other.
      val permission = permissionFor(resources)
      if (permission == null) {
        // Nothing Aegis can key, and the platform WebView has no callback for the
        // desktop's `notifications` / `pointer-lock` names either. Denying is the
        // platform default and is also the desktop `classify` "other" rule: a prompt the
        // user could answer but that nothing would act on is worse than a silent no.
        request.deny()
        return
      }
      // `PermissionRequest.getOrigin()` is a Uri, not a String: the platform hands
      // back the origin as a parsed value and Rust normalizes it from text. An
      // absent origin is left empty, and askUser refuses to key a row for it.
      val origin = request.origin?.toString() ?: ""
      askUser(id, origin, permission) { allow ->
        if (allow) {
          request.grant(resources)
          requestAndroidPermissionFor(permission)
        } else {
          request.deny()
        }
      }
    }

    // Geolocation arrives through its OWN callback on the platform WebView — it is
    // never part of a `PermissionRequest`, so it is a second door into the same queue
    // and the same prompt rather than a second policy.
    override fun onGeolocationPermissionsShowPrompt(
      origin: String,
      callback: GeolocationPermissions.Callback,
    ) {
      askUser(id, origin, "geolocation") { allow ->
        // The third argument is the platform's own "retain this answer" flag. It is
        // deliberately false: that grant is app-wide and lives outside Aegis, while
        // Aegis re-prompts per origin and records the choice itself, in the store
        // `permissions.list` answers from on every platform.
        callback.invoke(origin, allow, false)
        if (allow) requestAndroidPermissionFor("geolocation")
      }
    }

    // Task 9: target=_blank / window.open → background tab.
    // A temporary WebView captures the target URL, routes it to a new chrome tab
    // via window.__aegisOpenTab (installed by Milestone 2), then self-destroys.
    override fun onCreateWindow(
      view: WebView,
      isDialog: Boolean,
      isUserGesture: Boolean,
      resultMsg: android.os.Message,
    ): Boolean {
      val transport = resultMsg.obj as? WebView.WebViewTransport ?: return false
      val temp = WebView(this@MainActivity)
      // The popup renders real web content while it lives here, so it gets the same
      // hardening as a tab (no file:// or content:// reads, no cleartext subresources).
      hardenContentWebView(temp.settings)
      popupTemps.add(temp)
      // A capture WebView is a full WebView (~30-80 MB), so EVERY exit destroys it. The
      // URL capture below only covers popups that navigate; the two common shapes it
      // misses are (a) window.open() with no URL, which the opener then fills with
      // document.write / document.open — the canonical ad pop-under, the exact thing this
      // handler exists to suppress — and (b) a popup the page closes with window.close(),
      // which reaches onCloseWindow below and used to leak every time. The TTL covers both,
      // and onDestroy (see there) is the backstop if the process outlives the activity.
      // Destroy is posted because tearing a WebView down from inside its own client
      // callback is fragile; the TTL is not in a callback, but it reuses the same helper.
      temp.postDelayed({ destroyPopupTemp(temp) }, POPUP_TEMP_TTL_MS)
      temp.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
          val url = req.url?.toString() ?: return true
          // Drop ad pop-unders instead of opening a background tab: blank/script-scheme
          // shells (window.open('about:blank') the opener scripts → a dead empty tab)
          // and ad/tracker destinations (same engine + synced toggle/allowlist as
          // shouldInterceptRequest). The opener is THIS tab — a background tab's popup is
          // judged against the page that opened it, not the page the user is looking at.
          val lower = url.trim().lowercase()
          val opener = pageUrls[id] ?: ""
          val drop = try {
            lower.isEmpty() || lower.startsWith("about:") || lower.startsWith("javascript:") ||
              NativeAdblock.shouldBlock(url, opener, "document")
          } catch (t: Throwable) {
            // Fail open (let the link open) + log, like the shouldInterceptRequest guard:
            // a JNI error here would otherwise propagate out of a UI-thread callback.
            Log.w("AegisAdblock", "popup check failed for $url", t)
            false
          }
          if (drop) {
            temp.post { destroyPopupTemp(temp) }
            return true
          }
          chromeWebView?.evaluateJavascript(
            "window.__aegisOpenTab && window.__aegisOpenTab(${JSONObject.quote(url)})",
            null,
          )
          temp.post { destroyPopupTemp(temp) }
          return true
        }
      }
      temp.webChromeClient = object : WebChromeClient() {
        // window.close() → destroy, or a popup-closing ad loop leaks a WebView per call.
        override fun onCloseWindow(closed: WebView) {
          closed.post { destroyPopupTemp(closed) }
        }
      }
      transport.webView = temp
      resultMsg.sendToTarget()
      return true
    }
  }

  /** Destroy a popup capture WebView exactly once. Membership in [popupTemps] IS the
   *  liveness check, so the URL capture, the TTL timer and onDestroy can all race here
   *  and only the first one through destroys it. */
  private fun destroyPopupTemp(wv: WebView) {
    if (!popupTemps.remove(wv)) return // already destroyed
    try {
      wv.stopLoading()
      wv.destroy()
    } catch (t: Throwable) {
      Log.w("AegisPopup", "popup teardown failed", t)
    }
  }

  /** Create a new native WebView for [id], configure it, add it hidden to the container,
   *  and begin loading [url]. The caller registers it in tabWebViews. */
  // The document-start script (pop-under guard + injected ad-block tier) from the Rust
  // adblock_inject module, up to ~1MB — so it is cached rather than rebuilt per tab
  // (re-reading it per tab would copy ~1MB over JNI per tab).
  //
  // The cache is keyed BY (toggle, host), not a single value: the script depends on BOTH
  // the ad-block on/off toggle and the per-host allowlist, and a page exempt on either axis
  // must receive NO ad-block injection. A single process-wide value would hand whichever tab
  // was created first its script to every later tab, so the policy would apply to the wrong
  // pages (or to none). Keying by host keeps the ~1MB saving for the overwhelmingly common
  // case of a user browsing one site; adding the toggle to the key is what stops a
  // mid-session toggle change from being masked by the cache for the rest of the process.
  //
  // The toggle is read from NATIVE, not from a local field, so this cache cannot drift from
  // the interceptor's view of it. It is a cheap AtomicBool load.
  //
  // A JNI failure returns "" — which disables injection rather than crashing — and is NOT
  // cached, so a later tab retries instead of losing injection for the whole process. Warmed
  // on a worker thread at boot (see onWebViewCreate) so the build never lands on the UI
  // thread.
  /** The cache is BOUNDED, and the bound is a plain number here so the Rust suite can
   *  read it. Each entry is one host's whole ad-block + farble + WebRTC document-start
   *  layer, which `src-tauri/AGENTS.md` measures at roughly a megabyte, and the key
   *  includes the ad-block toggle, so a long session that visits many hosts (and flips
   *  the toggle) used to grow the process heap without limit. Least-recently-USED is
   *  the right policy: a user bouncing between a few sites re-uses their entries, so a
   *  small cache does not cost a rebuild. */
  // `val`, not `const val`: this is a member of the Activity CLASS, and Kotlin only allows
  // `const val` at top level or in a named/companion object. The Rust suite reads the literal
  // 32 straight out of this line, so keep the value on the same line as the name.
  private val MAX_DOCUMENT_START_CACHE_ENTRIES = 32

  /** `documentStartScript` is called from the UI thread when a tab is created AND from
   *  the boot warm-up worker, so the map is guarded rather than merely concurrent. */
  private val documentStartScriptLock = Any()

  private val documentStartScriptCache =
    java.util.LinkedHashMap<String, String>(MAX_DOCUMENT_START_CACHE_ENTRIES, 0.75f, true)

  private fun documentStartScript(host: String): String {
    // NUL cannot appear in a hostname, so it is an unambiguous key separator.
    val key = (if (adblockEnabled()) "on" else "off") + "\u0000" + host
    synchronized(documentStartScriptLock) {
      documentStartScriptCache[key]?.let { return it }
    }
    val script = try {
      NativeInject.documentStartScript(host)
    } catch (t: Throwable) {
      Log.w("AegisInject", "document-start script unavailable; injection disabled", t)
      ""
    }
    if (script.isNotEmpty()) synchronized(documentStartScriptLock) {
      // Evict the least-recently-USED entries before inserting, so the map can never
      // exceed its bound no matter how many hosts a session visits. `accessOrder` is
      // what makes the iterator hand back the least recently READ entry rather than
      // the oldest inserted one.
      val eldest = documentStartScriptCache.entries.iterator()
      while (documentStartScriptCache.size >= MAX_DOCUMENT_START_CACHE_ENTRIES &&
        eldest.hasNext()
      ) {
        eldest.next()
        eldest.remove()
      }
      documentStartScriptCache[key] = script
    }
    return script
  }

  /** The ad-block toggle as the NATIVE interceptor sees it. Defaults to ON if native is
   *  unreachable: a key that silently read "off" when it could not ask would pin the whole
   *  process to the wrong script for every tab created afterwards. */
  private fun adblockEnabled(): Boolean = try {
    NativeAdblock.enabled()
  } catch (_: Throwable) {
    true
  }

  /** Hardening for every CONTENT WebView (a tab, and the popup capture alike): a browsed
   *  page gets no filesystem / content-provider reads and no cleartext subresources.
   *  These are independent switches and the platform only defaults them to false from
   *  API 30 — minSdk is 24, so on Android 7-9 a content WebView could otherwise read
   *  file:// and content:// URIs, and any page could pull a cleartext subresource into an
   *  https document. Deliberately NOT applied to the chrome webview: it serves the local
   *  Tauri UI and keeps the settings Rust configured for it. */
  // setAllowFileAccessFromFileURLs is deprecated (a no-op from API 30, where file access is
  // off by default) but is still the ONLY control over file:// XHR on Android 7-9, which
  // minSdk 24 still covers — so it is called deliberately.
  @Suppress("DEPRECATION")
  private fun hardenContentWebView(s: WebSettings) {
    s.setAllowFileAccess(false)
    s.setAllowContentAccess(false)
    s.setAllowFileAccessFromFileURLs(false)
    s.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW)
    // Safe Browsing exists from API 26 (minSdk is 24).
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) s.safeBrowsingEnabled = true
  }

  private fun createTabWebView(id: Int, url: String, isPrivate: Boolean = false): WebView {
    val wv = WebView(this)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = !isPrivate
    wv.settings.databaseEnabled = !isPrivate
    wv.settings.saveFormData = !isPrivate
    hardenContentWebView(wv.settings)
    // Anti-fingerprint: present a vanilla mobile Chrome UA (no "; wv" WebView marker).
    wv.settings.userAgentString = CHROME_UA
    // Replay any session zoom stored for this tab (e.g. after a discard→reactivate) so
    // the user's zoom survives the WebView being recreated. No-op when unset (first open).
    tabZoom[id]?.let { wv.settings.textZoom = it }
    if (isPrivate) {
      // Strict private mode: avoid persistent WebView stores for this tab and refuse cookies
      // for as long as it is alive (syncCookieAcceptance owns the process-global gate).
      wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE
      CookieManager.getInstance().setAcceptThirdPartyCookies(wv, false)
    }
    // Multi-window support for target=_blank / window.open (Task 9).
    wv.settings.setSupportMultipleWindows(true)
    wv.settings.javaScriptCanOpenWindowsAutomatically = true
    wv.webChromeClient = makeChromeClient(id).also { chromeClients[id] = it }
    wv.webViewClient = makeContentClient(id)
    // Find-in-page: receive match counts from findAllAsync and push them to the chrome
    // via __aegisFindState. Only push when this tab is the active one (mirroring
    // pushNavState's active-tab guard). activeOrdinal is 0-based; the chrome shows
    // 1-based, so we pass activeOrdinal + 1 (clamped to 0 when there are no matches).
    wv.setFindListener { activeOrdinal, numberOfMatches, isDoneCounting ->
      if (isDoneCounting && id == activeTabId) {
        pushFindState(id, numberOfMatches, if (numberOfMatches > 0) activeOrdinal + 1 else 0)
      }
    }
    // Inject the pop-under guard + ad-block tier at document-start in the page main world
    // (and all frames), before page scripts run — the Android analog of the desktop
    // initialization_script_for_all_frames. Guarded on the runtime feature (older System
    // WebView lacks DOCUMENT_START_SCRIPT → would throw); a malformed origin rule can also
    // throw IllegalArgumentException, so keep the try/catch.
    // The content host, read ONCE and shared by the two per-site policy getters below: the
    // ad-block allowlist (an allowlisted page gets no ad-block injection) and the
    // SEPARATE farble fp-allowlist. An empty host means "unknown" and both Rust getters
    // treat it as not-allowlisted, i.e. the protections stay on.
    val contentHost = try {
      Uri.parse(url).host ?: ""
    } catch (t: Throwable) {
      Log.w("AegisInject", "could not read the tab host", t)
      ""
    }
    val inject = documentStartScript(contentHost)
    if (inject.isNotEmpty() &&
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      try {
        WebViewCompat.addDocumentStartJavaScript(wv, inject, setOf("*"))
      } catch (t: Throwable) {
        Log.w("AegisInject", "document-start inject failed", t)
      }
    }
    // WebRTC IP-leak shim, document-start, per the user's webrtcPolicy. Read fresh per
    // tab (NOT cached) so a policy change applies to new tabs; "" when no filtering
    // applies ("default" policy). `contentHost` (read above) is passed so the per-site
    // WebRTC exemption applies here too — otherwise the exemption would be desktop-only
    // while the ad-block allowlist it used to piggy-back on was synced to every device.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val webrtc = try {
        NativeWebrtc.shimScript(contentHost)
      } catch (t: Throwable) {
        Log.w("AegisWebrtc", "webrtc shim unavailable", t)
        ""
      }
      if (webrtc.isNotEmpty()) {
        try {
          WebViewCompat.addDocumentStartJavaScript(wv, webrtc, setOf("*"))
        } catch (t: Throwable) {
          Log.w("AegisWebrtc", "webrtc shim inject failed", t)
        }
      }
    }
    // Anti-fingerprinting (farbling) shim, document-start, per the user's antiFingerprint
    // level. Read fresh per tab so a level change applies to new tabs; "" when no farbling
    // applies (level "off" or clamped bogus value). `contentHost` (read above) is passed so
    // the Rust JNI getter can check the per-site fp-allowlist (mirrored from FarbleState).
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val farble = try {
        NativeFarble.farbleScript(contentHost)
      } catch (t: Throwable) {
        Log.w("AegisFarble", "farble shim unavailable", t)
        ""
      }
      if (farble.isNotEmpty()) {
        try {
          WebViewCompat.addDocumentStartJavaScript(wv, farble, setOf("*"))
        } catch (t: Throwable) {
          Log.w("AegisFarble", "farble shim inject failed", t)
        }
      }
    }
    // Vault autofill badge + form detection, document-start. Handles password-field
    // detection, autofill-badge rendering, badge clicks, and form-submission listening.
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val vaultScript = try {
        NativeFormDetect.formDetectionScript()
      } catch (t: Throwable) {
        Log.w("AegisVaultInject", "vault script unavailable", t)
        ""
      }
      if (vaultScript.isNotEmpty()) {
        try {
          WebViewCompat.addDocumentStartJavaScript(wv, vaultScript, setOf("*"))
        } catch (t: Throwable) {
          Log.w("AegisVaultInject", "vault inject failed", t)
        }
      }
    }
    // Downloads are per-tab: the listener records the row with THIS tab's privateness, so
    // a private tab's download is not listed the way its history and its cache are not.
    wireDownloadListener(wv, id, isPrivate)
    val lp = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    wv.visibility = View.GONE
    gestureContainer?.addView(wv, lp)
    // Re-apply the navigation policy at the single place that actually loads: no caller may
    // hand a content WebView a file:// or content:// URL. loadableUrl is idempotent, so
    // activateTab's earlier application of the same policy costs nothing.
    val start = loadableUrl(url)
    pageUrls[id] = start
    wv.loadUrl(start)
    return wv
  }

  override fun onWebViewCreate(webView: WebView) {
    chromeWebView = webView
    // Defer until the chrome webview is attached so we can share its parent container.
    webView.post {
      val parent = (webView.parent as? ViewGroup) ?: findViewById(android.R.id.content)
      // Chrome heights are cached below; actual WebViews are created lazily by
      // activateTab (the chrome calls it on mount for the first tab).
      // Slim top chrome = address bar (48dp) + favourites strip (36dp) = 84dp; the
      // bottom action bar is 56dp. These MUST stay in sync with src/lib/layout.ts
      // (MOBILE_ADDRESS_H + MOBILE_FAV_H for the top, MOBILE_BOTTOMBAR_H for the bottom).
      // The favourites strip is 36dp (was 24dp) so its chips clear the touch-target floor.
      val density = resources.displayMetrics.density
      val top = (84 * density).toInt()
      val bottomBar = (56 * density).toInt()
      topChromePx = top
      bottomBarPx = bottomBar
      val gc = GestureContainer(this, this)
      val gcLp = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
      gcLp.topMargin = top
      gcLp.bottomMargin = bottomBar
      parent.addView(gc, gcLp)
      gestureContainer = gc
      // Keep the content webview below the status bar and above the system nav bar +
      // the bottom action bar (when the top-bar toggle hides the bar, the content
      // reclaims the 56dp gap). Recomputed on every inset change (rotation, gesture vs
      // 3-button nav). We ALSO push the real system-bar insets to the chrome as CSS vars:
      // on Android WebView env(safe-area-inset-*) reports the display cutout, NOT the
      // status/nav bars, so the chrome's fixed top/bottom bars need these to clear them.
      ViewCompat.setOnApplyWindowInsetsListener(parent) { _, insets ->
        val bars = insets.getInsets(
          WindowInsetsCompat.Type.systemBars() or WindowInsetsCompat.Type.displayCutout(),
        )
        statusTop = bars.top
        navBottom = bars.bottom
        sideLeft = bars.left
        sideRight = bars.right
        applyContentMargins()
        val js =
          "document.documentElement.style.setProperty('--aegis-inset-top','${bars.top / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-bottom','${bars.bottom / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-left','${bars.left / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-right','${bars.right / density}px');"
        webView.evaluateJavascript(js, null)
        insets
      }
      ViewCompat.requestApplyInsets(parent)
      // Let the React chrome (in the chrome webview) drive this content webview.
      webView.addJavascriptInterface(Bridge(), "AegisAndroid")
      // Boot-apply the persisted proxy config (if any) so a saved ON proxy is live
      // from the very first navigation — before the React chrome can call setProxy.
      // ProxyController.setProxyOverride is PROCESS-GLOBAL: it routes ALL WebViews in
      // this process (content AND chrome) through the proxy.  The chrome's own origin
      // is bypassed via bypassSimpleHostnames() + addDirect() in the shared
      // proxyBuilder(), so the React UI itself is NOT proxied.  If the feature is
      // unsupported (old WebView) this is a graceful no-op.
      applyBootProxy()
      // Warm the native side off the UI thread, for the same reason: the adblock engine
      // parses EasyList once, and the document-start script getter builds a
      // multi-hundred-KB-to-~1MB JS string. Both are cached afterwards, so this cost is
      // paid once per process instead of stalling the first tab's activation. A race with
      // the first real read just builds the string twice.
      Thread {
        try {
          NativeAdblock.shouldBlock("https://aegis.invalid/", "https://aegis.invalid/", "other")
        } catch (t: Throwable) {
          Log.w("AegisAdblock", "engine warm-up failed", t)
        }
        try {
          documentStartScript("")
        } catch (t: Throwable) {
          Log.w("AegisInject", "script warm-up failed", t)
        }
      }.start()
    }
  }

  /** The ONE ProxyConfig builder, shared by the boot path and the bridge. The bypass list
   *  used to be duplicated verbatim in both and HAD DIVERGED (boot read bypassHosts as a
   *  JSON array, the bridge took a comma-split string), so the two could never be kept in
   *  lockstep. Throws IllegalArgumentException from addProxyRule/addBypassRule on a
   *  malformed entry — callers must build inside their own try. */
  private fun proxyBuilder(scheme: String, host: String, port: Int, bypassHosts: List<String>): ProxyConfig {
    val builder = ProxyConfig.Builder().addProxyRule("$scheme://$host:$port")
    // Bypass the chrome's own origin (localhost / tauri.localhost) + simple hostnames
    // so the React UI is not proxied.  Fall through to direct for non-matching rules.
    builder.bypassSimpleHostnames()
    // Explicitly bypass the chrome's own origin so the React UI is never proxied.
    // bypassSimpleHostnames() only covers dotless hostnames; tauri.localhost is dotted
    // and would otherwise be routed through the proxy, breaking the chrome UI.
    builder.addBypassRule("tauri.localhost")
    builder.addBypassRule("127.0.0.1")
    builder.addBypassRule("localhost")
    builder.addDirect()
    for (h in bypassHosts) {
      val t = h.trim()
      if (t.isNotEmpty()) builder.addBypassRule(t)
    }
    return builder.build()
  }

  /** Proxy sanity check shared by both apply paths. A bad scheme/host/port from the chrome
   *  (a typo in Settings) must be a logged no-op, not an IllegalArgumentException out of
   *  ProxyConfig.Builder on the UI thread. */
  private fun isValidProxy(scheme: String, host: String, port: Int): Boolean =
    (scheme == "http" || scheme == "socks5") && host.isNotEmpty() && port in 1..65535

  /**
   * Apply the persisted proxy config at boot (called once from onWebViewCreate.post).
   * Reads the Rust `proxy::ANDROID_PROXY_CONFIG` global via `NativeProxy.proxyConfig()`
   * and calls `ProxyController.setProxyOverride` / `clearProxyOverride` as appropriate.
   *
   * PARITY DIFFERENCE (documented): `ProxyController.setProxyOverride` is PROCESS-GLOBAL
   * on Android — it routes ALL WebViews in the process (content AND chrome) through the
   * proxy.  On desktop the proxy applies to the content WebView only.  The chrome's own
   * localhost / tauri.localhost origin is bypassed via `bypassSimpleHostnames()` +
   * `addDirect()` so the React UI is not proxied.  This difference is noted for Task 9 docs.
   *
   * Feature-check: if PROXY_OVERRIDE is unsupported (old System WebView) this is a
   * safe no-op — browsing is unaffected without proxy support.
   */
  private fun applyBootProxy() {
    if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return
    try {
      val json = NativeProxy.proxyConfig()
      if (json.isEmpty()) return // no config seeded yet — direct (default)
      val obj = org.json.JSONObject(json)
      val mode = obj.optString("mode", "off")
      if (mode != "proxy") {
        // OFF or unrecognised — clear any previously applied override (idempotent).
        ProxyController.getInstance().clearProxyOverride({ it.run() }, {})
        return
      }
      val scheme = obj.optString("scheme", "http")
      val host = obj.optString("host", "")
      val port = obj.optInt("port", 0)
      if (!isValidProxy(scheme, host, port)) return // invalid config — direct
      val bypass = mutableListOf<String>()
      val bypassArr = obj.optJSONArray("bypassHosts")
      if (bypassArr != null) {
        for (i in 0 until bypassArr.length()) bypass.add(bypassArr.optString(i, ""))
      }
      // The builder throws on a malformed rule, so it stays INSIDE this try (Bridge.setProxy
      // got this wrong once and crashed the app on a bad rule from the chrome).
      ProxyController.getInstance().setProxyOverride(
        proxyBuilder(scheme, host, port, bypass), { it.run() }, {
          Log.i("AegisProxy", "boot proxy applied: $scheme://$host:$port")
        },
      )
    } catch (t: Throwable) {
      Log.w("AegisProxy", "boot proxy apply failed", t)
    }
  }

  // --- Downloads -----------------------------------------------------------------
  //
  // Before this, the core's downloads::on_requested / on_finished had NO caller on Android at
  // all — they carried #[cfg_attr(target_os = "android", allow(dead_code))], which per gotcha 24
  // in src-tauri/AGENTS.md is a claim that the feature does not exist on the platform rather
  // than a lint exemption. The Downloads sheet rendered, and was permanently empty. Kotlin is
  // the only side that can see the download, and it drives the core down this path.

  /** Where downloads land, or null when the platform has no usable app-specific external
   *  directory. `getExternalFilesDir` needs NO storage permission, is app-private, and yields a
   *  REAL filesystem path — which is what the core's `downloads::open` / `showInFolder` /
   *  `trusted_download_path` checks need; a `DownloadManager` `content://` URI is not one, and
   *  `setDestinationInExternalPublicDir` would need WRITE_EXTERNAL_STORAGE.
   *
   *  `getExternalFilesDir(DOWNLOAD_SUBDIR)` IS the directory, and that is not a style choice:
   *  the platform's own `DownloadManager.Request.setDestinationInExternalFilesDir` is
   *  implemented as exactly `context.getExternalFilesDir(dirType)` followed by the file name
   *  (frameworks/base `core/java/android/app/DownloadManager.java`, ~line 525). Appending
   *  `DOWNLOAD_SUBDIR` here a second time put the recorded `savePath` one directory below
   *  where the transfer actually wrote, so the row named a path no file ever occupied.
   *
   *  Null rather than a `filesDir` fallback, for the same reason: the platform throws
   *  `IllegalStateException` from `setDestinationInExternalFilesDir` when the directory is
   *  unavailable, so a fallback path here would be recorded and then never written. The
   *  caller drops the download with a log line, which is what the throw would have done. */
  private fun downloadDir(): File? {
    val dir = getExternalFilesDir(DOWNLOAD_SUBDIR) ?: return null
    // getExternalFilesDir creates it in-process, so this is belt and braces; a failure to
    // create is reported as "no directory" rather than left to fail later.
    if (!dir.isDirectory && !dir.mkdirs()) return null
    return dir
  }

  /** `URLUtil.guessFileName` derives its answer from a page-controlled Content-Disposition, so
   *  it can come back with a path separator in it. Flatten it, and never return an empty name
   *  (`DownloadManager` rejects one). */
  private fun safeDownloadName(name: String, url: String): String {
    val flat = name.replace('/', '_').replace('\\', '_').trim()
    return flat.ifEmpty { "download-" + url.hashCode().toString(16) }
  }

  /** Per-tab download wiring, called from `createTabWebView` so it closes over the tab's id and
   *  privateness. The listener records the row through the core FIRST (so the sheet shows the
   *  item even if the transfer then fails), enqueues the transfer, and settles the row from the
   *  `ACTION_DOWNLOAD_COMPLETE` broadcast — `DownloadListener` has no completion callback, so
   *  that broadcast is the only signal there is. Every step is best-effort with a logcat line:
   *  a download must never take the page down with it. */
  private fun wireDownloadListener(wv: WebView, id: Int, isPrivate: Boolean) {
    wv.setDownloadListener { url, userAgent, disposition, mimeType, _ ->
      try {
        if (!url.startsWith("http")) {
          Log.w("AegisDownload", "ignoring non-http download $url")
          return@setDownloadListener
        }
        val name = safeDownloadName(URLUtil.guessFileName(url, disposition, mimeType), url)
        val dir = downloadDir()
        if (dir == null) {
          Log.w("AegisDownload", "no app-private external directory for $url")
          return@setDownloadListener
        }
        val file = File(dir, name)
        val req = DownloadManager.Request(Uri.parse(url))
        CookieManager.getInstance().getCookie(url)?.let { req.addRequestHeader("Cookie", it) }
        // `CHROME_UA`, not `userAgentString`: that is a `WebSettings` property, and this
        // listener is not the tab's creation path. The listener hands us the page's own UA,
        // and the constant is the honest fallback when it hands us null.
        req.addRequestHeader("User-Agent", userAgent ?: CHROME_UA)
        if (!mimeType.isNullOrEmpty()) req.setMimeType(mimeType)
        req.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED)
        // DOWNLOAD_SUBDIR, not a literal: the row's `savePath` is `File(downloadDir(), name)`
        // and this call writes to `getExternalFilesDir(<dirType>)/<name>`, so the two agree
        // only while both name the same subdirectory from the same constant.
        req.setDestinationInExternalFilesDir(this, DOWNLOAD_SUBDIR, name)
        val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager
        if (dm == null) {
          Log.w("AegisDownload", "no DownloadManager for $url")
          return@setDownloadListener
        }
        dm.enqueue(req)
        NativeDownloads.recordStart(url, file.absolutePath, isPrivate)
      } catch (t: Throwable) {
        Log.w("AegisDownload", "download start for $url failed", t)
      }
    }
  }

  private fun registerDownloadReceiver() {
    try {
      val filter = IntentFilter(DownloadManager.ACTION_DOWNLOAD_COMPLETE)
      if (android.os.Build.VERSION.SDK_INT >= android.os.Build.VERSION_CODES.TIRAMISU) {
        registerReceiver(downloadReceiver, filter, Context.RECEIVER_EXPORTED)
      } else {
        @Suppress("UnspecifiedRegisterReceiverFlag")
        registerReceiver(downloadReceiver, filter)
      }
    } catch (t: Throwable) {
      Log.w("AegisDownload", "could not register the download receiver", t)
    }
  }

  private fun unregisterDownloadReceiver() {
    try {
      unregisterReceiver(downloadReceiver)
    } catch (t: Throwable) {
      // Not registered (onCreate failed, or a second onDestroy) — nothing to undo.
    }
  }

  /** Settle one finished transfer. The URL comes from the DownloadManager row rather than from
   *  a map this Activity kept, so a download that completed after the process restarted still
   *  reaches the core. `COLUMN_LOCAL_URI` is read only to log where it landed; the core's
   *  `savePath` is the path we named at start time, and the file is written to exactly that. */
  private fun settleDownload(downloadId: Long) {
    try {
      val dm = getSystemService(Context.DOWNLOAD_SERVICE) as? DownloadManager ?: return
      val q = DownloadManager.Query().setFilterById(downloadId)
      dm.query(q)?.use { c ->
        if (!c.moveToFirst()) return
        val url = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_URI)) ?: return
        val status = c.getInt(c.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS))
        val ok = status == DownloadManager.STATUS_SUCCESSFUL
        val local = c.getString(c.getColumnIndexOrThrow(DownloadManager.COLUMN_LOCAL_URI))
        Log.i("AegisDownload", "download $url finished ok=$ok at $local")
        NativeDownloads.recordFinish(url, ok)
      }
    } catch (t: Throwable) {
      Log.w("AegisDownload", "settling download $downloadId failed", t)
    }
  }

  private val downloadReceiver = object : BroadcastReceiver() {
    override fun onReceive(context: Context?, intent: Intent?) {
      val id = intent?.getLongExtra(DownloadManager.EXTRA_DOWNLOAD_ID, -1L) ?: return
      if (id < 0) return
      settleDownload(id)
    }
  }

  /** Best-effort adblock request type (main frame → "document", else from the Accept
   *  header or URL extension). The engine matches URL/domain rules regardless of type,
   *  so "other" is a safe fallback. */
  private fun requestType(url: String, req: WebResourceRequest): String {
    if (req.isForMainFrame) return "document"
    val accept = req.requestHeaders?.get("Accept").orEmpty()
    val path = url.substringBefore('?').substringBefore('#')
    return when {
      accept.contains("text/css") || path.endsWith(".css") -> "stylesheet"
      accept.startsWith("image/") || IMAGE_EXT.containsMatchIn(path) -> "image"
      accept.contains("javascript") || path.endsWith(".js") -> "script"
      accept.contains("text/html") -> "sub_frame"
      FONT_EXT.containsMatchIn(path) -> "font"
      else -> "other"
    }
  }

  /** JNI-safe malware-host check. shouldInterceptRequest already fails open on a native
   *  error; this is the same treatment for the UI-thread path, where an exception would
   *  propagate out of a WebView callback (or a Bridge lambda) and take the app down. */
  private fun isMalwareHost(host: String): Boolean = try {
    NativeSafety.isMalwareHost(host)
  } catch (t: Throwable) {
    Log.w("AegisSafety", "isMalwareHost($host) failed; allowing", t)
    false
  }

  /** JNI-safe scripted-redirect check — fails open (allow the navigation) and logs. */
  private fun redirectBlocked(current: String, target: String, scripted: Boolean, mainFrame: Boolean): Boolean = try {
    NativeRedirectGuard.shouldBlock(current, target, scripted, mainFrame)
  } catch (t: Throwable) {
    Log.w("AegisRedirect", "shouldBlock($target) failed; allowing", t)
    false
  }

  /** The scheme allowlist for anything a CONTENT WebView is asked to load: http/https,
   *  plus about: (the chrome's empty-tab/home state — `about:blank` is the only one the app
   *  drives). file:/content:/data:/blob:/javascript:/intent: have no business in a browsed
   *  page: the first two are filesystem / content-provider READS, and javascript: is a code
   *  injection vector. Every load site funnels through here (see [loadableUrl]) so there is
   *  exactly one allowlist. */
  private fun isLoadableUrl(raw: String): Boolean {
    val uri = try {
      Uri.parse(raw)
    } catch (_: Throwable) {
      return false
    }
    val scheme = uri.scheme?.lowercase() ?: return false
    if (scheme == "http" || scheme == "https") return true
    // `about:blank` and NOTHING ELSE — the same rule `nav::is_navigable` applies on
    // every desktop, matched on the path rather than the whole string so a benign
    // `about:blank#x` still passes while `about:config` does not. This used to be
    // any `about:` at all, which is a third scheme list: the desktop refused
    // `about:config` in a browsed tab and Android accepted it. `nav::tests` pins the
    // two lists to the same set by reading this file, so a future edit here that
    // drifts from the desktop policy fails the Rust suite.
    return scheme == "about" && uri.path == "blank"
  }

  /** The scheme allowlist for a URL handed to ANOTHER app through `ACTION_VIEW`: http and
   *  https, and nothing else.
   *
   *  `openExternal` is a `@JavascriptInterface` method on the CHROME WebView, so anything
   *  that can run script in the chrome document can call it with any string it likes, and
   *  it fired `ACTION_VIEW` on whatever it was handed. That turned the chrome document
   *  into a way to make another app act on our behalf: an `intent:` URL is a
   *  fully-specified action and component that the caller chooses, and the local ones
   *  are filesystem / content-provider reads performed in the receiving app's context.
   *  The one real caller is a hardcoded https release URL, so narrowing the list costs
   *  nothing.
   *
   *  `about:` is deliberately absent even though [isLoadableUrl] allows `about:blank`:
   *  handing an empty page to another app is not a thing anyone wants, and allowing it
   *  here would be exactly the "a third scheme list by another name" drift the note above
   *  describes. `nav::tests` pins this list from the Rust suite, because there is no
   *  Kotlin test source set to pin it from. */
  private fun isExternallyOpenableUrl(raw: String): Boolean {
    val scheme = try {
      Uri.parse(raw).scheme?.lowercase()
    } catch (_: Throwable) {
      return false
    }
    return scheme == "http" || scheme == "https"
  }

  /** Security policy for a main-frame navigation target: returns the URL to actually
   *  load, the same URL if it's fine, or null to BLOCK it as known malware. Upgrades
   *  http→https when the `httpsOnly` setting says to (localhost always exempt).
   *
   *  The upgrade used to be unconditional, which hardcoded the setting's *default* as if it
   *  were the *policy*: a user who turned HTTPS-Only OFF because they have a plain-HTTP
   *  intranet host got that host rewritten to https and the site simply broke, with no UI
   *  anywhere reporting that Android was stricter than the setting claims. The policy now
   *  comes from the Rust side, which mirrors it into an app-free global at boot and on every
   *  write — this function has no `AppHandle` to read the settings file with. The getter
   *  fails towards `true`, so a native call that cannot answer keeps upgrading.
   *
   *  The scheme comparison is case-INSENSITIVE and the rewrite slices by the scheme's real
   *  length. `Uri` does not normalise the scheme's case, so `HTTP://host` reaches this
   *  function with a 4-character scheme: an exact `== "http"` test silently declined to
   *  upgrade it, and a `HTTP://` link was a one-character way around HTTPS-Only. The slice
   *  length is then derived from the scheme rather than hardcoded, because the two spellings
   *  are both 7 characters and a hardcoded `http://`.length was right only by coincidence. */
  private fun secureUrl(raw: String): String? {
    val uri = try {
      Uri.parse(raw)
    } catch (_: Throwable) {
      return raw
    }
    val rawScheme = uri.scheme ?: return raw
    val host = uri.host ?: return raw
    if (isMalwareHost(host)) return null
    val localhost = host == "localhost" || host == "127.0.0.1" || host == "::1"
    if (rawScheme.equals("http", ignoreCase = true) && !localhost && NativeSettings.httpsOnlyOrDefault()) {
      return "https://" + raw.substring(rawScheme.length + "://".length)
    }
    return raw
  }

  /** The URL a content WebView should actually load for [raw]: the [secureUrl] policy
   *  (malware block + HTTPS-Only upgrade) with the scheme allowlist applied. A refused
   *  scheme degrades to about:blank rather than handing the WebView the raw string —
   *  secureUrl alone used to pass any host-less URL (file://, content://) straight
   *  through, because it returns `raw` unchanged when there is no host. */
  private fun loadableUrl(raw: String): String =
    secureUrl(raw)?.takeIf { isLoadableUrl(it) } ?: ABOUT_BLANK

  /** The user-facing reason [raw] may not be loaded, or null when it is fine. Separate from
   *  [loadableUrl] so the block page can SAY why — a malware host and a file:// URL are
   *  both "blocked" but they are not the same message. */
  private fun blockReason(raw: String): String? = when {
    !isLoadableUrl(raw) -> SCHEME_REASON
    secureUrl(raw) == null -> MALWARE_REASON
    else -> null
  }

  /** Replace tab [id]'s content with a block page (the desktop shows a richer
   *  interstitial; a session "proceed anyway" on mobile is a follow-up). Acts on [view] —
   *  the tab that actually navigated — and pushes nav state for [id]: a BACKGROUND tab
   *  hitting a malware host must not replace the page the user is looking at.
   *  [reason] is the user-facing sentence, so the copy matches the actual reason the load
   *  was refused (malware host vs. a scheme outside the allowlist). */
  private fun showMalwareWarning(id: Int, view: WebView, url: String, reason: String) {
    val host = (try {
      Uri.parse(url).host
    } catch (_: Throwable) {
      null
    }) ?: url
    val safeHost = host.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    val html = """
      <!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
      <style>body{background:#1a0b0b;color:#fecaca;font-family:sans-serif;padding:24px;line-height:1.5}
      h1{color:#fca5a5}code{color:#fcd34d;word-break:break-all}</style></head>
      <body><h1>&#9888; Dangerous site blocked</h1>
      <p>Aegis blocked <code>$safeHost</code> — $reason</p>
      <p>For your safety, the page was not loaded.</p></body></html>
    """.trimIndent()
    // Stop the page before replacing its document — a background tab would otherwise keep
    // fetching while the warning is displayed.
    try {
      view.stopLoading()
    } catch (t: Throwable) {
      Log.w("AegisSafety", "stopLoading before interstitial failed", t)
    }
    if (id == activeTabId) {
      hasPage = true
      updateContentVisibility()
    }
    view.setBackgroundColor(Color.BLACK)
    view.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    pushNavState(id, url, false, view)
  }

  private fun blockedResponse(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

  /** Push a tab's nav state to the chrome's React state (NavState shape, viewId = [id]),
   *  by calling a global the Tauri client's nav.onState installs. The chrome's
   *  useNav(viewId) filters events by viewId === activeId so the address bar tracks only
   *  the active tab. [wv] is the tab's own WebView — pass it for background-tab events so
   *  title/canGoBack/canGoForward describe that tab, not whichever tab is active. */
  private fun pushNavState(id: Int, url: String, loading: Boolean, wv: WebView? = contentWebView) {
    val c = wv
    val obj = JSONObject()
      .put("viewId", id)
      .put("url", url)
      .put("title", c?.title ?: "")
      .put("canGoBack", c?.canGoBack() ?: false)
      .put("canGoForward", c?.canGoForward() ?: false)
      .put("isLoading", loading)
      .put("crashed", false)
    queuePush(pendingNavJs, id, "window.__aegisNavState && window.__aegisNavState($obj)")
    // Back/forward availability is what decides which system-gesture edge strips we may
    // claim, so re-evaluate whenever the active tab's nav state moves.
    if (id == activeTabId) gestureContainer?.updateGestureExclusion()
  }

  /** Push find-in-page result state to the chrome's React state (FindState shape, viewId
   *  = [id]), by calling the global the ipcClient's find.onState installs for Android
   *  (__aegisFindState). Mirrors the pushNavState / __aegisNavState pattern exactly.
   *  [matchCount] is the total number of matches; [activeIndex] is 1-based (0 = none). */
  private fun pushFindState(id: Int, matchCount: Int, activeIndex: Int) {
    val obj = JSONObject()
      .put("viewId", id)
      .put("query", currentFindQuery)
      .put("matchCount", matchCount)
      .put("activeMatchIndex", if (matchCount > 0) activeIndex else 0)
    val js = "window.__aegisFindState && window.__aegisFindState($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
  }

  /**
   * The store's permission name for an Android resource set, or null when the set holds
   * nothing this platform can name. Camera and microphone are the only two resources a
   * site can ask for here that Aegis keys a row for.
   */
  private fun permissionFor(resources: Array<String>): String? = when {
    resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) &&
      resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) -> "camera-microphone"
    resources.contains(PermissionRequest.RESOURCE_VIDEO_CAPTURE) -> "camera"
    resources.contains(PermissionRequest.RESOURCE_AUDIO_CAPTURE) -> "microphone"
    else -> null
  }

  /**
   * Apply the remembered decision for ([origin], [permission]) or raise the chrome
   * prompt, then run [onDecision] with the answer on the UI thread.
   *
   * [origin] is normalized through Rust (`permissions::origin_of`) so the store row, the
   * prompt text and the desktop key are the same string for the same site — a
   * hand-normalized origin here would silently re-prompt a user who already decided.
   * Both native calls fail soft: a JNI error asks, which is the safe direction, because
   * a remembered ALLOW must never be assumed when the lookup could not happen.
   */
  private fun askUser(
    tab: Int,
    origin: String,
    permission: String,
    onDecision: (allow: Boolean) -> Unit,
  ) {
    val key = try {
      NativePermissions.normalizeOrigin(origin)
    } catch (t: Throwable) {
      Log.w("AegisPerm", "normalizeOrigin failed for $origin", t)
      origin
    }
    if (key.isEmpty()) {
      // No origin means every such site would share one store row, so there is nothing
      // safe to remember or to show. Deny without prompting.
      onDecision(false)
      return
    }
    val remembered = try {
      NativePermissions.decision(key, permission)
    } catch (t: Throwable) {
      Log.w("AegisPerm", "decision failed for $key $permission", t)
      ""
    }
    if (remembered == "allow" || remembered == "deny") {
      onDecision(remembered == "allow")
      return
    }
    val requestId = nextPermissionId++
    pendingPermissions[requestId] = PendingPermission(tab, key, permission, onDecision)
    pushPermissionPrompt(requestId, key, permission)
  }

  /**
   * Raise the permission prompt in the CHROME webview, which is where the dialog lives:
   * the same `window.__aegisX` push the find, nav, zoom and ad-block counters use.
   */
  private fun pushPermissionPrompt(requestId: Int, origin: String, permission: String) {
    val obj = JSONObject()
      .put("requestId", requestId)
      .put("origin", origin)
      .put("permission", permission)
    val js = "window.__aegisPermissionPrompt && window.__aegisPermissionPrompt($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
  }

  /**
   * Ask the OS for the device-level permission a granted web request implies. The web
   * prompt and the OS dialog are two different decisions — Aegis asks "does this site get
   * the camera?", the platform asks "does this app get the camera?" — and granting the
   * first without the second would leave `getUserMedia` failing on a permission the user
   * had just granted, which reads as a bug. `requestPermissions` is a no-op when the
   * grant is already held, so calling it on every remembered allow is free.
   */
  private fun requestAndroidPermissionFor(permission: String) {
    val needed = when (permission) {
      "camera" -> arrayOf(Manifest.permission.CAMERA)
      "microphone" -> arrayOf(Manifest.permission.RECORD_AUDIO)
      "camera-microphone" -> arrayOf(Manifest.permission.CAMERA, Manifest.permission.RECORD_AUDIO)
      "geolocation" -> arrayOf(Manifest.permission.ACCESS_FINE_LOCATION)
      else -> return
    }
    val missing = needed.filter { checkSelfPermission(it) != PackageManager.PERMISSION_GRANTED }
    if (missing.isEmpty()) return
    try {
      requestPermissions(missing.toTypedArray(), REQ_WEB_PERMISSION)
    } catch (t: Throwable) {
      Log.w("AegisPerm", "requestPermissions failed for $permission", t)
    }
  }

  /**
   * Answer every pending request belonging to [tab] with "no" and forget it. A callback
   * that belongs to a destroyed WebView can only be denied, so leaving it queued would
   * show a prompt in the chrome whose answer could no longer reach the page. The site is
   * going away with the tab, so the denial is silent.
   */
  private fun dropPermissionsForTab(id: Int) {
    val stale = pendingPermissions.filterValues { it.tab == id }.keys.toList()
    for (requestId in stale) {
      val pending = pendingPermissions.remove(requestId) ?: continue
      try {
        pending.answer(false)
      } catch (t: Throwable) {
        Log.w("AegisPerm", "deny on tab close failed for $requestId", t)
      }
    }
  }

  /**
   * When a redirect is blocked, open it in a new tab instead of showing blocking UI.
   * This prevents the navigation in the current tab (for security) while providing
   * the content in a new tab for user convenience.
   *
   * The open is done by RUST, not by asking the chrome webview to do it. This used to
   * call `window.__aegisOpenTab`, which reaches `MobileApp` -> `tabs.create(url, true)`
   * — the same registry-create + `emit_and_persist` that
   * `tabs::open_redirect_background` performs on desktop. So Android was bypassing
   * EXACTLY the two things desktop also has: the `RedirectBudget` (dedup within
   * `REDIRECT_DEDUP_WINDOW`, at most `MAX_LIVE_REDIRECT_TABS` live) and the 30-second
   * auto-close of a tab the user never looked at. A malverting page could accumulate
   * unbounded background tabs on a phone while the desktop build refused to, and the
   * caller had no way to know whether one had actually been opened.
   *
   * Calling [openBlockedRedirect] puts both platforms on the SAME budget, so the cap
   * cannot be bypassed by arriving from the phone. `open_redirect_background` only
   * creates a registry row and emits; it never spawns a webview, so no engine work
   * happens here and no thread hop is needed — this is already on the UI thread,
   * exactly like the `shouldBlock` call above it.
   *
   * [from] is the page the redirect came FROM, not just [to]: the dedup key is the
   * (from, to) PAIR, so half a pair is not a redirect and Rust refuses it.
   */
  private fun showRedirectBlocked(from: String, to: String) {
    val opened = try {
      NativeRedirectGuard.openBlockedRedirect(from, to)
    } catch (t: Throwable) {
      Log.w("AegisRedirect", "openBlockedRedirect failed for $to", t)
      false
    }
    if (!opened) {
      // Budget refused (dedup window, cap reached, no app handle yet) or the bridge
      // failed. Deliberately nothing else happens: the navigation stays refused, and
      // there is no affordance offered for a tab that does not exist.
      Log.i("AegisRedirect", "budget refused the blocked redirect to $to; nothing opened")
    }
  }

  /**
   * The single writer of the process-global cookie gate.
   *
   * `CookieManager.setAcceptCookie` is process-wide: there is no per-WebView form of it, so
   * cookies cannot be refused for one tab and accepted for another. The invariant is therefore
   * the strictest one the platform allows — while ANY private tab is ALIVE, cookies are refused
   * for the whole process — and this function is the only place that sets it.
   *
   * It used to be keyed on the ACTIVE tab: `activateTab` did
   * `setAcceptCookie(!privateTabs.contains(id))` and `teardownTab` did
   * `setAcceptCookie(activeTabId < 0 || !privateTabs.contains(activeTabId))`. With a private
   * tab in the background, switching to any normal tab re-enabled cookies process-wide while
   * the private WebView was still RUNNING and resumed sending and storing them. That is not
   * the accepted "first-party cookies linger in the jar after close" Android tier — there the
   * tab is already gone; here the tab was live and the gate was simply open.
   *
   * The cost of the strict invariant, stated rather than hidden: a normal tab open in the
   * background stops receiving cookies for as long as any private tab is alive. It is the same
   * platform gate as before, correctly scoped, and erring this way is the right direction.
   */
  private fun syncCookieAcceptance() {
    CookieManager.getInstance().setAcceptCookie(privateTabs.isEmpty())
  }

  /**
   * Shared teardown for closeTab and discardTab.
   *
   * Removes the WebView from the gesture container, clears private per-tab state, then destroys
   * it. Cookie acceptance is restored only once the LAST private tab is gone.
   *
   * [keepZoom] — pass true for discardTab (zoom survives a reload) and false for closeTab
   * (tab is gone permanently so the stored zoom is useless).
   */
  private fun teardownTab(id: Int, keepZoom: Boolean) {
    dropPermissionsForTab(id)
    // An HTML5-fullscreen view lives on window.decorView, not on the tab, so closing the tab
    // has to take it down explicitly or it survives with no owner.
    chromeClients.remove(id)?.onHideCustomView()
    tabWebViews.remove(id)?.let { wv ->
      wv.visibility = View.GONE
      if (privateTabs.contains(id)) {
        // Clear this tab's HTTP cache/form state. DOM storage is disabled for private
        // WebViews; deleteAllData is global, so do not use it here. No about:blank load
        // first: it is asynchronous and the destroy() below cancels it, so it only queued a
        // request we were going to throw away. No clearHistory() either — the WebView is
        // about to be destroyed, so its back/forward list has no reader left.
        wv.stopLoading()
        wv.clearCache(true)
        wv.clearFormData()
      }
      destroyWebView(wv, gestureContainer)
    }
    pageUrls.remove(id)
    pageBlocked.remove(id)
    if (!keepZoom) tabZoom.remove(id)
    if (activeTabId == id) { activeTabId = -1; contentWebView = null }
    privateTabs.remove(id)
    syncCookieAcceptance()
  }

  /** Exposed to the chrome webview's JS as `window.AegisAndroid`. Methods run on the
   *  JS-bridge thread, so all WebView calls hop to the UI thread. */
  inner class Bridge {
    /**
     * Activate a tab: create its WebView lazily on first call, show it, hide all others.
     * The chrome calls this on mount for the first tab and on every tab switch.
     *
     * [isPrivate] — when true this tab runs with no DOM storage, no form-data persistence, no
     * disk cache, teardown clearing, and with cookies refused process-wide for as long as it is
     * alive (see syncCookieAcceptance).
     */
    @JavascriptInterface
    @JvmOverloads
    fun activateTab(id: Int, url: String, isPrivate: Boolean = false) = runOnUiThread {
      // A tab switch cancels any in-flight pull-to-refresh: the spinner belongs to the tab
      // we are leaving, and its onPageFinished may never arrive (an aborted load, a discarded
      // tab) — a stuck latch kills every gesture in the container. Keyed per tab in
      // GestureContainer, so this clears the shared slot unconditionally.
      gestureContainer?.cancelRefresh()
      // Navigation policy applied BEFORE anything loads: HTTPS-Only upgrade / malware block
      // plus the scheme allowlist (loadableUrl degrades a refused scheme to about:blank).
      val target = loadableUrl(url)
      // A tab RESTORE must not silently land on about:blank when the policy is what refused
      // it: re-activating a tab that pointed at a known-malware host (or a file:// URL)
      // should say so, exactly like a live navigation does.
      val reason = if (url == ABOUT_BLANK || url.isEmpty()) null else blockReason(url)
      if (isPrivate) privateTabs.add(id)
      syncCookieAcceptance()
      val wv = tabWebViews[id] ?: createTabWebView(id, target, isPrivate).also { tabWebViews[id] = it }
      activeTabId = id
      contentWebView = wv
      for ((tid, w) in tabWebViews) if (tid != id) w.visibility = View.GONE
      hasPage = (pageUrls[id] ?: target) != ABOUT_BLANK
      applyContentMargins()
      updateContentVisibility()
      // Re-push this tab's nav state so the chrome's address bar + back/forward update to
      // it. Switching to an already-live tab fires no page-load event, so without this the
      // chrome's useNav would reset to a blank state for the newly-activated tab. Skipped
      // when the block page is going up: it pushes the refused URL itself, and the coalesced
      // push keeps the LAST write, so this would otherwise blank the address bar.
      if (reason != null) {
        showMalwareWarning(id, wv, url, reason)
      } else {
        pushNavState(id, pageUrls[id] ?: target, false, wv)
      }
      // The new active tab has its own back/forward availability, so the gesture container
      // has to re-decide which system-gesture edges it may claim.
      gestureContainer?.updateGestureExclusion()
    }

    @JavascriptInterface
    fun resolvePermission(requestId: Int, decision: String) = runOnUiThread {
      val pending = pendingPermissions.remove(requestId)
      if (pending == null) {
        // The Linux path logs the same shape: a double click, or a prompt for a tab that
        // has since closed, must not grant a second time.
        Log.i("AegisPerm", "resolve for unknown/stale requestId=$requestId; ignoring")
        return@runOnUiThread
      }
      val allow = decision == "allow" || decision == "allow-once"
      // `allow-once` is the only decision NOT written to the store: it answers this
      // request and asks again next time, exactly as `permissions.resolve` does on Linux.
      val remember = decision != "allow-once"
      pending.answer(allow)
      if (remember) {
        try {
          NativePermissions.remember(pending.origin, pending.permission, allow)
        } catch (t: Throwable) {
          Log.w("AegisPerm", "remember failed for $requestId", t)
        }
      }
    }

    /** Permanently close a tab: destroy its WebView and remove it from the map. */
    @JavascriptInterface
    fun closeTab(id: Int) = runOnUiThread {
      teardownTab(id, keepZoom = false)
    }

    /** Discard an idle tab (memory reclaim): destroy its WebView; re-activating will
     *  reload it via activateTab. Same teardown as closeTab. Note: dropping the page
     *  count is correct — re-activating reloads the tab, which triggers onPageStarted
     *  → resetPageBlocked. A discarded-then-reactivated tab's badge restarts from 0
     *  until it blocks again (accepted limitation; identical to a fresh load). */
    @JavascriptInterface
    fun discardTab(id: Int) = runOnUiThread {
      teardownTab(id, keepZoom = true)
    }

    @JavascriptInterface
    fun navigate(url: String) = runOnUiThread {
      val c = contentWebView ?: return@runOnUiThread
      if (url.isEmpty() || url == ABOUT_BLANK) {
        // Home: hide the content webview so the chrome's home screen shows, and
        // clear the address bar (blank state).
        hasPage = false
        updateContentVisibility()
        if (activeTabId >= 0) pageUrls[activeTabId] = ABOUT_BLANK
        pushNavState(activeTabId, ABOUT_BLANK, false)
      } else {
        // Apply the security policy (malware block / HTTPS-Only upgrade) and the scheme
        // allowlist before load. Both refusals land on the SAME block page the tab already
        // knows how to render, so a mistyped file:// path is not silently a blank tab.
        when (val reason = blockReason(url)) {
          null -> {
            val target = secureUrl(url) ?: ABOUT_BLANK
            hasPage = true
            updateContentVisibility()
            if (activeTabId >= 0) pageUrls[activeTabId] = target
            c.loadUrl(target)
          }
          else -> {
            Log.i("AegisNav", "refused $url: $reason")
            showMalwareWarning(activeTabId, c, url, reason)
          }
        }
      }
    }

    /** Lower/raise the native content WebView when a chrome overlay opens/closes, so
     *  the overlay (which lives in the chrome webview) isn't hidden behind it. */
    @JavascriptInterface
    fun setContentHidden(hidden: Boolean) = runOnUiThread {
      overlayHidden = hidden
      updateContentVisibility()
    }

    @JavascriptInterface
    fun back() = runOnUiThread { contentWebView?.let { if (it.canGoBack()) it.goBack() } }

    @JavascriptInterface
    fun forward() = runOnUiThread { contentWebView?.let { if (it.canGoForward()) it.goForward() } }

    @JavascriptInterface
    fun reload() = runOnUiThread { contentWebView?.reload() }

    /** The chrome reports here whether a sheet/menu is open, so the activity Back
     *  button closes the sheet (via window.__aegisMobileBack) before navigating. */
    @JavascriptInterface
    fun setBackInterceptActive(active: Boolean) = runOnUiThread {
      backInterceptActive = active
    }

    /** Hide/show the bottom action bar (the top-bar toggle). Hiding shrinks the content's
     *  bottom margin so the page reclaims the bar's gap; showing restores it. A discrete
     *  user action, so there's no scroll feedback loop (unlike the removed auto-hide). */
    @JavascriptInterface
    fun setBottomBarHidden(hidden: Boolean) = runOnUiThread {
      bottomBarHidden = hidden
      applyContentMargins()
    }

    /** Enter/exit the chrome-hiding fullscreen (the top-bar Maximize button; desktop
     *  parity): the content fills the safe area with no top/bottom chrome. The chrome
     *  hides its bars in React and Back exits (via window.__aegisMobileBack). */
    @JavascriptInterface
    fun setFullscreen(on: Boolean) = runOnUiThread {
      fullscreen = on
      WindowInsetsControllerCompat(window, window.decorView).apply {
        systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        if (on) hide(WindowInsetsCompat.Type.systemBars())
        else show(WindowInsetsCompat.Type.systemBars())
      }
      applyContentMargins()
    }

    /** Set page zoom for tab [id] as a percentage (100 == 1.0). Applied to that tab's
     *  WebView via WebSettings.textZoom. Session-only (not persisted) — matches desktop v1.
     *  Clamped to [50, 300] to mirror the desktop ZOOM_MIN/ZOOM_MAX (0.5–3.0). */
    @JavascriptInterface
    fun setZoom(id: Int, percent: Int) = runOnUiThread {
      val clamped = percent.coerceIn(50, 300)
      tabZoom[id] = clamped
      tabWebViews[id]?.settings?.textZoom = clamped
    }

    /** The current zoom for tab [id] as a percentage (100 == 1.0), or 100 for a tab
     *  with no recorded zoom.
     *
     *  This exists because the renderer used to cache zoom factors in a module-local
     *  `Map`, which `data.import` destroys: a successful restore reloads the chrome
     *  document, so the toolbar would then report 100% on a page still rendered at
     *  whatever the user had set. The native map already outlives the renderer
     *  document, so it is the source of truth and the renderer asks for the value
     *  rather than keeping a second copy that a reload loses. */
    @JavascriptInterface
    fun getZoom(id: Int): Int = tabZoom[id] ?: 100

    /** Open a URL in the external browser (used to reach the releases page to install
     *  an update — the Tauri updater is desktop-only). */
    @JavascriptInterface
    fun openExternal(url: String) = runOnUiThread {
      if (!isExternallyOpenableUrl(url)) {
        // Refused, not handed to whatever app claims the scheme. The chrome WebView is
        // the only thing that can reach this, so the list is a last line of defence
        // rather than the primary one — but it is the last one, and it was missing.
        Log.w("AegisNav", "refused to hand $url to another app: $EXTERNAL_SCHEME_REASON")
        return@runOnUiThread
      }
      try {
        startActivity(
          android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (t: Throwable) {
        Log.w("AegisNav", "openExternal failed for $url", t)
      }
    }

    // --- Find-in-page bridge (Task 10) ---
    // Android's WebView.findAllAsync is case-insensitive only; the caseSensitive flag
    // is accepted for API parity but is silently ignored (there is no case-sensitive
    // native WebView find API on Android).
    @JavascriptInterface
    fun find(query: String, caseSensitive: Boolean) = runOnUiThread {
      val c = contentWebView ?: return@runOnUiThread
      currentFindQuery = query
      if (query.isEmpty()) {
        c.clearMatches()
        pushFindState(activeTabId, 0, 0)
      } else {
        // findAllAsync triggers the per-tab FindListener once counting completes.
        @Suppress("UNUSED_VARIABLE") val unused = caseSensitive // documented no-op
        c.findAllAsync(query)
      }
    }

    /** Advance to the next highlighted match (forward). Does NOT re-search; requires
     *  a prior findAllAsync call. */
    @JavascriptInterface
    fun findNext() = runOnUiThread { contentWebView?.findNext(true) }

    /** Go back to the previous highlighted match (backward). Does NOT re-search; requires
     *  a prior findAllAsync call. */
    @JavascriptInterface
    fun findPrev() = runOnUiThread { contentWebView?.findNext(false) }

    /** End the find session: clear all match highlights and push an empty state to the chrome. */
    @JavascriptInterface
    fun findClose() = runOnUiThread {
      currentFindQuery = ""
      contentWebView?.clearMatches()
      pushFindState(activeTabId, 0, 0)
    }

    // --- Proxy bridge (Task 5) ---
    //
    // PARITY DIFFERENCE vs desktop: `ProxyController.setProxyOverride` is PROCESS-GLOBAL
    // on Android — it routes ALL WebViews in the process (content AND chrome) through the
    // proxy.  On desktop the proxy is content-webview-scoped only.  We mitigate by calling
    // `bypassSimpleHostnames()` + `addDirect()` so the React UI's localhost/tauri.localhost
    // origin falls through to direct.  User-supplied bypass-hosts are also applied.
    // If `PROXY_OVERRIDE` is unsupported (old System WebView) these are graceful no-ops.

    /**
     * Apply an HTTP or SOCKS5 proxy process-globally (all WebViews in this process).
     * Called by the React chrome when the user enables a proxy in Settings, and by the
     * ipcClient's `proxy.setConfig` Android route.
     *
     * @param scheme "http" or "socks5"
     * @param host   proxy host (non-empty, validated Rust-side)
     * @param port   proxy port (1–65535, validated Rust-side)
     * @param bypass comma-separated bypass-host list (may be empty)
     */
    @JavascriptInterface
    fun setProxy(scheme: String, host: String, port: Int, bypass: String) = runOnUiThread {
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return@runOnUiThread
      // Validate BEFORE building: ProxyConfig.Builder.addProxyRule throws
      // IllegalArgumentException on a malformed rule, so a bad scheme/host/port typed in
      // Settings must be a logged no-op, not an app crash on the UI thread.
      if (!isValidProxy(scheme, host, port)) {
        Log.w("AegisProxy", "ignoring invalid proxy config $scheme://$host:$port")
        return@runOnUiThread
      }
      val rule = "$scheme://$host:$port"
      try {
        val builder = proxyBuilder(scheme, host, port, bypass.split(","))
        ProxyController.getInstance().setProxyOverride(builder, { it.run() }, {
          Log.i("AegisProxy", "proxy set: $rule")
        })
      } catch (t: Throwable) {
        Log.w("AegisProxy", "setProxyOverride failed", t)
      }
    }

    /**
     * Clear the process-global proxy override, returning to direct connections.
     * Called by the React chrome when the user disables the proxy in Settings, and
     * by the ipcClient's `proxy.setConfig` (mode=off) / `proxy.clear` Android routes.
     */
    @JavascriptInterface
    fun clearProxy() = runOnUiThread {
      if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) return@runOnUiThread
      try {
        ProxyController.getInstance().clearProxyOverride({ it.run() }, {
          Log.i("AegisProxy", "proxy cleared")
        })
      } catch (t: Throwable) {
        Log.w("AegisProxy", "clearProxyOverride failed", t)
      }
    }
  }

  // --- GestureContainer.GestureHost: the gesture layer acts on the active tab. ---
  override fun gestureCanGoBack(): Boolean = contentWebView?.canGoBack() == true
  override fun gestureCanGoForward(): Boolean = contentWebView?.canGoForward() == true
  override fun gestureAtTop(): Boolean = (contentWebView?.scrollY ?: 1) == 0
  override fun gestureActiveTabId(): Int = activeTabId
  override fun gestureBack() { contentWebView?.let { if (it.canGoBack()) it.goBack() } }
  override fun gestureForward() { contentWebView?.let { if (it.canGoForward()) it.goForward() } }
  override fun gestureReload() { contentWebView?.reload() }

  companion object {
    // Request code for the OS permission dialogs a granted web request implies. Only
    // used to keep the calls apart in logs; the result is deliberately not routed back
    // into the web request (see requestAndroidPermissionFor).
    private const val REQ_WEB_PERMISSION = 4701

    // Vanilla mobile Chrome UA (no "; wv" WebView marker), mirroring the desktop
    // build's Chrome UA in nav.rs. Bump the Chrome version alongside it.
    private const val CHROME_UA =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"

    // The chrome's empty-tab / home URL. Used as the neutral state when a navigation is
    // refused, so every "no page" comparison reads the same value.
    private const val ABOUT_BLANK = "about:blank"

    // Upper bound on how long a coalesced chrome push may sit in the queue. Long enough to
    // swallow a burst of blocked subresources / nav events, short enough to stay invisible
    // (well under a frame budget the user could perceive as lag).
    private const val PUSH_FLUSH_MS = 100L

    // A popup capture WebView that never navigates (window.open() + document.write, or a
    // popup the page never closes) is destroyed after this long. Generous enough for a real
    // popup's first navigation to be captured, short enough to bound the memory an
    // ad-driven window.open() loop can hold.
    private const val POPUP_TEMP_TTL_MS = 10_000L

    // The subdirectory downloads are written to and recorded under. ONE name for both sides:
    // `downloadDir()` resolves it and `setDestinationInExternalFilesDir` is handed it, so the
    // path a row records cannot drift from the path the platform writes to. See downloadDir()
    // for why it is a constant and not a second literal.
    private const val DOWNLOAD_SUBDIR = "downloads"

    // Block-page copy, kept with the other constants so showMalwareWarning's callers all
    // phrase a refusal the same way (and so a new refusal reason has one obvious home).
    private const val MALWARE_REASON = "it's on a known-malware list."
    private const val SCHEME_REASON = "only web addresses (http/https) open in a tab."

    /** The refusal string for [isExternallyOpenableUrl]. Separate from [SCHEME_REASON]
     *  because the two lists are separate: a page-in-tab refusal and a
     *  hand-to-another-app refusal are different decisions with different consequences. */
    private const val EXTERNAL_SCHEME_REASON =
      "only web addresses (http/https) open in another app."

    // requestType() runs once per HTTP subresource (shouldInterceptRequest), so these two
    // patterns are compiled once here instead of per request.
    private val IMAGE_EXT = Regex("\\.(png|jpe?g|gif|webp|svg|ico|bmp)$")
    private val FONT_EXT = Regex("\\.(woff2?|ttf|otf|eot)$")
  }
}
