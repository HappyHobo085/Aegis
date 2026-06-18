package com.aegis.browser

/**
 * Scripted cross-origin top-frame redirect guard, backed by the Rust
 * `redirect_guard` module — the same policy the desktop builds use. Native symbol
 * lives in libapp_lib.so (see [NativeAdblock] for the loading note).
 */
object NativeRedirectGuard {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** True if a navigation from [current] to [target] should be blocked. */
  external fun shouldBlock(current: String, target: String, scripted: Boolean, mainFrame: Boolean): Boolean
}
