# Aegis — Deferred Distribution Requirements

**Date:** 2026-06-11
**Status:** DEFERRED (documented, not built). Reason: the standing local-only / headless
constraint precludes a release host, signing certificates, and a notarization/update feed.
This document records exactly what a real release would require.

Verified absent at the Phase-5 exit: `package.json` declares no `electron-builder` /
`electron-updater` dependency and no `build`/`extraResources` packaging config; neither package
is installed in `node_modules`. The seed blob is copied into the build output for dev/test by the
`aegis-copy-seed` plugin in `electron.vite.config.ts`, but `extraResources` bundling for a
packaged app is not configured.

## What is NOT built (and why)

| Area | What a release needs | Why deferred |
|------|----------------------|--------------|
| Packaging | electron-builder targets/installers (AppImage/deb/rpm on Linux; nsis/msi on Windows; dmg on macOS) | Needs per-OS build hosts; out of scope for local-only |
| Seed bundling | `extraResources` to ship the generated filter seed inside the packaged app | Tied to packaging above |
| Code-signing | Windows Authenticode cert; macOS Developer ID cert | Requires purchased certificates / key custody |
| Notarization | Apple notarytool submission + stapling | Requires an Apple Developer account + signing |
| Auto-update | electron-updater + a remote release feed (e.g. a static update server or GitHub Releases) | Requires a remote release host (ruled out) |
| Publishing | Release pipeline + checksums + signed artifacts | Tied to all of the above |
| Telemetry/stats | Detailed ad-block stats/logs surfacing | Out of scope; privacy-by-default |

## Concrete checklist for a future release cycle

1. Add `electron-builder` config (targets + `extraResources` for the seed) to `package.json`
   / a builder config; verify a packaged build launches and blocks ads.
2. Provision signing certs (Win Authenticode, macOS Developer ID) in CI secrets; sign the
   artifacts.
3. macOS: notarize via `notarytool` and staple.
4. Stand up an update feed; wire `electron-updater`; verify a signed update round-trips.
5. Bump/track Electron per `engine-update-policy.md`; re-run the full dual-ABI gate +
   re-verify `security-audit-signoff.md`.
6. Publish signed artifacts with checksums and release notes (record the Chromium version).

Until a release host + certs exist, Aegis remains a local-only build; everything in §"What
is NOT built" stays deferred and is intentionally absent — not a gap in the Phase-5 feature
work.
