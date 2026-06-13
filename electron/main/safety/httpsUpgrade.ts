// electron/main/safety/httpsUpgrade.ts
// Pure HTTPS-Only decision for a top-level navigation URL. No I/O — callers
// supply the `httpsOnly` setting and a per-host exception predicate. Returns the
// upgraded https URL when an upgrade applies, otherwise null (load as-is).
// Only plain `http:` is upgraded; scheme is the only thing changed (path, query,
// hash, and any non-default port are preserved).

/**
 * Normalise a host for consistent comparison/persistence: strip a single
 * trailing FQDN dot (`example.com.` and `example.com` are the same host). Shared
 * by upgradeUrl and SafetyController.proceed so the upgrade decision and the
 * persisted exception key never drift apart.
 */
export function normalizeHost(host: string): string {
  return host.endsWith('.') ? host.slice(0, -1) : host;
}

export function upgradeUrl(
  rawUrl: string,
  opts: { httpsOnly: boolean; isException: (host: string) => boolean },
): string | null {
  if (!opts.httpsOnly) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // Normalise so the exception predicate and the upgraded URL are consistent.
  u.hostname = normalizeHost(u.hostname);
  if (u.protocol !== 'http:') return null;
  if (opts.isException(u.hostname)) return null;
  u.protocol = 'https:';
  return u.toString();
}
