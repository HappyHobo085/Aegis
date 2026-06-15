package com.aegis.browser

import android.graphics.Bitmap
import android.net.Uri
import android.os.Bundle
import android.util.Log
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
import androidx.core.view.ViewCompat
import androidx.core.view.WindowInsetsCompat
import java.io.ByteArrayInputStream
import org.json.JSONObject

/**
 * Mobile is single-webview, so the desktop multi-webview content view
 * (Window::add_child) is a no-op on Android. We add a native content WebView below
 * the chrome's toolbar and bridge it to the React chrome via a JS interface
 * (window.AegisAndroid), so the app actually browses. Navigation events flow the
 * other way — the content WebView's WebViewClient pushes nav state into the chrome
 * webview (window.__aegisNavState) so the address bar tracks the current page.
 */
class MainActivity : TauriActivity() {
  private var contentWebView: WebView? = null
  private var chromeWebView: WebView? = null

  /** The content webview's current page URL — the `source_url` (first-party context)
   *  the adblock engine needs. Written on navigation (UI thread), read in
   *  shouldInterceptRequest (network thread); volatile for safe cross-thread reads. */
  @Volatile private var currentPageUrl: String = ""

  // The native content WebView is shown only when a real page is loaded AND no chrome
  // overlay (settings/sidebar/shield popover/…) is covering it. Tauri's setChromeOverlay
  // can't reach this native view, so the chrome drives it via the bridge instead. Both
  // flags are touched only on the UI thread.
  private var hasPage = false
  private var overlayHidden = false

  // True while a chrome sheet/menu is open — the Back button should close it (via the
  // chrome) before navigating the page. Set by the chrome through AegisAndroid.
  @Volatile private var backInterceptActive = false

  // The current system nav-bar bottom inset, captured in the insets listener so the
  // scroll auto-hide can restore the correct bottom-bar gap when re-showing the bar.
  @Volatile private var navBottom = 0

  private fun updateContentVisibility() {
    contentWebView?.visibility = if (hasPage && !overlayHidden) View.VISIBLE else View.GONE
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

  override fun onWebViewCreate(webView: WebView) {
    chromeWebView = webView
    // Defer until the chrome webview is attached so we can share its parent container.
    webView.post {
      val parent = (webView.parent as? ViewGroup) ?: findViewById(android.R.id.content)
      val content = WebView(this)
      content.settings.javaScriptEnabled = true
      content.settings.domStorageEnabled = true
      // Anti-fingerprint: present a vanilla mobile Chrome UA instead of the default
      // Android System WebView string (which carries a "; wv" marker that flags it as
      // an embedded webview), mirroring the desktop build's Chrome UA.
      content.settings.userAgentString = CHROME_UA
      // Report navigations back to the chrome so the address bar/back/forward track
      // the current page (link clicks, redirects, form posts — not just typed URLs).
      content.webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) {
          currentPageUrl = url
          pushNavState(url, true)
        }

        override fun onPageFinished(view: WebView, url: String) =
          pushNavState(url, false)

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) {
          currentPageUrl = url
          pushNavState(url, view.progress < 100)
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
            when {
              host != null && NativeSafety.isMalwareHost(host) -> {
                Log.i("AegisSafety", "BLOCK malware $url")
                blockedResponse()
              }
              NativeAdblock.shouldBlock(url, currentPageUrl, requestType(url, request)) -> {
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
      // Slim top chrome = address bar (48dp) + favourites strip (24dp) = 72dp; the
      // bottom action bar is 56dp. These MUST stay in sync with src/lib/layout.ts
      // (MOBILE_ADDRESS_H + MOBILE_FAV_H for the top, MOBILE_BOTTOMBAR_H for the bottom).
      val density = resources.displayMetrics.density
      val top = (72 * density).toInt()
      val bottomBar = (56 * density).toInt()
      val lp = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
      lp.topMargin = top
      lp.bottomMargin = bottomBar
      content.visibility = View.GONE // hidden at home so the chrome's home screen shows
      parent.addView(content, lp)
      contentWebView = content
      // Keep the content webview below the status bar (time/battery) and above the
      // system navigation bar + the 56dp bottom action bar. The chrome pads its top
      // chrome down by the same status-bar inset (env(safe-area-inset-top)), so the
      // content starts at 72dp + that inset and ends 56dp + the nav-bar inset above
      // the bottom. Recomputed on every inset change (rotation, gesture vs 3-button nav).
      ViewCompat.setOnApplyWindowInsetsListener(parent) { _, insets ->
        val bars = insets.getInsets(WindowInsetsCompat.Type.systemBars())
        navBottom = bars.bottom
        (content.layoutParams as? FrameLayout.LayoutParams)?.let { p ->
          p.topMargin = top + bars.top
          p.bottomMargin = bottomBar + bars.bottom
          content.layoutParams = p
        }
        insets
      }
      ViewCompat.requestApplyInsets(parent)
      // Auto-hide the bottom action bar on scroll: scrolling DOWN past a small
      // threshold collapses the content's bottom-margin gap (the bar, which lives in
      // the chrome behind the content webview, is covered = hidden); scrolling UP, or
      // reaching the top, restores the gap. Push model — the chrome bar only shows in
      // this gap. (Stretch: if janky on-device, this listener can be removed.)
      val threshold = (6 * density).toInt()
      content.setOnScrollChangeListener { _, _, scrollY, _, oldScrollY ->
        val dy = scrollY - oldScrollY
        val target = when {
          scrollY <= 0 -> bottomBar + navBottom            // top of page: always show
          dy > threshold -> 0                              // scrolling down: hide
          dy < -threshold -> bottomBar + navBottom         // scrolling up: show
          else -> return@setOnScrollChangeListener
        }
        val p = content.layoutParams as? FrameLayout.LayoutParams ?: return@setOnScrollChangeListener
        if (p.bottomMargin == target) return@setOnScrollChangeListener
        android.animation.ValueAnimator.ofInt(p.bottomMargin, target).apply {
          duration = 160
          addUpdateListener { a ->
            p.bottomMargin = a.animatedValue as Int
            content.layoutParams = p
          }
          start()
        }
      }
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
    pushNavState(url, false)
  }

  private fun blockedResponse(): WebResourceResponse =
    WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))

  /** Push the content webview's nav state to the chrome's React state (NavState
   *  shape, viewId 1), by calling a global the Tauri client's nav.onState installs. */
  private fun pushNavState(url: String, loading: Boolean) {
    val c = contentWebView
    val obj = JSONObject()
      .put("viewId", 1)
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
    @JavascriptInterface
    fun navigate(url: String) = runOnUiThread {
      val c = contentWebView ?: return@runOnUiThread
      if (url.isEmpty() || url == "about:blank") {
        // Home: hide the content webview so the chrome's home screen shows, and
        // clear the address bar (blank state).
        hasPage = false
        updateContentVisibility()
        pushNavState("about:blank", false)
      } else {
        // Apply the security policy (malware block / HTTPS-Only upgrade) before load.
        when (val target = secureUrl(url)) {
          null -> showMalwareWarning(url)
          else -> {
            hasPage = true
            updateContentVisibility()
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
