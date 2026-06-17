package com.aegis.browser

/**
 * The WebRTC IP-leak shim (document-start JS) built by the Rust `webrtc_shim` module for
 * the user's current `webrtcPolicy` (seeded at boot, updated on settings change). Returns
 * "" when no filtering applies ("default" policy). Registered per tab via
 * `WebViewCompat.addDocumentStartJavaScript` — read fresh per tab so a policy change
 * applies to new tabs. Native symbol lives in libapp_lib.so (see [NativeAdblock]).
 */
object NativeWebrtc {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** The WebRTC shim JS for the current policy ("" if no filtering applies). */
  external fun shimScript(): String
}
