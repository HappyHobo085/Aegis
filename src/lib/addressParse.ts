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
