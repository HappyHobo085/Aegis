// electron/lib/schemes.ts
import { ALLOWED_NAV_SCHEMES } from '../../shared/types';

/**
 * Dependency-free navigation scheme allowlist, imported by both the main process
 * and the renderer. Returns true for https:, http:, and exactly 'about:blank';
 * false for file:, javascript:, data:, chrome:, other schemes, and invalid input.
 *
 * The URL constructor normalises the scheme to lowercase, so mixed-case variants
 * like 'HTTPS://' pass and 'JavaScript:' is still rejected — no special casing
 * required on our side.
 *
 * `about:blank` is handled before URL parsing because the URL constructor does
 * not parse bare `about:` URLs consistently across environments.
 */
export function isAllowedNavigationUrl(url: string): boolean {
  if (url === 'about:blank') return true;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return (ALLOWED_NAV_SCHEMES as readonly string[]).includes(parsed.protocol);
}
