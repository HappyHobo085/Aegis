// src/popover/ShieldPanel.tsx
//
// The ad-block shield popover, rendered on the popover surface.
//
// Everything DECIDED is computed by the chrome and sent as plain data — `allowlisted`,
// `canUnallowHere`, `coveringEntries`, `allowLabel`, whether a Reload button exists. The panel
// decides nothing, because a disabled control that disagrees with the chrome is a control that
// lies, and two derivations of the same rule are two things that can drift. In particular
// `canUnallowHere` encodes the exact-vs-subdomain allowlist asymmetry documented at length in
// `AdblockShield.tsx`; re-deriving it here would be the first step towards re-introducing the
// "checkbox snaps back on" bug that rule exists to prevent.
//
// `protectionRows` is imported, not re-implemented, so the two documents cannot disagree about
// which protection badges exist or what they say.
import { protectionRows } from '../components/AdblockShield';
import type { ProtectionSummary } from '../lib/protectionSummary';
import { reportAction } from './PopoverPanel';
import type { PanelProps } from './PopoverPanel';

const MAX_ENTRIES = 32;

interface ShieldPayload {
  enabled: boolean;
  sessionBlocked: number;
  page: number;
  host: string | null;
  allowlisted: boolean;
  canUnallowHere: boolean;
  coveringEntries: string[];
  allowLabel: string;
  hasReload: boolean;
  protection: ProtectionSummary | null;
}

/** Counts are clamped rather than trusted: they are rendered as text, and a payload carrying
 *  `pageBlocked: 1e21` would print an absurd number instead of failing visibly. */
function count(v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) return 0;
  return Math.min(Math.floor(v), 1_000_000);
}

/**
 * The protection summary, checked FIELD BY FIELD — the same treatment every sibling gets.
 *
 * This was the one unchecked cast in the panel, and it was the one that mattered: the rows
 * `protectionRows` renders are derived from eight fields, so a payload carrying
 * `{ protection: {} }` passes `typeof === 'object'` and produces rows that claim protection
 * the page does not have. These are exactly the badges a user reads to decide whether they are
 * protected, so a malformed value must render NOTHING rather than render something false.
 *
 * `null` is returned for anything non-conforming, and the caller drops the rows entirely —
 * degradation is "no protection list", never "a wrong protection list".
 */
function parseProtection(v: unknown): ProtectionSummary | null {
  if (typeof v !== 'object' || v === null) return null;
  const o = v as Record<string, unknown>;
  for (const flag of [
    'privateMode',
    'httpsOnly',
    'webrtcExempt',
    'fingerprintAllowed',
    'proxyActive',
  ]) {
    if (typeof o[flag] !== 'boolean') return null;
  }
  // `fingerprintLevel` and `webrtcPolicy` are string enums; the exact members are not checked
  // here because `protectionRows` renders whatever the policy string is rather than branching on
  // it, and a new member must not require a change in three places.
  if (typeof o.fingerprintLevel !== 'string' || typeof o.webrtcPolicy !== 'string') return null;
  if (o.proxyUri !== null && typeof o.proxyUri !== 'string') return null;
  return o as unknown as ProtectionSummary;
}

export function ShieldPanel({ shown }: PanelProps): React.JSX.Element | null {
  const p = shown.payload as Record<string, unknown>;
  if (typeof p.enabled !== 'boolean') return null;

  const host = typeof p.host === 'string' ? p.host : null;
  const covering = Array.isArray(p.coveringEntries) ? p.coveringEntries : [];
  if (covering.length > MAX_ENTRIES) return null;
  const coveringEntries = covering.filter((e): e is string => typeof e === 'string');

  const payload: ShieldPayload = {
    enabled: p.enabled,
    sessionBlocked: count(p.sessionBlocked),
    page: count(p.page),
    host,
    allowlisted: p.allowlisted === true,
    canUnallowHere: p.canUnallowHere === true,
    coveringEntries,
    allowLabel: typeof p.allowLabel === 'string' ? p.allowLabel : 'Allow ads on this site',
    hasReload: p.hasReload === true,
    protection: parseProtection(p.protection),
  };
  const rows = payload.protection ? protectionRows(payload.protection) : [];
  const one = payload.coveringEntries.length === 1;

  return (
    <div role="dialog" aria-modal="false" className="adblock-shield__popover">
      <div className="adblock-shield__row">
        <span className="adblock-shield__title">Protection status</span>
        <label className="adblock-shield__switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Ad blocking"
            checked={payload.enabled}
            onChange={() => void reportAction(shown, 'toggle-enabled')}
          />
        </label>
      </div>
      <hr className="adblock-shield__divider" />
      <div className="adblock-shield__reload-row">
        <p className="adblock-shield__hint">Applies on reload.</p>
        {payload.hasReload && (
          <button
            type="button"
            className="adblock-shield__reload"
            onClick={() => void reportAction(shown, 'reload')}
          >
            Reload to apply
          </button>
        )}
      </div>
      {payload.host !== null && (
        <div className="adblock-shield__site">
          <span className="adblock-shield__site-host">{payload.host}</span>
          <span className="adblock-shield__site-meta">
            {payload.allowlisted ? 'Ad blocking allowlisted here' : 'Ad blocking active here'}
          </span>
        </div>
      )}
      <label className="adblock-shield__row adblock-shield__allowlist">
        <input
          type="checkbox"
          aria-label={payload.allowLabel}
          checked={payload.allowlisted}
          disabled={payload.host === null || !payload.canUnallowHere}
          onChange={() => void reportAction(shown, 'toggle-allowlist')}
        />
        <span>{payload.allowLabel}</span>
      </label>
      {!payload.canUnallowHere && (
        <p className="adblock-shield__count">
          Ads are already allowed on {payload.host} because{' '}
          {one ? payload.coveringEntries[0] : payload.coveringEntries.join(' and ')}{' '}
          {one ? 'is' : 'are'} in the allowlist. Remove {one ? 'it' : 'them'} to block ads here
          again.
        </p>
      )}
      <p className="adblock-shield__count">Ads caught here: {payload.page}</p>
      <p className="adblock-shield__count">Ads caught this session: {payload.sessionBlocked}</p>
      <p className="adblock-shield__note">
        Ad requests caught as they load. Requests your content filter stops outright are not in this
        number, so it is a lower bound on Linux.
      </p>
      {rows.length > 0 && (
        <>
          <hr className="adblock-shield__divider" />
          <div className="adblock-shield__protection-list" aria-label="Protection summary">
            {rows.map(({ key, label, value, good, Icon }) => (
              <div key={key} className="adblock-shield__protection-row">
                <span
                  className={`adblock-shield__protection-icon${
                    good ? ' adblock-shield__protection-icon--good' : ''
                  }`}
                  aria-hidden="true"
                >
                  <Icon size={14} />
                </span>
                <span className="adblock-shield__protection-label">{label}</span>
                <span className="adblock-shield__protection-value">{value}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
