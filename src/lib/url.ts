/** Returns the hostname of `url`, or null when `url` has no parseable host. */
export function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

/** Returns the origin of `url`, or null when `url` has no parseable origin. */
export function originOf(url: string): string | null {
  try {
    // `URL.origin` is the literal STRING "null" for an opaque origin (about:, data:,
    // file:), not the null value. Returning that string would break the declared
    // `string | null` contract and make every `origin === null` guard in the app a
    // no-op for those URLs (e.g. the redirect re-assert in App.tsx). Normalise it.
    const origin = new URL(url).origin;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
}

/**
 * Whether `host` is covered by one of `allowlist`'s entries: an exact match, or a
 * SUBdomain of one. Mirrors `adblock::host_covered` in src-tauri/src/adblock.rs
 * byte-for-byte in behaviour, and that Rust function is the reason this one exists.
 *
 * The core's copy was written precisely because three renderers had each spelled the
 * rule out separately and drifted: the ad-block engine's was an exact `HashSet` hit
 * with NO subdomain case at all, so allowlisting `example.com` did not exempt
 * `www.example.com` from any tier. A fourth copy then existed in the renderer too —
 * `protectionSummary`'s `fingerprintAllowed`, an exact `.includes()` — and it is
 * what made the privacy badge disagree with the privacy machinery: allowlisting
 * `a.com` switched farbling and the WebRTC shim off for `www.a.com` in the core,
 * while the badge reported the page as fully protected.
 *
 * Two cases the test pins, because a suffix test would pass the subdomain one and
 * fail silently on the second:
 *   - `nota.com` must NOT be covered by an entry of `a.com` (suffix, not substring)
 *   - `example.com.evil.test` must NOT be covered by an entry of `example.com`
 *     (the entry is only a PREFIX of the host)
 * A `null` host (about:blank, an unparseable URL) is never covered, which must stay
 * an explicit `host !== null` test rather than a truthiness test: `""` is itself a
 * real allowlist-able value, so a falsy check would conflate "no host" with "".
 */
export function hostCovered(allowlist: readonly string[], host: string | null): boolean {
  if (host === null || host === '') return false;
  return allowlist.some((entry) => {
    if (entry.length === 0) return false;
    if (host === entry) return true;
    // A subdomain needs a DOT before the entry, or `a.com` would cover `nota.com`.
    return (
      host.length > entry.length + 1 &&
      host.endsWith(entry) &&
      host[host.length - entry.length - 1] === '.'
    );
  });
}
