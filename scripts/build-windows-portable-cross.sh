#!/usr/bin/env bash
# Cross-compile the Windows portable .exe FROM LINUX using the GNU toolchain (mingw-w64).
#
# CAVEAT: this is the x86_64-pc-windows-gnu build — NOT the MSVC build that ships via CI
# (scripts/build-windows-portable.ps1 on Windows, or the tauri-build-check workflow). It is
# best-effort for quick local iteration; a full release link from Linux is not guaranteed to
# succeed or to be byte-for-byte equivalent to the shipped exe. Validate on real Windows; for
# the canonical artifact use the .ps1 on a Windows host or trigger CI.
#
# Requires:
#   - rustup target add x86_64-pc-windows-gnu        (installed on this host)
#   - mingw-w64 gcc                                  (Fedora: sudo dnf install mingw64-gcc)
#   - if cargo's TLS to crates.io fails behind a CA-revocation-blocking network, set
#     http.check-revoke=false (see src-tauri/CLAUDE.md gotcha 15).
#
# Usage:  bash scripts/build-windows-portable-cross.sh
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

command -v x86_64-w64-mingw32-gcc >/dev/null 2>&1 || {
  echo "ERROR: mingw-w64 gcc not found (Fedora: sudo dnf install mingw64-gcc)" >&2
  exit 1
}
rustup target list --installed 2>/dev/null | grep -qx x86_64-pc-windows-gnu || {
  echo "ERROR: rust target missing — run: rustup target add x86_64-pc-windows-gnu" >&2
  exit 1
}

# The release binary embeds the built frontend at compile time, so build dist first.
echo ">> building renderer (dist) for embedding…"
npm run build:renderer

echo ">> cross-compiling release exe (cargo, x86_64-pc-windows-gnu / GNU)…"
cargo build --release --target x86_64-pc-windows-gnu --manifest-path src-tauri/Cargo.toml

SRC=src-tauri/target/x86_64-pc-windows-gnu/release/app.exe
DST=src-tauri/target/x86_64-pc-windows-gnu/release/Aegis_x64_portable.exe
[ -f "$SRC" ] || {
  echo "ERROR: $SRC not produced — the GNU cross-link likely failed." >&2
  echo "       Use scripts/build-windows-portable.ps1 on Windows (MSVC) for the shipped exe." >&2
  exit 1
}
cp -f "$SRC" "$DST"
echo ">> portable exe (GNU cross): $DST"
echo ">> size: $(du -h "$DST" | cut -f1)"
echo ">> NOTE: GNU cross-build — validate on real Windows; the shipped exe is MSVC (CI/.ps1)."
