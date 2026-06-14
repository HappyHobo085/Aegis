package com.aegis.browser

import android.graphics.Bitmap
import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge
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
      // Report navigations back to the chrome so the address bar/back/forward track
      // the current page (link clicks, redirects, form posts — not just typed URLs).
      content.webViewClient = object : WebViewClient() {
        override fun onPageStarted(view: WebView, url: String, favicon: Bitmap?) =
          pushNavState(url, true)

        override fun onPageFinished(view: WebView, url: String) =
          pushNavState(url, false)

        override fun doUpdateVisitedHistory(view: WebView, url: String, isReload: Boolean) =
          pushNavState(url, view.progress < 100)
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
    }
  }

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
        c.visibility = View.VISIBLE
        c.loadUrl(url)
      }
    }

    @JavascriptInterface
    fun back() = runOnUiThread { contentWebView?.let { if (it.canGoBack()) it.goBack() } }

    @JavascriptInterface
    fun forward() = runOnUiThread { contentWebView?.let { if (it.canGoForward()) it.goForward() } }

    @JavascriptInterface
    fun reload() = runOnUiThread { contentWebView?.reload() }
  }
}
