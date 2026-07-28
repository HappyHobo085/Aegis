package com.aegis.browser

/**
 * Anti-fingerprinting (farbling) shim (document-start JS) built by the Rust `farble` module
 * for the user's current `antiFingerprint` level (seeded at boot, updated on settings change).
 * Returns "" when no farbling applies (level "off" or any unrecognised stored value — the Rust
 * side clamps at the read point). Registered per tab via
 * `WebViewCompat.addDocumentStartJavaScript` — read fresh per tab so a level change applies
 * to new tabs. Native symbol lives in libapp_lib.so (see [NativeAdblock]).
 *
 * Per-site fp-allowlist: the caller passes the tab's content host; the Rust JNI getter checks
 * the `ANDROID_FP_ALLOWLIST` global (mirrored from `FarbleState` via `note_fp_allowlist`) for
 * an exact or subdomain match. Allowlisted hosts receive no farble shim, matching desktop
 * behavior. See farble.rs for the implementation.
 */
object NativeFarble {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * The farble shim JS for the current level ("" if no farbling applies).
   * @param host the content host for the tab being created — checked against the per-site
   *   fp-allowlist so allowlisted hosts receive no shim.
   */
  external fun farbleScript(host: String): String
}
