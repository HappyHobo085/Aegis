package com.aegis.browser

/**
 * Proxy configuration getter for the Android boot-apply path.
 *
 * Returns the serialized `ProxyConfig` JSON (mode/scheme/host/port/bypassHosts) that
 * the Rust `proxy::note_config` global was last updated with. The Kotlin boot-apply
 * (`onWebViewCreate` → `webView.post { … }`) reads this once and calls
 * `AegisAndroid.setProxy` / `clearProxy` so a persisted ON proxy is live from the
 * first page load — before the React chrome can call `setProxy` itself.
 *
 * Returns "" when no config has been pushed yet (Kotlin treats that as OFF / direct).
 *
 * Native symbol lives in libapp_lib.so; JNI export is
 * `Java_com_aegis_browser_NativeProxy_proxyConfig` in `proxy.rs`.
 */
object NativeProxy {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** Serialized ProxyConfig JSON, or "" if not yet seeded. */
  external fun proxyConfig(): String
}
