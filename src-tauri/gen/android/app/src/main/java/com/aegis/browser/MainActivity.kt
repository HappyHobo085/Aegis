package com.aegis.browser

import android.os.Bundle
import android.view.View
import android.view.ViewGroup
import android.webkit.JavascriptInterface
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.FrameLayout
import androidx.activity.enableEdgeToEdge

/**
 * Mobile is single-webview, so the desktop multi-webview content view
 * (Window::add_child) is a no-op on Android. We add a native content WebView below
 * the chrome's toolbar and bridge it to the React chrome via a JS interface
 * (window.AegisAndroid), so the app actually browses.
 */
class MainActivity : TauriActivity() {
  private var contentWebView: WebView? = null

  override fun onCreate(savedInstanceState: Bundle?) {
    enableEdgeToEdge()
    super.onCreate(savedInstanceState)
  }

  override fun onWebViewCreate(webView: WebView) {
    // Defer until the chrome webview is attached so we can share its parent container.
    webView.post {
      val parent = (webView.parent as? ViewGroup) ?: findViewById(android.R.id.content)
      val content = WebView(this)
      content.settings.javaScriptEnabled = true
      content.settings.domStorageEnabled = true
      content.webViewClient = WebViewClient() // keep navigations inside this WebView
      // Inset below the chrome toolbar + favbar (DEFAULT_INSET_TOP = 96 logical px).
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

  /** Exposed to the chrome webview's JS as `window.AegisAndroid`. Methods run on the
   *  JS-bridge thread, so all WebView calls hop to the UI thread. */
  inner class Bridge {
    @JavascriptInterface
    fun navigate(url: String) = runOnUiThread {
      val c = contentWebView ?: return@runOnUiThread
      if (url.isEmpty() || url == "about:blank") {
        // Home: hide the content webview so the chrome's home screen shows.
        c.visibility = View.GONE
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
