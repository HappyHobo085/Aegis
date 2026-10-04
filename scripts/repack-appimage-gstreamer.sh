#!/usr/bin/env bash
# Repair a linuxdeploy-built AppImage in place so its GStreamer plugin set actually loads.
#
# WHY THIS EXISTS — three stacked defects, all measured on a built AppImage
# (see src-tauri/AGENTS.md gotcha 12). None of them is app logic:
#   1. The bundled apprun-hooks/linuxdeploy-plugin-gstreamer.sh exports
#      GST_PLUGIN_SCANNER_1_0 at "$APPDIR/usr/lib/gstreamer1.0/gstreamer-1.0/gst-plugin-scanner",
#      a path the bundle does not contain -> GStreamer forks a missing helper once per
#      plugin (~300 failed execs), blocking the renderer in do_wait for ~2.5s on the first
#      sidebar/Settings open.
#   2. The same hook sets GST_REGISTRY_REUSE_PLUGIN_SCANNER=no, so the scan never caches
#      and the stall repeats on EVERY launch.
#   3. On a multilib build host linuxdeploy pulls the i686 plugin set, so the bundle's
#      plugins are ELFCLASS32 while libgstreamer and the only available scanner are 64-bit.
#      Every plugin is rejected ("wrong ELF class"), nothing registers, and appsink never
#      resolves -> HTML5 video/audio silently never work.
#
# tauri.appimage-mediaframework.conf.json cannot express this: bundle.linux.appimage.files
# is a destination->source map with NO glob support (it does a literal exists() check), so
# it cannot pull in ~263 host plugins. Hence the post-build repack.
#
# Usage: bash scripts/repack-appimage-gstreamer.sh <path/to/AppImage>
set -euo pipefail

APP="${1:-}"
[ -n "$APP" ] || { echo "usage: $0 <path/to/AppImage>" >&2; exit 2; }
[ -f "$APP" ] || { echo "ERROR: no such file: $APP" >&2; exit 1; }

CACHE="${AEGIS_APPIMAGETOOL_CACHE:-$HOME/.cache/aegis-tools}"
TOOL="$CACHE/appimagetool"
TOOL_URL="https://github.com/AppImage/AppImageKit/releases/download/continuous/appimagetool-x86_64.AppImage"

# The host plugin dir must be HOST-ARCH, or we would just be re-baking the same bug.
# /usr/lib64 is 64-bit on Fedora/RHEL; /usr/lib/gstreamer-1.0 is the i686 dir there.
PLUGIN_SRC=""
for d in /usr/lib64/gstreamer-1.0 /usr/lib/x86_64-linux-gnu/gstreamer-1.0 /usr/lib/gstreamer-1.0; do
  [ -d "$d" ] || continue
  probe=$(ls "$d"/libgstcoreelements.so 2>/dev/null | head -1)
  [ -n "$probe" ] || continue
  if file -b "$probe" | grep -q 'ELF 64-bit'; then PLUGIN_SRC="$d"; break; fi
done
SCANNER_SRC=""
for s in /usr/libexec/gstreamer-1.0/gst-plugin-scanner /usr/lib/gstreamer-1.0/gst-plugin-scanner; do
  [ -f "$s" ] && file -b "$s" | grep -q 'ELF 64-bit' && { SCANNER_SRC="$s"; break; }
done
if [ -z "$PLUGIN_SRC" ] || [ -z "$SCANNER_SRC" ]; then
  echo "!! no 64-bit GStreamer plugins + scanner on this host — leaving the AppImage as-is." >&2
  echo "!! HTML5 media and the first-open stall will both persist." >&2
  exit 3
fi
echo ">> host plugins:  $PLUGIN_SRC"
echo ">> host scanner:  $SCANNER_SRC"

if [ ! -x "$TOOL" ]; then
  echo ">> fetching appimagetool into $CACHE…"
  mkdir -p "$CACHE"
  curl -fsSL -o "$TOOL" "$TOOL_URL"
  chmod +x "$TOOL"
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
OUT="$WORK/$(basename "$APP")"
echo ">> extracting…"
( cd "$WORK" && APPIMAGE_EXTRACT_AND_RUN=1 "$APP" --appimage-extract >/dev/null 2>&1 )
ROOT="$WORK/squashfs-root"
[ -d "$ROOT" ] || { echo "ERROR: extraction produced no squashfs-root" >&2; exit 1; }

echo ">> replacing the plugin set…"
rm -rf "$ROOT/usr/lib/gstreamer-1.0"
mkdir -p "$ROOT/usr/lib/gstreamer-1.0"
cp -a "$PLUGIN_SRC"/libgst*.so "$ROOT/usr/lib/gstreamer-1.0/"
mkdir -p "$ROOT/usr/libexec/gstreamer-1.0"
cp -a "$SCANNER_SRC" "$ROOT/usr/libexec/gstreamer-1.0/gst-plugin-scanner"
# The empty placeholder the hook used to point at.
rm -rf "$ROOT/usr/lib/gstreamer1.0"

echo ">> rewriting the gstreamer hook…"
cat > "$ROOT/apprun-hooks/linuxdeploy-plugin-gstreamer.sh" <<'HOOK'
#! /bin/bash
export GST_PLUGIN_SYSTEM_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_PATH_1_0="${APPDIR}/usr/lib/gstreamer-1.0"
export GST_PLUGIN_SCANNER_1_0="${APPDIR}/usr/libexec/gstreamer-1.0/gst-plugin-scanner"
HOOK

# ARCH is required: the AppDir still carries 32-bit leftovers, so appimagetool refuses to
# guess ("More than one architectures were found").
echo ">> repacking…"
( cd "$WORK" && ARCH=x86_64 APPIMAGE_EXTRACT_AND_RUN=1 "$TOOL" squashfs-root "$OUT" >/dev/null 2>&1 )
[ -f "$OUT" ] || { echo "ERROR: repack produced nothing" >&2; exit 1; }

# Fail loudly rather than shipping a bundle that still has i686 plugins.
got=$(file -b "$ROOT/usr/lib/gstreamer-1.0/libgstcoreelements.so" | grep -oE 'ELF [0-9]+-bit')
[ "$got" = "ELF 64-bit" ] || { echo "ERROR: bundled plugin is $got, expected 64-bit" >&2; exit 1; }

cat "$OUT" > "$APP"          # write in place: keeps the path/inode stable for callers
echo ">> repacked: $APP"
echo ">> plugins:   $(ls "$ROOT/usr/lib/gstreamer-1.0"/libgst*.so | wc -l) (64-bit)"
echo ">> size:      $(du -h "$APP" | cut -f1)"