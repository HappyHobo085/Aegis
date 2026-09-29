package com.aegis.browser

/**
 * The REMEMBERED half of the site-permission policy, backed by the Rust `permissions`
 * module — the same store `permissions.list` answers on every platform, and the same
 * (origin, permission) rows the desktop builds record.
 *
 * Rust cannot deliver a verdict to a WebView callback, so on Android the LIVE request (a
 * `PermissionRequest` to grant, or a `GeolocationPermissions.Callback` to invoke) is
 * answered from Kotlin. What this bridge provides is the part that has to AGREE with
 * desktop: how an origin is normalized, what was remembered for a pair, and how a new
 * decision is stored. The gateway is Kotlin-to-Rust only (Rust cannot up-call), so these
 * three calls are the whole of the contract.
 */
object NativePermissions {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * `scheme://host[:port]` of [uri] — host lowercased, default ports dropped, path, query
   * and userinfo stripped — or [uri] unchanged when it does not parse. Implemented in Rust
   * (`permissions::origin_of`), so the same site keys the same store row on every platform.
   */
  external fun normalizeOrigin(uri: String): String

  /**
   * What the user already decided for ([origin], [permission]): `"allow"`, `"deny"`, or
   * `""` to ask. Returns Unit and never throws for a missing store; failures are dropped
   * with a logcat line, which the caller treats as `""` — the safe direction, since a
   * remembered allow must never be assumed when the lookup could not happen.
   */
  external fun decision(origin: String, permission: String): String

  /**
   * Upsert a remembered decision for ([origin], [permission]); `allow = false` records a
   * deny. `allow-once` is deliberately NOT routed here: it answers one request and asks
   * again next time, so there is nothing to store.
   */
  external fun remember(origin: String, permission: String, allow: Boolean)
}
