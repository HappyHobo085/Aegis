package com.aegis.browser

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
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
class MainActivity : TauriActivity() {
  private var contentWebView: WebView? = null
  private var chromeWebView: WebView? = null

  // One native WebView per tab (live tabs); the active one is mirrored into contentWebView
  // so the existing margin/overlay/nav logic keeps targeting "the active tab".
  private val tabWebViews = HashMap<Int, WebView>()
  private var activeTabId = -1
  // Per-tab current page URL (the ad-block first-party context), read on the network
  // thread in shouldInterceptRequest; concurrent for safe cross-thread reads.
  private val pageUrls = java.util.concurrent.ConcurrentHashMap<Int, String>()
  // The shared content container (the chrome webview's parent), set in onWebViewCreate.
  private var contentParent: ViewGroup? = null

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

  private fun updateContentVisibility() {
    contentWebView?.visibility = if (hasPage && !overlayHidden) View.VISIBLE else View.GONE
  }

  /** Position the content webview: fill the safe area minus the chrome gaps currently
   *  showing — the top chrome (unless fullscreen) and the bottom action bar (unless it's
   *  toggled off or fullscreen). Called from the insets listener and the chrome bridges. */
  private fun applyContentMargins() {
    val c = contentWebView ?: return
    (c.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
      p.topMargin = (if (fullscreen) 0 else topChromePx) + statusTop
      p.bottomMargin = (if (fullscreen || bottomBarHidden) 0 else bottomBarPx) + navBottom
      c.layoutParams = p
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

  /** Build a per-tab WebViewClient. All fields (pageUrls, pushNavState) are threaded
   *  through [id] so each tab's navigation events carry the right tab identity. */
  private fun makeContentClient(id: Int): WebViewClient = object : WebViewClient() {
    override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
      pageUrls[id] = url
      pushNavState(id, url, true, view)
    }

    override fun onPageFinished(view: WebView, url: String) = pushNavState(id, url, false, view)

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
  private fun createTabWebView(id: Int, url: String): WebView {
    val wv = WebView(this)
    wv.settings.javaScriptEnabled = true
    wv.settings.domStorageEnabled = true
    // Anti-fingerprint: present a vanilla mobile Chrome UA (no "; wv" WebView marker).
    wv.settings.userAgentString = CHROME_UA
    // Multi-window support for target=_blank / window.open (Task 9).
    wv.settings.setSupportMultipleWindows(true)
    wv.settings.javaScriptCanOpenWindowsAutomatically = true
    wv.webChromeClient = makeChromeClient()
    wv.webViewClient = makeContentClient(id)
    val lp = FrameLayout.LayoutParams(
      FrameLayout.LayoutParams.MATCH_PARENT,
      FrameLayout.LayoutParams.MATCH_PARENT,
    )
    lp.topMargin = topChromePx + statusTop
    lp.bottomMargin = bottomBarPx + navBottom
    wv.visibility = View.GONE
    contentParent?.addView(wv, lp)
    pageUrls[id] = url
    wv.loadUrl(url)
    return wv
  }

  override fun onWebViewCreate(webView: WebView) {
    chromeWebView = webView
    // Defer until the chrome webview is attached so we can share its parent container.
    webView.post {
      val parent = (webView.parent as? ViewGroup) ?: findViewById(android.R.id.content)
      // Cache the content parent and chrome heights; actual WebViews are created lazily
      // by activateTab (the chrome calls it on mount for the first tab).
      contentParent = parent
      // Slim top chrome = address bar (48dp) + favourites strip (24dp) = 72dp; the
      // bottom action bar is 56dp. These MUST stay in sync with src/lib/layout.ts
      // (MOBILE_ADDRESS_H + MOBILE_FAV_H for the top, MOBILE_BOTTOMBAR_H for the bottom).
      val density = resources.displayMetrics.density
      val top = (72 * density).toInt()
      val bottomBar = (56 * density).toInt()
      topChromePx = top
      bottomBarPx = bottomBar
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

  /** Exposed to the chrome webview's JS as `window.AegisAndroid`. Methods run on the
   *  JS-bridge thread, so all WebView calls hop to the UI thread. */
  inner class Bridge {
    /** Activate a tab: create its WebView lazily on first call, show it, hide all others.
     *  The chrome calls this on mount for the first tab and on every tab switch. */
    @JavascriptInterface
    fun activateTab(id: Int, url: String) = runOnUiThread {
      val wv = tabWebViews[id] ?: createTabWebView(id, url).also { tabWebViews[id] = it }
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
      tabWebViews.remove(id)?.let {
        it.visibility = View.GONE
        contentParent?.removeView(it)
        it.destroy()
      }
      pageUrls.remove(id)
      if (activeTabId == id) { activeTabId = -1; contentWebView = null }
    }

    /** Discard an idle tab (memory reclaim): destroy its WebView; re-activating will
     *  reload it via activateTab. Same teardown as closeTab. */
    @JavascriptInterface
    fun discardTab(id: Int) = runOnUiThread {
      tabWebViews.remove(id)?.let {
        it.visibility = View.GONE
        contentParent?.removeView(it)
        it.destroy()
      }
      pageUrls.remove(id)
      if (activeTabId == id) { activeTabId = -1; contentWebView = null }
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
  }

  companion object {
    // Vanilla mobile Chrome UA (no "; wv" WebView marker), mirroring the desktop
    // build's Chrome UA in nav.rs. Bump the Chrome version alongside it.
    private const val CHROME_UA =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Mobile Safari/537.36"
  }
}
