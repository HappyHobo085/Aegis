package com.aegis.browser

/**
 * Anti-fingerprinting (farbling) shim (document-start JS) built by the Rust `farble` module
 * for the user's current `antiFingerprint` level (seeded at boot, updated on settings change).
 * Returns "" when no farbling applies (level "off" or any unrecognised stored value — the Rust
 * side clamps at the read point). Registered per tab via
 * `WebViewCompat.addDocumentStartJavaScript` — read fresh per tab so a level change applies
 * to new tabs. Native symbol lives in libapp_lib.so (see [NativeAdblock]).
 *
 * Per-site allowlist note: the fp-allowlist is desktop-only in v1. `farbleScript()` always
 * passes `host_allowlisted = false` on Android, so farbling applies to all hosts regardless
 * of the fp-allowlist. Parity gap documented in farble.rs.
 */
object NativeFarble {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** The farble shim JS for the current level ("" if no farbling applies). */
  external fun farbleScript(): String
}
