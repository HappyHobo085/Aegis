package com.aegis.browser

/**
 * Hands the [AegisKeystore] Class object to the Rust `sync_keystore` module.
 *
 * Rust calls `AegisKeystore.wrap/unwrap` from a *native* thread (the Tauri IPC thread), and
 * `JNIEnv::find_class` on a thread with no Java caller frames resolves against the SYSTEM class
 * loader, which cannot see the app's own classes. The up-call therefore failed with
 * ClassNotFoundException, which Rust swallowed — so the sync seed was silently never stored in
 * the hardware Keystore and Settings → Sync reset to "set up" after every app restart.
 *
 * [MainActivity.onCreate] calls [provideClass] once, before `super.onCreate` (which is what runs
 * `Rust.create()` → the Rust `setup()` hook → the boot-time sync restore), so the class is always
 * pinned before any up-call. Native symbol lives in libapp_lib.so (see [NativeAdblock] for the
 * loading note).
 */
object NativeSyncKeystore {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /** Cache `cls` natively (as a JNI global ref) for later static calls. */
  external fun provideClass(cls: Class<*>)
}
