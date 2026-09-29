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

  /**
   * Open a BLOCKED redirect's [to] in a background tab, through the SAME budget the
   * desktop builds use (— dedup within `REDIRECT_DEDUP_WINDOW`, at most
   * `MAX_LIVE_REDIRECT_TABS` live, and a 30-second auto-close of a tab the user never
   * looked at). Implemented in Rust (`redirect_guard.rs`), which is what actually
   * creates the tab — so the cap cannot be bypassed by arriving from the phone.
   *
   * [from] is required as well as [to]: the dedup key is the (from, to) PAIR, so half a
   * pair is not a redirect and Rust refuses it.
   *
   * Returns whether a tab was ACTUALLY opened. When false the caller must NOT open the
   * URL by any other route: a fallback is the unbudgeted path this replaces, and doing
   * both would open two tabs per block. Never throws; a failure is a logcat line and
   * `false`, because a failed open must not become a crashed navigation.
   */
  external fun openBlockedRedirect(from: String, to: String): Boolean
}
