import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

android {
    compileSdk = 36
    namespace = "com.aegis.browser"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.aegis.browser"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    // Real release signing: drop a `keystore.properties` (gitignored) at the android project
    // root with storeFile/storePassword/keyAlias/keyPassword. Without it a release build
    // FAILS unless AEGIS_ALLOW_DEBUG_SIGNED_RELEASE=1 (then: debug key, sideload-only) —
    // see the packaging-task check at the bottom of this file (audit 6.4 / D6).
    val keystorePropsFile = rootProject.file("keystore.properties")
    if (keystorePropsFile.exists()) {
        val props = Properties().apply { keystorePropsFile.inputStream().use { load(it) } }
        signingConfigs.create("release") {
            storeFile = file(props.getProperty("storeFile"))
            storePassword = props.getProperty("storePassword")
            keyAlias = props.getProperty("keyAlias")
            keyPassword = props.getProperty("keyPassword")
        }
    }
    buildTypes {
        getByName("debug") {
            applicationIdSuffix = ".debug"
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
            // Sign the release APK with the real release keystore when keystore.properties
            // exists (storeFile/storePassword/keyAlias/keyPassword — see .gitignore). Without
            // it the debug key is selected here, but packaging a release REFUSES to run on it
            // unless AEGIS_ALLOW_DEBUG_SIGNED_RELEASE=1 (audit 6.4, owner decision D6): a
            // debug-signed "release" can never update, or be updated by, any other build, and
            // it used to be produced silently. The check is in the packaging task (below), not
            // here, so configuring or building a DEBUG variant never trips it.
            signingConfig = signingConfigs.findByName("release") ?: signingConfigs.getByName("debug")
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
}

rust {
    rootDirRel = "../../../"
}

// D6 / audit 6.4: refuse to PACKAGE a release APK/AAB on the debug key unless explicitly
// opted out. Lazy (doFirst on the release packaging tasks) so debug builds, IDE sync and
// `tauri android dev` are unaffected; only `package*Release` / `bundle*Release` run it.
val releaseSignedWithRealKey = rootProject.file("keystore.properties").exists()
tasks.configureEach {
    val isReleasePackaging = name.endsWith("Release") &&
        (name.startsWith("package") || name.startsWith("bundle"))
    if (isReleasePackaging) {
        doFirst {
            if (!releaseSignedWithRealKey && System.getenv("AEGIS_ALLOW_DEBUG_SIGNED_RELEASE") != "1") {
                throw GradleException(
                    "Release build has no keystore.properties, so it would be signed with the " +
                        "DEBUG key (it could never update or be updated by another build). Add " +
                        "keystore.properties, or set AEGIS_ALLOW_DEBUG_SIGNED_RELEASE=1 for a " +
                        "one-off sideload build."
                )
            }
        }
    }
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")