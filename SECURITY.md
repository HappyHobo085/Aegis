# Security Policy

## Supported versions

Aegis ships an auto-update channel (tauri-plugin-updater + GitHub Releases). Only
the **latest released version** receives security updates; older builds are
expected to auto-update to it. There is no long-term-support branch.

| Version        | Supported                     |
| -------------- | ----------------------------- |
| Latest release | ✅                            |
| Older releases | ❌ (auto-update to latest)    |

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report privately through GitHub's **private vulnerability reporting**:

1. Open the repository's **Security** tab.
2. Click **Report a vulnerability** (GitHub Security Advisories).
3. Include the affected version, impact, and reproduction steps.

This routes the report privately to the maintainers. We aim to acknowledge within
**7 days** and to ship a fix or mitigation in a subsequent auto-updated release.
If private reporting is unavailable, contact the maintainer via the address on
their GitHub profile rather than filing a public issue.

## Security model (summary)

Aegis is a **Tauri 2** application (Rust core + a WebView-hosted UI) configured for
browsing untrusted web content:

- **Webview isolation:** the trusted UI ("chrome") and the page being browsed run in
  separate webviews. The chrome reaches the Rust core only through a single,
  channel-dispatched `ipc(channel, payload)` command; browsed pages have no access
  to that surface. A strict **Content-Security-Policy** (in `tauri.conf.json`)
  constrains the chrome to its own bundled assets — `default-src 'self'`,
  `script-src 'self'`, `object-src 'none'`, no inline/remote scripts.
- **Least privilege:** the Tauri capability set (`src-tauri/capabilities/default.json`)
  grants only core events and open/save file dialogs — no filesystem, shell, or
  arbitrary-command permissions.
- **Network protections (built in):**
  - **Ad/tracker blocking** via Brave's `adblock` engine + EasyList — WebKit content
    filters on Linux, a native `WebResourceRequested` handler on Windows (WebView2),
    a native `shouldInterceptRequest` filter on Android, plus an injected
    fetch/XHR/cosmetic tier on Windows/macOS.
  - **HTTPS-Only:** top-level `http://` navigations are upgraded to `https://`
    (localhost exempt), with a warning interstitial when the secure load fails.
  - **Malicious-site blocking (MalwareGuard):** navigations and subresources are
    checked against a bundled URLhaus host blocklist; matches are blocked with a
    warning, with an opt-in session bypass.
- **Anti-fingerprinting:** the content webview presents a stock Chrome User-Agent
  rather than leaking the embedder/runtime identity.
- **Permissions:** site permission requests (geolocation, camera, microphone,
  notifications, pointer-lock) are denied by default and prompted on first use;
  the decision is remembered per origin and is revocable in Settings.
- **Updates:** release builds are published to GitHub Releases with a signed
  `latest.json` update manifest (minisign); the app verifies the signature against
  the public key embedded in `tauri.conf.json` before applying an update.

## Dependencies

JavaScript dependencies are kept current by Dependabot and gated in CI by an
`npm audit` check: high/critical advisories block merge unless explicitly
allowlisted, with justification, in `.audit-allowlist.json`. Rust dependencies are
pinned via `src-tauri/Cargo.lock`.
