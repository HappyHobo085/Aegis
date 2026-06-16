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

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile