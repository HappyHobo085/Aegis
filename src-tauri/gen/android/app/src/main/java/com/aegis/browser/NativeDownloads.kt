package com.aegis.browser

/**
 * Bridges the Android download pipeline into the Rust core.
 *
 * Android's content area is a NATIVE `WebView`, so nothing in the Rust core can ever see a
 * download: there is no wry `WebResourceRequested` and no `WebViewClient` hook to hang it off,
 * and `downloads::on_requested` had no caller on this platform at all. Kotlin is the only side
 * that receives `DownloadListener`, and Rust cannot up-call into Kotlin, so this down-call is
 * the only direction available — exactly the shape `NativeHistory.recordVisit` already uses for
 * history (see gotcha 24 in src-tauri/AGENTS.md).
 */
object NativeDownloads {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  /**
   * Implemented in Rust (`downloads::record_download_start`): records a `progressing` row for a
   * transfer Kotlin is about to perform, using the destination the CALLER chose.
   *
   * Passing the path in is the whole reason this cannot reuse `downloads::on_requested`: that
   * function derives the filename from the URL and overwrites the caller's destination, which is
   * right for a desktop download manager that picks where to write and wrong here — Android's
   * `DownloadListener` hands the app NO destination at all, so Kotlin is the side that has to
   * name the real file.
   *
   * Returns Unit and never throws for a missing store; failures are dropped with a logcat line
   * rather than surfaced, since a download must not break page loading.
   */
  external fun recordStart(url: String, destination: String, isPrivate: Boolean)

  /**
   * Implemented in Rust (`downloads::on_finished`): settles the row whose URL matches into
   * `completed` or `interrupted`. Matching on the URL is what keeps two concurrent downloads
   * from settling each other.
   *
   * Returns Unit and never throws for a missing store; failures are dropped with a logcat line
   * rather than surfaced.
   */
  external fun recordFinish(url: String, success: Boolean)
}
