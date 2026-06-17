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

  /** The full document-start JS to inject into the page main world before page scripts. */
  external fun documentStartScript(): String
}
