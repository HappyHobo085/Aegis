# Security Policy

## Supported versions

Aegis ships an auto-update channel (electron-updater + GitHub Releases). Only the
**latest released version** receives security updates; older builds are expected
to auto-update to it. There is no long-term-support branch.

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

Aegis is an Electron application configured for browsing untrusted web content:

- **Process isolation:** web content runs sandboxed with `contextIsolation` on and
  `nodeIntegration` off; the chrome to main IPC surface is sender-guarded.
- **Patch cadence:** Electron is exact-pinned and tracked against upstream stable.
  CI fails when it falls outside Electron's 3-major security-support window (see
  `docs/superpowers/engine-update-policy.md`), and releases ship over the
  SHA512-verified auto-update feed.
- **Tamper resistance:** packaged builds flip Electron fuses
  (RunAsNode / NODE_OPTIONS / inspect off, load-app-from-asar only, cookie
  encryption) and enable ASAR integrity where the platform supports it.
- **Network protections:** built-in ad/tracker blocking via the Ghostery engine.
  (Additional network hardening — HTTPS-Only and malicious-site blocking — is on
  the roadmap.)

## Dependencies

Dependencies are kept current by Dependabot and gated in CI by an `npm audit`
check: high/critical advisories block merge unless explicitly allowlisted, with
justification, in `.audit-allowlist.json`.
