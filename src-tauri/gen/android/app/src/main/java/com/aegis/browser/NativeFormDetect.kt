package com.aegis.browser

/**
 * Vault autofill badge + form-detection script (document-start JS) built by the Rust
 * `vault_inject` module. Detects password fields, renders an autofill badge, and handles
 * badge clicks / form submissions. Registered per tab via
 * `WebViewCompat.addDocumentStartJavaScript`. Native symbol lives in libapp_lib.so
 * (see [NativeAdblock]).
 */
object NativeFormDetect {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** The vault autofill / form-detection JS for injection at document-start. */
  external fun formDetectionScript(): String
}
