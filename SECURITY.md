# Security Policy

## Supported versions

Aegis ships an auto-update channel (tauri-plugin-updater + GitHub Releases). Only
the **latest released version** receives security updates; older builds are
expected to auto-update to it. There is no long-term-support branch.

| Version        | Supported                  |
| -------------- | -------------------------- |
| Latest release | ✅                         |
| Older releases | ❌ (auto-update to latest) |

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
  grants exactly one permission set, `core:event:default`, because the chrome webview
  uses exactly one gated Tauri API — `listen`. Every renderer→core call goes through the
  app's own `ipc` command, which is not ACL-gated. There is no filesystem, shell, or
  arbitrary-command permission. `withGlobalTauri` is off, so this file is the entire
  surface, and a unit test reads it and fails if any permission is added back.
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

## What the sync server can and cannot see

Aegis can point at a sync server you host yourself (`sync-server/`), or one run by
someone else. If it is not yours, it is a party to your data, and this section
states exactly what it learns. The short version: **the server learns the shape
of your data, never its contents** — but it can still withhold, reorder or stall
it, and it can see your reading habits by timing alone.

### Encrypted end-to-end, and the server cannot forge a record

Every record crossing the wire is an opaque blob authenticated with
XChaCha20-Poly1305 under a key derived from your recovery phrase
(`sync_keystore.rs`). The server stores and relays those blobs; it does not hold
the key. So it cannot read a record, cannot modify one without detection, and
cannot mint a record that passes the client's authentication check. The same
applies to the password vault, which is additionally sealed under a key derived
from your **master password** — so a server operator holding the recovery phrase
still cannot read your credentials.

### What the server does see

- **Identity and topology:** your account id, one device id per device, and which
  devices are currently active. A server learns how many devices you have and
  which ones are in use together.
- **The set of records, and when each changed:** the wire envelope carries a
  `uuid`, a tombstone flag, and a hybrid-logical-clock stamp (`wall_ms`,
  `counter`, `node`) **in the clear** — they are routing and ordering metadata,
  not payload. A server therefore learns how many records you have in each
  namespace, how fast they change, and which were deleted.
- **Which settings you use:** the settings projection is keyed by the setting
  name, so a server sees that you have a `homeUrl` and a `searchEngine` set. It
  does not see their values.
- **Which namespaces you use:** the request path names the namespace
  (`favorites`, `saved`, `allowlist`, settings, custom filters).
- **Metadata of the transport itself:** source IP, request timing and sizes. This
  is the one channel that leaks by inference rather than by content: even a
  server that cannot read a single record can tell how active you are, roughly
  when, and whether two devices are editing at once.

### What the server does NOT see

- **Browsing history** — deliberately not synced (see `sync_stores::SYNCABLE`;
  the synced set is bookmarks, saved items and the ad-block allowlist).
- **Downloads** — device-specific paths, not synced.
- **Your master password, recovery phrase, or vault key** — and so not your
  credentials, even if it holds the recovery phrase.
- **The contents of any record**, including favorite titles and URLs, saved-item
  text, and settings values.
- **The pages you visit.** The proxy settings that would show a server your
  destinations apply to the content webview, not to the sync transport.

### What the server CAN do about you (integrity, not confidentiality)

These are real, and worth understanding before pointing Aegis at a server you do
not control:

- **It can withhold or stall.** It can serve a stale snapshot, drop a record, or
  simply never answer. It cannot forge one, so this shows up as "my change did
  not stick", not as "my change was replaced with something else".
- **It can reorder, and the ordering is not fully authenticated.** The `ord`
  stamp is the one field the server _authors_ rather than relays, so it is the
  one field AEAD does not cover. A hostile server can therefore decide which of
  two records a client considers newer. This is bounded: the client refuses an
  `ord` more than 60 s ahead of its own clock and falls back to the
  authenticated stamp from the record itself, so a server can lose a tie-break
  but cannot permanently pin a record out of reach.
- **It can refuse to serve one device** (per-device request quotas), which is a
  targeted denial of sync for that device alone.
- **It can see deletions but not resurrect them** — a deleted record is a
  tombstone, and a server that drops a tombstone can cause a record to reappear
  from an old device, but cannot forge a new one.

### What is never synced

Two categories, enforced in different places, and the difference matters if you
are auditing:

**Setting keys that are local-only on every device** — `LOCAL_ONLY_KEYS` in
`settings.rs`, checked at all three write/apply points (`record_change`, the
`ensure_sync_projection` migration seed, and `apply_synced`). The rule: a switch
whose flipped state moves data _off_ this machine, or makes it _less_ private,
must not be settable by a peer.

| Setting             | Why it stays local                                                                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `syncAllowInsecure` | Waives HTTPS for the sync transport. Syncing it would let a remote record walk this device onto a plaintext server.                                    |
| `syncVault`         | Opt-in to uploading the password vault. Syncing it would let one device's record start uploading your credentials on every device the account touches. |

**Stores that are local-only**, restored only from an export bundle:
`webrtc-allowlist`, `permissions`, and the per-site `fp-allowlist`.

Two things that _are_ synced and are worth calling out, because a reader will
reasonably assume otherwise:

- **The ad-block allowlist is synced** (bookmarks and saved items are the other
  two synced stores). It therefore follows you across devices, and any device
  holding the account's data key can add a host to it. In an earlier version that
  one entry also switched off **WebRTC IP-leak protection** for the host, on
  every device, with nothing on screen reporting a sync event as the cause. The
  two concerns are now separate: the allowlist still stops ads, and WebRTC
  exemptions live in their own never-synced `webrtc-allowlist` store.
- **`antiFingerprint` (the farble level) is synced**, so it follows you across
  devices like any other setting. It cannot weaken a _sync_ guarantee, so it is
  deliberately not in the local-only list above.

## Dependencies

JavaScript dependencies are kept current by Dependabot and gated in CI by an
`npm audit` check: high/critical advisories block merge unless explicitly
allowlisted, with justification, in `.audit-allowlist.json`. Rust dependencies are
pinned via `src-tauri/Cargo.lock`.
