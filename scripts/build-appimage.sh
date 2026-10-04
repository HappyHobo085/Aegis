#!/usr/bin/env bash
# Build the release AppImage — a portable, single-file Linux build that runs on any
# distro (incl. Fedora). Mirrors the CI 'aegis-linux-appimage' job: bundles ONLY the
# AppImage (skips the .deb) and applies the media-framework config override so the
# bundled GStreamer plugins are version-matched to the host (HTML5 <video> works —
# see src-tauri/AGENTS.md gotcha 12).
#
# Usage:  bash scripts/build-appimage.sh
#
# Requires the Linux native build deps (Rust toolchain + webkit2gtk/gtk dev packages).
# The frontend is built automatically by `tauri build` (beforeBuildCommand).
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

# APPIMAGE_EXTRACT_AND_RUN=1 packs without needing FUSE (sandbox/CI-safe).
# NO_STRIP=1 matches `npm run tauri:build` (avoids strip issues on some toolchains).
export APPIMAGE_EXTRACT_AND_RUN=1
export NO_STRIP=1

echo ">> building release AppImage (full Rust release build — takes several minutes)…"
npm run tauri -- build --bundles appimage \
  --config src-tauri/tauri.appimage-mediaframework.conf.json

# Honour CARGO_TARGET_DIR: cargo writes the bundle under it, not src-tauri/target, so the
# old hardcoded path missed the artifact entirely whenever the env var was set.
TARGET_DIR="${CARGO_TARGET_DIR:-$PWD/src-tauri/target}"
APP=$(find "$TARGET_DIR/release/bundle/appimage" -name '*.AppImage' -printf '%T@ %p\n' 2>/dev/null \
        | sort -rn | head -1 | cut -d' ' -f2-)
[ -n "$APP" ] || { echo "ERROR: no .AppImage produced under $TARGET_DIR/release/bundle/appimage" >&2; exit 1; }

# linuxdeploy ships the WRONG-ARCH GStreamer plugin set on a multilib host and points
# GStreamer at a scanner it never bundled — that is the ~2.5s first-open stall and the
# dead appsink. Fix it here so a plain build ships a working bundle.
bash scripts/repack-appimage-gstreamer.sh "$APP"

echo ">> AppImage: $APP"
echo ">> size:     $(du -h "$APP" | cut -f1)"
echo ">> run it:   \"$APP\""
