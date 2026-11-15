package com.aegis.browser

import android.Manifest
import android.app.Activity
import android.content.ContentValues
import android.content.Context
import android.content.pm.PackageManager
import android.media.MediaScannerConnection
import android.os.Build
import android.os.Environment
import android.provider.MediaStore
import android.util.Log
import java.io.File
import java.io.IOException
import java.lang.ref.WeakReference

/**
 * Copies a finished `data.export` bundle into the user's REAL Downloads folder.
 *
 * Why this exists: on Android, Tauri's `download_dir()` is
 * `getExternalFilesDir(DIRECTORY_DOWNLOADS)` — the app-private
 * `Android/data/com.aegis.browser/files/Download/`. Android 11+ hides that tree from every
 * file manager and other app (even `adb shell` gets "Permission denied" on the 0600 file), and
 * an uninstall deletes it. So `data.export` used to report success with a path the user could
 * never open: verified on a Galaxy S23 / Android 17 on 2026-11-15, three exports sat there and
 * `/sdcard/Download/` held none. The Rust export still writes that private copy (the import
 * fallback reads it); this then PUBLISHES a copy the user can actually reach.
 *
 * Called from Rust (`data.rs`, `android_publish`) through a JNI up-call on the export's
 * background thread — the class is pinned by [NativeDataExport.provideClass] for the same
 * class-loader reason documented on [NativeSyncKeystore]. The method is kept by name in
 * proguard-rules.pro; R8 cannot see a JNI caller.
 *
 * Reply contract (parsed by `data::parse_publish_reply`, which is unit-tested):
 *   `ok:<path the user can find, e.g. Download/aegis-export-….json>`  or  `err:<reason>`.
 */
object AegisPublicDownloads {
  private const val TAG = "AegisExport"
  private const val REQ_STORAGE = 7301

  @Volatile private var appContext: Context? = null
  @Volatile private var activityRef: WeakReference<Activity>? = null

  /** Called from `MainActivity.onCreate`. */
  fun attach(activity: Activity) {
    appContext = activity.applicationContext
    activityRef = WeakReference(activity)
  }

  @JvmStatic
  fun publish(srcPath: String, name: String): String {
    val ctx = appContext ?: return "err:the app is not ready yet"
    val src = File(srcPath)
    if (!src.isFile) return "err:the export file is missing"
    return try {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) viaMediaStore(ctx, src, name)
      else viaPublicDir(ctx, src, name)
    } catch (t: Throwable) {
      Log.w(TAG, "publish to Downloads failed", t)
      "err:${t.message ?: t.javaClass.simpleName}"
    }
  }

  /** API 29+: MediaStore needs NO storage permission for files this app creates. */
  private fun viaMediaStore(ctx: Context, src: File, name: String): String {
    val resolver = ctx.contentResolver
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, name)
      put(MediaStore.MediaColumns.MIME_TYPE, "application/json")
      put(MediaStore.MediaColumns.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS)
      // Pending until the bytes are all there, so nothing sees a half-written backup.
      put(MediaStore.MediaColumns.IS_PENDING, 1)
    }
    val uri = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values)
      ?: return "err:Android refused to create the file in Downloads"
    try {
      val out = resolver.openOutputStream(uri, "w") ?: throw IOException("no output stream")
      out.use { o -> src.inputStream().use { it.copyTo(o) } }
      resolver.update(uri, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
    } catch (t: Throwable) {
      // Never leave a pending, partial row behind.
      try { resolver.delete(uri, null, null) } catch (_: Throwable) {}
      throw t
    }
    // MediaStore may rename on a collision ("… (1).json"), so report what it actually chose.
    val shown = resolver.query(uri, arrayOf(MediaStore.MediaColumns.DISPLAY_NAME), null, null, null)
      ?.use { c -> if (c.moveToFirst()) c.getString(0) else null } ?: name
    return "ok:${Environment.DIRECTORY_DOWNLOADS}/$shown"
  }

  /**
   * API 24–28: no MediaStore.Downloads, so write the public directory directly. That needs
   * WRITE_EXTERNAL_STORAGE (declared with maxSdkVersion=28 in the manifest). If it is not
   * granted yet, ask for it and fail THIS export honestly — the user exports again after
   * allowing, rather than being told a backup exists that does not.
   */
  @Suppress("DEPRECATION")
  private fun viaPublicDir(ctx: Context, src: File, name: String): String {
    if (ctx.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) != PackageManager.PERMISSION_GRANTED) {
      activityRef?.get()?.let { a ->
        a.runOnUiThread { a.requestPermissions(arrayOf(Manifest.permission.WRITE_EXTERNAL_STORAGE), REQ_STORAGE) }
      }
      return "err:allow storage access, then export again"
    }
    val dir = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS)
    if (!dir.isDirectory && !dir.mkdirs()) return "err:the Downloads folder is not available"
    val dest = File(dir, name)
    src.copyTo(dest, overwrite = false)
    MediaScannerConnection.scanFile(ctx, arrayOf(dest.absolutePath), arrayOf("application/json"), null)
    return "ok:${Environment.DIRECTORY_DOWNLOADS}/${dest.name}"
  }
}

/** Hands [AegisPublicDownloads] to Rust; see [NativeSyncKeystore] for why Rust can't look it up. */
object NativeDataExport {
  init {
    try {
      System.loadLibrary("app_lib")
    } catch (_: Throwable) {
      // already loaded by the Tauri runtime; ignore
    }
  }

  external fun provideClass(cls: Class<*>)
}
