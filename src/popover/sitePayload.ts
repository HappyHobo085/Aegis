// src/popover/sitePayload.ts
//
// Validate the site-information payload the surface received.
//
// The chrome is the only thing that knows the current origin, so the surface is told what to
// display — including whether each action is AVAILABLE. Sending `canClear`/`canForget` rather
// than letting the panel derive them from `origin`/`permissions` is deliberate: a disabled
// button that disagrees with the chrome is a control that lies, and two derivations of the
// same rule are two things that can drift. The chrome's copy stays mounted (hidden) and is the
// one a keyboard user actually operates, so the two must never disagree.
//
// What the surface is NOT given is any callback. It reports `{ action }` and the chrome runs
// its own handler against its own `info.origin` — see spec §7.1.
const MAX_PERMISSIONS = 32;

export interface SitePanelPermission {
  permission: string;
  decision: string;
}

export interface SitePanelPayload {
  host: string | null;
  origin: string | null;
  httpsOnly: boolean;
  privateMode: boolean;
  permissions: SitePanelPermission[];
  canClear: boolean;
  canForget: boolean;
}

function str(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

export function parseSitePayload(payload: unknown): SitePanelPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const p = payload as Record<string, unknown>;

  // `host` and `origin` are genuinely nullable — the blank home page has neither — so `null` is
  // a real answer and anything non-string is a malformed payload.
  if (p.host !== null && typeof p.host !== 'string') return null;
  if (p.origin !== null && typeof p.origin !== 'string') return null;
  if (typeof p.httpsOnly !== 'boolean' || typeof p.privateMode !== 'boolean') return null;
  if (typeof p.canClear !== 'boolean' || typeof p.canForget !== 'boolean') return null;

  const raw = Array.isArray(p.permissions) ? p.permissions : [];
  if (raw.length > MAX_PERMISSIONS) return null;
  const permissions: SitePanelPermission[] = [];
  for (const row of raw) {
    if (typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (typeof r.permission !== 'string' || typeof r.decision !== 'string') continue;
    permissions.push({ permission: r.permission, decision: r.decision });
  }

  return {
    host: str(p.host),
    origin: str(p.origin),
    httpsOnly: p.httpsOnly,
    privateMode: p.privateMode,
    permissions,
    canClear: p.canClear,
    canForget: p.canForget,
  };
}
