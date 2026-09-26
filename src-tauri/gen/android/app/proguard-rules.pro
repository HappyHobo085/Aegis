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
-keepclassmembers class * {
    @android.webkit.JavascriptInterface <methods>;
}

# The nine Rust JNI exports (NativeAdblock.shouldBlock, NativeSafety.isMalwareHost,
# NativeRedirectGuard.shouldBlock, NativeInject.documentStartScript,
# NativeWebrtc.shimScript, NativeFarble.farbleScript, NativeFormDetect.formDetectionScript,
# NativeProxy.proxyConfig, NativeSyncKeystore.provideClass) are `external fun`s — R8 cannot
# see that the Rust side binds to them by name, so renaming either side breaks the JNI
# binding (UnsatisfiedLinkError / NoSuchMethodError at CALL time, i.e. ad-block injection,
# the WebRTC shim and malware blocking silently dying in the release build only).
# This keep used to be an IMPLICIT dependency on two files this repo does not own:
# Android's default proguard file (getDefaultProguardFile("proguard-android-optimize.txt")
# in build.gradle.kts) and the generated
# src/main/java/com/aegis/browser/generated/proguard-wry.pro — it is NOT a contract wry
# offers us. Both are replaceable at any time, and the AegisKeystore rule below is the
# proof that such a swap does happen and fails only at runtime, with no build error. So
# state the JNI keep explicitly here, in the file this repo actually tracks.
-keepclasseswithmembernames class com.aegis.browser.** {
    native <methods>;
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