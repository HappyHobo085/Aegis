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

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
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
      // Inset below the chrome toolbar (DEFAULT_INSET_TOP = 96 logical px). On a
      // phone the chrome folds the favorites row into a two-row toolbar that is also
      // 96px, so the content still lines up directly under it.
      val top = (96 * resources.displayMetrics.density).toInt()
      val lp = FrameLayout.LayoutParams(
        FrameLayout.LayoutParams.MATCH_PARENT,
        FrameLayout.LayoutParams.MATCH_PARENT,
      )
      lp.topMargin = top
      content.visibility = View.GONE // hidden at home so the chrome's home screen shows
      parent.addView(content, lp)
      contentWebView = content
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
    contentWebView?.let {
      it.visibility = View.VISIBLE
      it.loadDataWithBaseURL(null, html, "text/html", "utf-8", null)
    }
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
        c.visibility = View.GONE
        pushNavState("about:blank", false)
      } else {
        // Apply the security policy (malware block / HTTPS-Only upgrade) before load.
        when (val target = secureUrl(url)) {
          null -> showMalwareWarning(url)
          else -> {
            c.visibility = View.VISIBLE
            c.loadUrl(target)
          }
        }
      }
    }

    @JavascriptInterface
    fun back() = runOnUiThread { contentWebView?.let { if (it.canGoBack()) it.goBack() } }

    @JavascriptInterface
    fun forward() = runOnUiThread { contentWebView?.let { if (it.canGoForward()) it.goForward() } }

    @JavascriptInterface
    fun reload() = runOnUiThread { contentWebView?.reload() }
  }

  companion object {
    // Vanilla mobile Chrome UA (no "; wv" WebView marker), mirroring the desktop
    // build's Chrome UA in nav.rs. Bump the Chrome version alongside it.
    private const val CHROME_UA =
      "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36"
  }
}
