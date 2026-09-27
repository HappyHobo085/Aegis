// src/lib/addressParse.ts
import { isAllowedNavigationUrl } from './schemes';

export type AddressParseResult =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload' }
  | { kind: 'rejected'; reason: string }
  /** Nothing to do — e.g. Enter on an empty field. Must NOT become a search. */
  | { kind: 'noop' };

function hasScheme(raw: string): boolean {
  // A scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

function looksLikeHost(raw: string): boolean {
  return raw.includes('.') && !/\s/.test(raw);
}

/**
 * A `host:port` pair, which is a HOST and not a scheme.
 *
 * RFC 3986 allows `.` and digits in a scheme name, so `hasScheme('example.com:8080')`
 * is true and `new URL('example.com:8080')` parses happily with the protocol
 * `example.com:` — which then fails the http(s) allowlist. Without this check,
 * every letter-leading `host:port` the omnibox could be asked to open was
 * rejected with "Aegis can only open web (http and https) addresses", which is
 * plainly false about a plainly-web address. A leading digit dodged the scheme
 * regex by accident and got `https://` prepended instead, which is a second
 * wrong answer rather than a right one.
 *
 * The HOST must look like a host — it contains a dot, or it is literally
 * `localhost`, or it is a bracketed IPv6 literal. That is the same shape test
 * `looksLikeHost` already uses, extended to the two dotless hosts that are real:
 * requiring it is what separates this from a genuine scheme, because
 * `javascript:1`, `data:0` and `tel:911` all have a dotless, all-alphanumeric
 * "host" followed by a valid port number, and must stay refused. A dotless
 * intranet name (`wiki:8443`) is consequently still a SEARCH, which is the
 * pre-existing policy for dotless hosts and not something this should change.
 */
function looksLikeHostPort(raw: string): boolean {
  if (/\s/.test(raw)) return false;
  const colon = raw.lastIndexOf(':');
  if (colon <= 0) return false;
  const port = raw.slice(colon + 1);
  if (!/^\d{1,5}$/.test(port)) return false;
  const n = Number(port);
  if (n < 1 || n > 65535) return false;

  if (raw.startsWith('[')) {
    // A bracketed IPv6 literal, e.g. `[::1]:8080`. Rejected if the bracket is
    // unbalanced or a second `[` appears, so `javascript:[1]` cannot pass.
    const close = raw.indexOf(']');
    if (close <= 1 || close > colon) return false;
    const inner = raw.slice(1, close);
    return inner.includes(':') && !inner.includes('[');
  }

  const host = raw.slice(0, colon);
  // A path, query, fragment, userinfo or bracket in the host part is not a host.
  if (/[/?#@[\]]/.test(host)) return false;
  return host.includes('.') || host.toLowerCase() === 'localhost';
}

/**
 * The scheme to give a schemeless host.
 *
 * Loopback gets `http://`: `localhost`, `127.0.0.0/8` and `::1` are provably
 * this machine, so there is no network path for a cleartext request to leak
 * over, and a local dev server overwhelmingly speaks plain HTTP — prepending
 * `https://` to `localhost:3000` yields a TLS handshake failure, not a page.
 *
 * Everything else gets `https://`, matching the plain dotted-host case: an
 * intranet search-domain name genuinely does cross the network and must not be
 * silently downgraded to cleartext.
 */
function hostSchemeFor(rawHost: string): 'http://' | 'https://' {
  // Callers pass either a bare host (`127.0.0.1`) or a `host:port` string, so
  // the port is stripped before classifying — `localhost:8080` must be judged on
  // `localhost`, not on the whole pair.
  const colon = rawHost.lastIndexOf(':');
  const bracketed = rawHost.startsWith('[');
  const host = bracketed ? rawHost.slice(1, rawHost.indexOf(']')) : rawHost.slice(0, colon);
  if (host.toLowerCase() === 'localhost' || host === '::1') return 'http://';
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return 'http://';
  return 'https://';
}

/**
 * The full URL for a `host:port` input, or `null` if this is not that shape.
 * Shared by `addressParse`, `normalizeSavedUrl` and `isUrlLikeInput` so the
 * three cannot disagree about what counts as an address.
 */
function hostPortUrl(raw: string): string | null {
  return looksLikeHostPort(raw) ? `${hostSchemeFor(raw)}${raw}` : null;
}

/**
 * True when the typed text is an address rather than a search phrase — i.e. it
 * carries a scheme or is a bare host (`example.com`, `localhost:8080`). Used by
 * the omnibox to decide whether to offer a "Go to …" row above a search row.
 */
export function isUrlLikeInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  return hasScheme(trimmed) || looksLikeHost(trimmed) || looksLikeHostPort(trimmed);
}

export function addressParse(
  raw: string,
  ctx: { currentUrl: string; searchTemplate: string },
): AddressParseResult {
  const trimmed = raw.trim();

  if (trimmed.length > 0 && trimmed === ctx.currentUrl) {
    return { kind: 'reload' };
  }

  // BEFORE the scheme test: `example.com:8080` matches the scheme regex, and
  // `new URL` parses it as protocol `example.com:`, so the hasScheme branch
  // below would reject a plainly-web address as a non-web scheme.
  if (hostPortUrl(trimmed) !== null) {
    const candidate = hostPortUrl(trimmed) as string;
    if (isAllowedNavigationUrl(candidate)) {
      return { kind: 'navigate', url: candidate };
    }
    return { kind: 'rejected', reason: 'That doesn’t look like a valid address.' };
  }

  if (hasScheme(trimmed)) {
    if (isAllowedNavigationUrl(trimmed)) {
      return { kind: 'navigate', url: trimmed };
    }
    return { kind: 'rejected', reason: 'Aegis can only open web (http and https) addresses.' };
  }

  if (looksLikeHost(trimmed)) {
    const candidate = `https://${trimmed}`;
    if (isAllowedNavigationUrl(candidate)) {
      return { kind: 'navigate', url: candidate };
    }
    return { kind: 'rejected', reason: 'That doesn’t look like a valid address.' };
  }

  // An empty field must be a no-op, like every real browser — NOT a search for the empty
  // string. Previously this fell through to the search template, so pressing Enter on a
  // blank address bar navigated to `https://duckduckgo.com/?q=`.
  if (trimmed.length === 0) {
    return { kind: 'noop' };
  }

  return {
    kind: 'navigate',
    url: ctx.searchTemplate.replace('%s', encodeURIComponent(trimmed)),
  };
}

export type NormalizeSavedUrlResult = { ok: true; url: string } | { ok: false; reason: string };

/**
 * Normalises free-typed input into a saveable URL. Unlike addressParse, there is
 * no search fallback — a saved entry must be an actual address. A schemeless host
 * gets https:// prepended; anything that doesn't resolve to an allowed http(s)
 * URL is rejected with a human-readable reason.
 */
export function normalizeSavedUrl(raw: string): NormalizeSavedUrlResult {
  const trimmed = raw.trim();

  if (trimmed.length === 0) {
    return { ok: false, reason: 'Enter a URL.' };
  }

  // Same ordering rule as `addressParse`, and for the same reason: see
  // `looksLikeHostPort`. Kept in lockstep deliberately — a typed address that
  // navigates but will not save (or vice versa) is its own kind of confusion.
  if (hostPortUrl(trimmed) !== null) {
    const candidate = hostPortUrl(trimmed) as string;
    if (isAllowedNavigationUrl(candidate)) {
      return { ok: true, url: candidate };
    }
    return { ok: false, reason: 'That doesn’t look like a valid address.' };
  }

  if (hasScheme(trimmed)) {
    if (isAllowedNavigationUrl(trimmed)) {
      return { ok: true, url: trimmed };
    }
    return { ok: false, reason: 'Only http and https addresses can be saved.' };
  }

  if (looksLikeHost(trimmed)) {
    const candidate = `https://${trimmed}`;
    if (isAllowedNavigationUrl(candidate)) {
      return { ok: true, url: candidate };
    }
  }

  return { ok: false, reason: 'Enter a valid URL (e.g. example.com).' };
}
