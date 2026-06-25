<#
  Build the release Windows portable .exe — RUN THIS ON A WINDOWS MACHINE.

  Produces a portable, self-contained Aegis_x64_portable.exe (the frontend is
  embedded; no installer). Mirrors the CI 'aegis-windows-portable' job exactly:
  `tauri build --no-bundle` then copy the raw release binary.

  Requirements on the Windows host (see src-tauri/CLAUDE.md gotcha 15):
    - Rust (MSVC toolchain) + the "Desktop development with C++" workload
    - NASM and CMake (for aws-lc-sys, rustls' crypto C backend) on PATH
    - Node.js + npm, and a WebView2 Runtime to actually run the result
    - `npm install` already run

  Usage (from a PowerShell prompt):  ./scripts/build-windows-portable.ps1
#>
$ErrorActionPreference = 'Stop'

Set-Location (git rev-parse --show-toplevel)

Write-Host '>> building release Windows binary (npm run tauri -- build --no-bundle)…'
npm run tauri -- build --no-bundle
if ($LASTEXITCODE -ne 0) { throw "tauri build failed (exit $LASTEXITCODE)" }

$src = 'src-tauri/target/release/app.exe'
$dst = 'src-tauri/target/release/Aegis_x64_portable.exe'
if (-not (Test-Path $src)) { throw "expected binary not found: $src" }

Copy-Item $src -Destination $dst -Force
Write-Host ">> portable exe: $dst"
Write-Host (">> size:        {0:N1} MB" -f ((Get-Item $dst).Length / 1MB))
