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
 * True when the typed text is an address rather than a search phrase — i.e. it
 * carries a scheme or is a bare host (`example.com`, `localhost:8080`). Used by
 * the omnibox to decide whether to offer a "Go to …" row above a search row.
 */
export function isUrlLikeInput(raw: string): boolean {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return false;
  return hasScheme(trimmed) || looksLikeHost(trimmed);
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
