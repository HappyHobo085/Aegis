#!/usr/bin/env bash
# Build the latest Aegis Android app (arm64 release APK, debug-key-signed) and
# install it on the connected phone, updating the existing app in place.
#
# Usage:  bash scripts/deploy-android.sh [--universal] [--reinstall]
#   --universal   build all ABIs instead of arm64-only (slower; for non-arm64 devices)
#   --reinstall   if the in-place update fails (signature mismatch), uninstall the
#                 existing app first, then install fresh (WIPES that app's data).
#
# Requirements on this host (see src-tauri/CLAUDE.md gotcha 8 + the android build memory):
#   - JDK 21 (Android Studio JBR) — Gradle/AGP break under JDK 25
#   - Android SDK + NDK 27, a connected device with USB debugging, adb on PATH
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# ── Toolchain env (JDK 21 + SDK/NDK) ───────────────────────────────────────────
export JAVA_HOME="${JAVA_HOME:-$HOME/development/android-studio/jbr}"
export ANDROID_HOME="${ANDROID_HOME:-$HOME/development/android-sdk}"
export NDK_HOME="${NDK_HOME:-$ANDROID_HOME/ndk/27.0.12077973}"
export ANDROID_NDK_HOME="${ANDROID_NDK_HOME:-$NDK_HOME}"

TARGET_ARGS=(--target aarch64)
REINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --universal) TARGET_ARGS=() ;;
    --reinstall) REINSTALL=1 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

# ── Preconditions ──────────────────────────────────────────────────────────────
command -v adb >/dev/null || { echo "ERROR: adb not on PATH" >&2; exit 1; }
[ -x "$JAVA_HOME/bin/java" ] || { echo "ERROR: JDK 21 not found at JAVA_HOME=$JAVA_HOME" >&2; exit 1; }

DEVICES=$(adb devices | awk 'NR>1 && $2=="device" {print $1}')
[ -n "$DEVICES" ] || { echo "ERROR: no authorized device connected (check 'adb devices')" >&2; exit 1; }
echo ">> device(s): $DEVICES"
echo ">> JAVA_HOME=$JAVA_HOME"
echo ">> building Android APK (${TARGET_ARGS[*]:-universal}) — this takes a few minutes…"

# ── Build ──────────────────────────────────────────────────────────────────────
npx tauri android build --apk "${TARGET_ARGS[@]}"

# ── Locate the freshest signed release APK ─────────────────────────────────────
OUT_DIR="src-tauri/gen/android/app/build/outputs/apk"
APK=$(find "$OUT_DIR" -name '*release*.apk' ! -name '*unsigned*' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-)
[ -n "$APK" ] || { echo "ERROR: no signed release APK found under $OUT_DIR" >&2; exit 1; }
echo ">> APK: $APK"

# ── Install (update in place) ──────────────────────────────────────────────────
echo ">> installing (adb install -r)…"
if adb install -r "$APK"; then
  echo ">> done — app updated on device."
  exit 0
fi

echo "!! in-place update failed (likely a signing-key mismatch with the installed app)."
if [ "$REINSTALL" -eq 1 ]; then
  echo ">> --reinstall set: uninstalling com.aegis.browser then installing fresh (app data is wiped)…"
  adb uninstall com.aegis.browser || true
  adb install "$APK"
  echo ">> done — app reinstalled."
else
  echo "   Re-run with --reinstall to uninstall the old copy first (WIPES that app's data):"
  echo "     bash scripts/deploy-android.sh --reinstall"
  exit 1
fi
