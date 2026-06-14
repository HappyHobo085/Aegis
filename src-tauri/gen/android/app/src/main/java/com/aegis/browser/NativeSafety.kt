package com.aegis.browser

/**
 * Malicious-site protection backed by the Rust `safety` module (bundled URLhaus
 * blocklist) — the same list the desktop build uses. Native symbol lives in
 * libapp_lib.so (see [NativeAdblock] for the loading note).
 */
object NativeSafety {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** True if [host] is a known-malware host that should be blocked. */
  external fun isMalwareHost(host: String): Boolean
}
