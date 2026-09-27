package com.aegis.browser

/**
 * The document-start script (pop-under guard + injected fetch/XHR/cosmetic ad-block
 * tier) built by the Rust `adblock_inject` module — the same script the desktop
 * Windows/macOS builds inject. Registered into each tab's WebView via
 * `WebViewCompat.addDocumentStartJavaScript`. Native symbol lives in libapp_lib.so
 * (see [NativeAdblock] for the loading note).
 */
object NativeInject {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * The full document-start JS to inject into the page main world before page scripts.
   *
   * [host] is the content WebView's host, so the Rust side can check the ad-block
   * allowlist (an allowlisted page gets no ad-block injection at all) — the same decision
   * desktop `adblock_inject::script` makes. An empty host means "unknown", which is
   * treated as not-allowlisted (ad-block stays on).
   */
  external fun documentStartScript(host: String): String
}
