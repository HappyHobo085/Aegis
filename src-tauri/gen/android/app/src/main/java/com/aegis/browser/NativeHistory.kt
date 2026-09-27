package com.aegis.browser

/**
 * Browsing-history recording backed by the Rust core — the same `history` JSON store
 * the desktop build writes from wry's `on_page_load`.
 *
 * Android NEEDS this: the content area is a native Kotlin `WebView`, not a wry
 * webview, so Tauri's `on_page_load` never fires for a browsed page and the core had
 * no way to learn a visit happened. Kotlin is the only side that sees `onPageFinished`,
 * so it reports the load down here. (Kotlin -> Rust is also the only viable direction:
 * Rust cannot up-call into Kotlin on this build.)
 *
 * The native symbol lives in libapp_lib.so, already loaded at startup by the Tauri
 * runtime (generated/Rust.kt); the loadLibrary here is a defensive, idempotent no-op in
 * case of init ordering.
 */
object NativeHistory {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * Record a finished top-level page load for tab [tabId].
   *
   * Implemented in Rust (history.rs): it resolves the tab's privateness from the tab
   * registry itself and drops the visit for a private tab, so pass only the id — never
   * a "isPrivate" flag you decided yourself. [title] is the page title, which Android
   * does have at page-finished. Non-web URLs (about:/data:) and empty urls are
   * filtered by the core, so the malware interstitial's data: page records nothing.
   *
   * Returns Unit and never throws for a missing store; failures are dropped with a
   * logcat line rather than surfaced, since history must not break page loading.
   */
  external fun recordVisit(tabId: Int, url: String, title: String)
}
