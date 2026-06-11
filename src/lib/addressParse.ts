// src/lib/addressParse.ts
import { isAllowedNavigationUrl } from '../../electron/lib/schemes';

export type AddressParseResult =
  | { kind: 'navigate'; url: string }
  | { kind: 'reload' }
  | { kind: 'rejected'; reason: string };

function hasScheme(raw: string): boolean {
  // A scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ) ":"
  return /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw);
}

function looksLikeHost(raw: string): boolean {
  return raw.includes('.') && !/\s/.test(raw);
}

export function addressParse(
  raw: string,
  ctx: { currentUrl: string; searchTemplate: string },
): AddressParseResult {
  const trimmed = raw.trim();

  if (trimmed.length > 0 && trimmed === ctx.currentUrl) {
    return { kind: 'reload' };
  }

  if (hasScheme(trimmed)) {
    if (isAllowedNavigationUrl(trimmed)) {
      return { kind: 'navigate', url: trimmed };
    }
    return { kind: 'rejected', reason: `Scheme not allowed: ${trimmed}` };
  }

  if (looksLikeHost(trimmed)) {
    const candidate = `https://${trimmed}`;
    if (isAllowedNavigationUrl(candidate)) {
      return { kind: 'navigate', url: candidate };
    }
    return { kind: 'rejected', reason: `Invalid address: ${trimmed}` };
  }

  return {
    kind: 'navigate',
    url: ctx.searchTemplate.replace('%s', encodeURIComponent(trimmed)),
  };
}

export type NormalizeSavedUrlResult =
  | { ok: true; url: string }
  | { ok: false; reason: string };

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
