package com.aegis.browser

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import com.google.android.material.snackbar.Snackbar
import java.io.ByteArrayInputStream
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
  private var chromeWebView: WebView? = null

  // One native WebView per tab (live tabs); the active one is mirrored into contentWebView
  // so the existing margin/overlay/nav logic keeps targeting "the active tab".
  private val tabWebViews = HashMap<Int, WebView>()
  // Per-tab zoom (textZoom percent, 100 == 1.0). Session-only (not persisted), matching
  // the desktop v1 design. Kept on discard so a reactivated tab restores its zoom;
  // dropped on close (session ends).
  private val tabZoom = HashMap<Int, Int>()
  // IDs of private (incognito-mode) tabs. Best-effort ephemeral tier: Android WebView has
  // no per-WebView data partition (unlike desktop wry's incognito context), so isolation is
  // process-global — CookieManager and WebStorage are shared across ALL tabs. What we CAN
  // do per-WebView: disable disk cache (LOAD_NO_CACHE) and refuse 3rd-party cookies.
  // HONEST LIMIT: first-party cookies the private tab set LINGER in Android's process-global
  // cookie jar after close (Android has no per-tab/per-profile cookie isolation in the
  // released WebView API). Closing a private tab does NOT remove its first-party cookies.
  // A future "clear private browsing data" action is the intended mitigation; we do NOT flush
  // the global cookie jar on close because that would log the user out of all normal-tab sites.
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
      gc.layoutParams = p
    }
  }

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  // Back-press precedence: (a) a chrome sheet/menu is open -> tell the chrome to close
  // it (window.__aegisMobileBack) and consume the press; (b) else the content page can
  // go back -> navigate it back; (c) else default (exit). The chrome sets
  // backInterceptActive via the AegisAndroid bridge whenever a sheet is open.
  @Deprecated("Back press precedence: close an open chrome sheet, else page-back, else default")
  override fun onBackPressed() {
    when {
      backInterceptActive -> chromeWebView?.evaluateJavascript(
        "window.__aegisMobileBack && window.__aegisMobileBack()", null,
      )
      contentWebView?.canGoBack() == true -> contentWebView?.goBack()
      else -> @Suppress("DEPRECATION") super.onBackPressed()
    }
  }

  /** Count one blocked ad/tracker subresource on tab [id] and push the running totals to
   *  the chrome's shield badge via window.__aegisBlockedCount (the Android mirror of the
   *  Rust adblock::note_blocked → adblock.blockedCount event). Runs on a WebView network
   *  thread; the JS hop is posted to the chrome webview. */
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
    val js = "window.__aegisBlockedCount && window.__aegisBlockedCount($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
  }

  /** Build a per-tab WebViewClient. All fields (pageUrls, pushNavState) are threaded
   *  through [id] so each tab's navigation events carry the right tab identity. */
  private fun makeContentClient(id: Int): WebViewClient = object : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      pageUrls[id] = url
      resetPageBlocked(id)
      pushNavState(id, url, true, view)
    }

    override fun onPageFinished(view: WebView, url: String) {
      pushNavState(id, url, false, view)
      if (id == activeTabId) gestureContainer?.stopRefresh()
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
        val firstParty = pageUrls[id] ?: ""
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
      val raw = request.url?.toString() ?: return false
      if (!raw.startsWith("http")) return false

      // Scripted cross-origin top-frame redirect guard (anti-malvertising).
      val current = pageUrls[id] ?: ""
      val scripted = !request.hasGesture()
      if (current.isNotEmpty() &&
          NativeRedirectGuard.shouldBlock(current, raw, scripted, request.isForMainFrame)) {
        Log.i("AegisRedirect", "BLOCK $raw (from $current)")
        showRedirectBlocked(raw)
        return true
      }

      return when (val target = secureUrl(raw)) {
        null -> {
          showMalwareWarning(raw)
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

  /** Build a tab-agnostic WebChromeClient handling HTML5 fullscreen (video etc.) and
   *  multi-window (target=_blank / window.open → background tab via __aegisOpenTab). */
  private fun makeChromeClient(): WebChromeClient = object : WebChromeClient() {
    private var customView: View? = null
    private var customCallback: WebChromeClient.CustomViewCallback? = null

    override fun onShowCustomView(view: View, callback: WebChromeClient.CustomViewCallback) {
      if (customView != null) onHideCustomView()
      customView = view
      customCallback = callback
      view.setBackgroundColor(android.graphics.Color.BLACK)
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
      temp.webViewClient = object : WebViewClient() {
        override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
          val url = req.url?.toString() ?: return true
          // Drop ad pop-unders instead of opening a background tab: blank/script-scheme
          // shells (window.open('about:blank') the opener scripts → a dead empty tab)
          // and ad/tracker destinations (same engine + synced toggle/allowlist as
          // shouldInterceptRequest). The opener is the active tab; legit target=_blank
          // links to a real page still open a tab.
          val lower = url.trim().lowercase()
          val opener = pageUrls[activeTabId] ?: ""
          if (lower.isEmpty() || lower.startsWith("about:") || lower.startsWith("javascript:") ||
            NativeAdblock.shouldBlock(url, opener, "document")) {
            temp.post { temp.destroy() }
            return true
          }
          chromeWebView?.evaluateJavascript(
            "window.__aegisOpenTab && window.__aegisOpenTab(${JSONObject.quote(url)})",
            null,
          )
          // Defer destroy: tearing down a WebView from inside its own client callback
          // is fragile; post it to run after the callback returns.
          temp.post { temp.destroy() }
          return true
        }
      }
      transport.webView = temp
      resultMsg.sendToTarget()
      return true
    }
  }

  /** Create a new native WebView for [id], configure it, add it hidden to the container,
   *  and begin loading [url]. The caller registers it in tabWebViews. */
  // The document-start script (pop-under guard + injected ad-block tier) from the Rust
  // adblock_inject module. Computed ONCE — the ~1 MB string crossing JNI per tab would be
  // wasteful. Empty if the JNI getter fails, which disables injection rather than crashing.
  private val documentStartScript: String by lazy {
    try { NativeInject.documentStartScript() } catch (_: Throwable) { "" }
  }

  private fun createTabWebView(id: Int, url: String, isPrivate: Boolean = false): WebView {
    val wv = WebView(this)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    // Anti-fingerprint: present a vanilla mobile Chrome UA (no "; wv" WebView marker).
    wv.settings.userAgentString = CHROME_UA
    // Replay any session zoom stored for this tab (e.g. after a discard→reactivate) so
    // the user's zoom survives the WebView being recreated. No-op when unset (first open).
    tabZoom[id]?.let { wv.settings.textZoom = it }
    if (isPrivate) {
      // Best-effort private-mode ephemerality.
      // LIMIT: Android WebView has no per-WebView data partition; CookieManager and
      // WebStorage are process-global. We can't truly isolate a private tab's cookies
      // from a coexisting normal tab's. What we do here is the best available:
      //   • LOAD_NO_CACHE: skip disk read/write for this tab's HTTP cache (memory-only).
      //   • setAcceptThirdPartyCookies(false): refuse 3rd-party cookies for this WebView.
      //   • domStorageEnabled left TRUE (there is no per-WebView DOM-storage partition;
      //     turning it off site-wide is too blunt and breaks most pages).
      // First-party cookies set by this private tab linger in the process-global cookie jar
      // after close — Android has no per-tab isolation. See privateTabs comment above.
      wv.settings.cacheMode = WebSettings.LOAD_NO_CACHE
      CookieManager.getInstance().setAcceptThirdPartyCookies(wv, false)
    }
    // Multi-window support for target=_blank / window.open (Task 9).
    wv.settings.setSupportMultipleWindows(true)
    wv.settings.javaScriptCanOpenWindowsAutomatically = true
    wv.webChromeClient = makeChromeClient()
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
    if (documentStartScript.isNotEmpty() &&
      WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
    ) {
      try {
        WebViewCompat.addDocumentStartJavaScript(wv, documentStartScript, setOf("*"))
      } catch (t: Throwable) {
        Log.w("AegisInject", "document-start inject failed", t)
      }
    }
    // WebRTC IP-leak shim, document-start, per the user's webrtcPolicy. Read fresh per
    // tab (NOT cached) so a policy change applies to new tabs; "" when no filtering
    // applies ("default" policy).
    if (WebViewFeature.isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)) {
      val webrtc = try { NativeWebrtc.shimScript() } catch (_: Throwable) { "" }
      if (webrtc.isNotEmpty()) {
        try {
          WebViewCompat.addDocumentStartJavaScript(wv, webrtc, setOf("*"))
        } catch (t: Throwable) {
          Log.w("AegisWebrtc", "webrtc shim inject failed", t)
        }
      }
    }
    val lp = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    wv.visibility = View.GONE
    gestureContainer?.addView(wv, lp)
    pageUrls[id] = url
    wv.loadUrl(url)
    return wv
  }

  override fun onWebViewCreate(webView: WebView) {
    chromeWebView = webView
    // Defer until the chrome webview is attached so we can share its parent container.
    webView.post {
      val parent = (webView.parent as? ViewGroup) ?: findViewById(android.R.id.content)
      // Chrome heights are cached below; actual WebViews are created lazily by
      // activateTab (the chrome calls it on mount for the first tab).
      // Slim top chrome = address bar (48dp) + favourites strip (24dp) = 72dp; the
      // bottom action bar is 56dp. These MUST stay in sync with src/lib/layout.ts
      // (MOBILE_ADDRESS_H + MOBILE_FAV_H for the top, MOBILE_BOTTOMBAR_H for the bottom).
      val density = resources.displayMetrics.density
      val top = (72 * density).toInt()
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
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        statusTop = bars.top
        navBottom = bars.bottom
        applyContentMargins()
        val js =
          "document.documentElement.style.setProperty('--aegis-inset-top','${bars.top / density}px');" +
          "document.documentElement.style.setProperty('--aegis-inset-bottom','${bars.bottom / density}px');"
        webView.evaluateJavascript(js, null)
        insets
      }
      ViewCompat.requestApplyInsets(parent)
      // Let the React chrome (in the chrome webview) drive this content webview.
      webView.addJavascriptInterface(Bridge(), "AegisAndroid")
      // Warm the adblock engine (parses EasyList ~once) off the UI thread so the
      // first page's first request isn't stalled building it.
      Thread {
        try {
          NativeAdblock.shouldBlock("https://aegis.invalid/", "https://aegis.invalid/", "other")
        } catch (_: Throwable) {
        }
      }.start()
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
      accept.startsWith("image/") ||
        Regex("\\.(png|jpe?g|gif|webp|svg|ico|bmp)$").containsMatchIn(path) -> "image"
      accept.contains("javascript") || path.endsWith(".js") -> "script"
      accept.contains("text/html") -> "sub_frame"
      Regex("\\.(woff2?|ttf|otf|eot)$").containsMatchIn(path) -> "font"
      else -> "other"
    }
  }

  /** Security policy for a main-frame navigation target: returns the URL to actually
   *  load, the same URL if it's fine, or null to BLOCK it as known malware. Upgrades
   *  http→https (HTTPS-Only; localhost exempt — matches the desktop default-on). */
  private fun secureUrl(raw: String): String? {
    val uri = try {
      Uri.parse(raw)
    } catch (_: Throwable) {
      return raw
    }
    val host = uri.host ?: return raw
    if (NativeSafety.isMalwareHost(host)) return null
    val localhost = host == "localhost" || host == "127.0.0.1" || host == "::1"
    if (uri.scheme == "http" && !localhost) {
      return "https://" + raw.substring("http://".length)
    }
    return raw
  }

  /** Replace the content with a malware warning (the desktop shows a richer
   *  interstitial; a session "proceed anyway" on mobile is a follow-up). */
  private fun showMalwareWarning(url: String) {
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
      <p>Aegis blocked <code>$safeHost</code> because it's on a known-malware list.</p>
      <p>For your safety, the page was not loaded.</p></body></html>
    """.trimIndent()
    hasPage = true
    updateContentVisibility()
    contentWebView?.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    pushNavState(activeTabId, url, false)
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
    val js = "window.__aegisNavState && window.__aegisNavState($obj)"
    chromeWebView?.post { chromeWebView?.evaluateJavascript(js, null) }
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

  /** The mobile counterpart of the desktop RedirectBar: when the guard cancels a scripted
   *  cross-origin top-frame redirect, show a native Snackbar over the content WebView (a
   *  chrome-layer bar can't paint over the native WebView; a Snackbar floats above it).
   *  "Open anyway" opens the destination in a new tab via the chrome's __aegisOpenTab. */
  private fun showRedirectBlocked(to: String) {
    val host = try {
      Uri.parse(to).host ?: to
    } catch (_: Throwable) {
      to
    }
    runOnUiThread {
      val root = findViewById<View>(android.R.id.content) ?: return@runOnUiThread
      Snackbar.make(root, "Blocked a redirect to $host", 7000)
        .setAction("Open anyway") {
          chromeWebView?.evaluateJavascript(
            "window.__aegisOpenTab && window.__aegisOpenTab(${JSONObject.quote(to)})",
            null,
          )
        }
        .show()
    }
  }

  /**
   * Shared teardown for closeTab and discardTab.
   *
   * Removes the WebView from the gesture container, clears its per-tab cache and history
   * if it was a private tab, then destroys it.
   *
   * HONEST LIMIT: Android private mode is best-effort — LOAD_NO_CACHE + 3rd-party-cookies
   * refused + per-tab cache/history cleared on close. CookieManager and WebStorage are
   * process-global; first-party cookies the private tab set LINGER in the shared cookie jar
   * after close (no per-tab/per-profile isolation in the released WebView API). We do NOT
   * flush the global cookie jar on close — doing so would log the user out of all normal-tab
   * sites (Gmail, bank, etc.). A future "clear private browsing data" action is the intended
   * mitigation.
   *
   * [keepZoom] — pass true for discardTab (zoom survives a reload) and false for closeTab
   * (tab is gone permanently so the stored zoom is useless).
   */
  private fun teardownTab(id: Int, keepZoom: Boolean) {
    tabWebViews.remove(id)?.let { wv ->
      wv.visibility = View.GONE
      gestureContainer?.removeView(wv)
      if (privateTabs.contains(id)) {
        // Clear this tab's contribution to the HTTP cache and its navigation history.
        wv.clearCache(true)
        wv.clearHistory()
      }
      wv.destroy()
    }
    pageUrls.remove(id)
    pageBlocked.remove(id)
    if (!keepZoom) tabZoom.remove(id)
    if (activeTabId == id) { activeTabId = -1; contentWebView = null }
    privateTabs.remove(id)
  }

  /** Exposed to the chrome webview's JS as `window.AegisAndroid`. Methods run on the
   *  JS-bridge thread, so all WebView calls hop to the UI thread. */
  inner class Bridge {
    /**
     * Activate a tab: create its WebView lazily on first call, show it, hide all others.
     * The chrome calls this on mount for the first tab and on every tab switch.
     *
     * [isPrivate] — when true this tab runs in best-effort private mode: disk cache is
     * bypassed (LOAD_NO_CACHE) and third-party cookies are refused for its WebView.
     * First-party cookies linger in the shared jar after close (see HONEST LIMIT in teardownTab).
     * Task 8/9 will wire the chrome to pass isPrivate = true for incognito tabs.
     */
    @JavascriptInterface
    @JvmOverloads
    fun activateTab(id: Int, url: String, isPrivate: Boolean = false) = runOnUiThread {
      if (isPrivate) privateTabs.add(id)
      val wv = tabWebViews[id] ?: createTabWebView(id, url, isPrivate).also { tabWebViews[id] = it }
      activeTabId = id
      contentWebView = wv
      for ((tid, w) in tabWebViews) if (tid != id) w.visibility = View.GONE
      hasPage = (pageUrls[id] ?: url) != "about:blank"
      applyContentMargins()
      updateContentVisibility()
      // Re-push this tab's nav state so the chrome's address bar + back/forward update to
      // it. Switching to an already-live tab fires no page-load event, so without this the
      // chrome's useNav would reset to a blank state for the newly-activated tab.
      pushNavState(id, pageUrls[id] ?: url, false, wv)
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
      if (url.isEmpty() || url == "about:blank") {
        // Home: hide the content webview so the chrome's home screen shows, and
        // clear the address bar (blank state).
        hasPage = false
        updateContentVisibility()
        if (activeTabId >= 0) pageUrls[activeTabId] = "about:blank"
        pushNavState(activeTabId, "about:blank", false)
      } else {
        // Apply the security policy (malware block / HTTPS-Only upgrade) before load.
        when (val target = secureUrl(url)) {
          null -> showMalwareWarning(url)
          else -> {
            hasPage = true
            updateContentVisibility()
            if (activeTabId >= 0) pageUrls[activeTabId] = target
            c.loadUrl(target)
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

    /** Open a URL in the external browser (used to reach the releases page to install
     *  an update — the Tauri updater is desktop-only). */
    @JavascriptInterface
    fun openExternal(url: String) = runOnUiThread {
      try {
        startActivity(
          android.content.Intent(android.content.Intent.ACTION_VIEW, Uri.parse(url))
            .addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK),
        )
      } catch (_: Throwable) {
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
  }

  // --- GestureContainer.GestureHost: the gesture layer acts on the active tab. ---
  override fun gestureCanGoBack(): Boolean = contentWebView?.canGoBack() == true
  override fun gestureCanGoForward(): Boolean = contentWebView?.canGoForward() == true
  override fun gestureAtTop(): Boolean = (contentWebView?.scrollY ?: 1) == 0
  override fun gestureBack() { contentWebView?.let { if (it.canGoBack()) it.goBack() } }
  override fun gestureForward() { contentWebView?.let { if (it.canGoForward()) it.goForward() } }
  override fun gestureReload() { contentWebView?.reload() }

  companion object {
    // Vanilla mobile Chrome UA (no "; wv" WebView marker), mirroring the desktop
    // build's Chrome UA in nav.rs. Bump the Chrome version alongside it.
    private const val CHROME_UA =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  }
}
