// electron/main/permissionsHelpers.ts

/**
 * Pure permission helpers (unit-tested). PHASE5_PERMISSIONS is the meaningful set
 * we prompt for; everything else stays denied (deny-by-default preserved).
 */

export const PHASE5_PERMISSIONS = new Set<string>([
  'geolocation',
  'notifications',
  'media',
  'clipboard-read',
]);

/** The origin (scheme://host[:port]) of a URL, or '' if unparseable. */
export function originOf(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return '';
  }
}

export type PermissionResolution =
  | { decision: 'allow' | 'deny' }
  | { prompt: true }
  | { deny: true };

/**
 * Decide how to answer a permission request given the remembered decision (if any)
 * and whether the permission is in the prompt-eligible set. A remembered decision
 * always wins; otherwise prompt if eligible, else hard-deny.
 */
export function resolvePermission(
  remembered: 'allow' | 'deny' | undefined,
  inSet: boolean,
): PermissionResolution {
  if (remembered) return { decision: remembered };
  if (inSet) return { prompt: true };
  return { deny: true };
}
