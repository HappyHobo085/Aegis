package com.aegis.browser

/**
 * Settings the navigation chokepoint needs but cannot read itself.
 *
 * `MainActivity.secureUrl` is the single place every Android navigation decision passes
 * through, and it has no `AppHandle` to read the settings file with. So the Rust side mirrors
 * the `httpsOnly` policy into an app-free global at boot and on every `settings.write` (see
 * `settings.rs`: `ANDROID_HTTPS_ONLY` / `note_https_only`), and this object exposes it.
 *
 * Every getter here MUST fail TOWARDS THE PROTECTIVE value on a `Throwable`. A getter that
 * silently answered "off" when it could not ask would weaken the policy for every navigation
 * that follows, which is the same shape as the ad-block tier that must never stop blocking
 * because it could not read policy.
 */
object NativeSettings {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * Whether `http:` navigations must be upgraded to `https:` — the `httpsOnly` setting, which
   * is a real, synced setting the desktop honours at `nav.rs`. An unrecognised stored value is
   * clamped to `true` on the Rust side, so this is a genuine boolean.
   */
  external fun httpsOnly(): Boolean

  /** Read [httpsOnly], defaulting to `true` (keep upgrading) if the native call is unavailable. */
  fun httpsOnlyOrDefault(): Boolean =
    try {
      httpsOnly()
    } catch (_: Throwable) {
      true
    }
}
