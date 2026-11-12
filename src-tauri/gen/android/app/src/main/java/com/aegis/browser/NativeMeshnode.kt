package com.aegis.browser

/**
 * Tells the Rust `meshnode` module whether Meshnode (package [PACKAGE]) is installed.
 *
 * Only Kotlin can ask the `PackageManager`, and the Rust `meshnode.detected` channel has no
 * way to up-call it, so [MainActivity.noteMeshnodeInstalled] pushes the answer on every
 * `onResume` (the user may install Meshnode while Aegis is in the background) and Rust stores
 * it in `meshnode::ANDROID_INSTALLED`. The answer only decides whether the Sync tab OFFERS
 * Meshnode's local sync URL; nothing connects to Meshnode because of it.
 *
 * Native symbol lives in libapp_lib.so (see [NativeAdblock] for the loading note); JNI export
 * is `Java_com_aegis_browser_NativeMeshnode_noteInstalled` in `meshnode.rs`.
 */
object NativeMeshnode {
  /** Meshnode's application id; must match the manifest's `<queries>` entry. */
  const val PACKAGE = "net.meshnode.app"

  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  external fun noteInstalled(installed: Boolean)
}
