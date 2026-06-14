package com.aegis.browser

/**
 * Network ad-blocking backed by the Rust `adblock` engine (EasyList) — the same
 * engine and lists the desktop build uses. The native symbol lives in libapp_lib.so,
 * already loaded at startup by the Tauri runtime (generated/Rust.kt); the
 * loadLibrary here is a defensive, idempotent no-op in case of init ordering.
 */
object NativeAdblock {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * True if a request to [url], made by the page at [sourceUrl] (with a best-effort
   * [requestType] like "script"/"image"/"document"), should be blocked. Implemented
   * in Rust (adblock_engine.rs); fails open on any error.
   */
  external fun shouldBlock(url: String, sourceUrl: String, requestType: String): Boolean
}
