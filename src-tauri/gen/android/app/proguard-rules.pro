# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# Aegis exposes a native bridge to the chrome webview's JS as `window.AegisAndroid`
# (MainActivity$Bridge, via addJavascriptInterface). R8/minify in the release build
# would otherwise rename those @JavascriptInterface methods, breaking every
# window.AegisAndroid call (nav, content-visibility, fullscreen, back). Keep them.
# (The Rust JNI exports — NativeAdblock.shouldBlock etc. — are already kept by the wry
# rule `-keep class com.aegis.browser.* { native <methods>; }`.)
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# AegisKeystore.wrap/unwrap are *plain* (non-native) static methods that Rust calls from
# the other direction, via a JNI up-call (src-tauri/src/sync_keystore.rs). R8 cannot see
# those call sites, so the minified release build strips them — verified by dexdump on the
# shipped APK, where Lcom/aegis/browser/AegisKeystore; had "Direct methods : -" i.e. zero
# methods. The up-call then died with NoSuchMethodError, the seed was never persisted, and
# Settings → Sync fell back to the setup screen after every restart. Keep them by name.
-keep class com.aegis.browser.AegisKeystore {
    public static java.lang.String wrap(byte[]);
    public static byte[] unwrap(java.lang.String);
}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile