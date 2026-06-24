// src/components/SitePermissionsTab.tsx
import type { SitePermission } from '../../shared/types';
import { confirm } from '../lib/toast';

/** Title-case a raw enum value as a sensible fallback (e.g. "midi-sysex" → "Midi Sysex"). */
function titleCase(raw: string): string {
  return raw
    .split(/[-_\s]+/)
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

const PERMISSION_LABELS: Record<string, string> = {
  geolocation: 'Location',
  notifications: 'Notifications',
  camera: 'Camera',
  microphone: 'Microphone',
  media: 'Camera & microphone',
  clipboard: 'Clipboard',
  'clipboard-read': 'Read clipboard',
  'clipboard-write': 'Write clipboard',
  midi: 'MIDI devices',
  'background-sync': 'Background sync',
  'persistent-storage': 'Persistent storage',
};

/** Friendly label for a raw permission name; title-cases unknown values. */
function permissionLabel(permission: string): string {
  return PERMISSION_LABELS[permission] ?? titleCase(permission);
}

const DECISION_LABELS: Record<string, string> = {
  allow: 'Allowed',
  deny: 'Blocked',
  block: 'Blocked',
};

/** Friendly label for a remembered decision; title-cases unknown values. */
function decisionLabel(decision: string): string {
  return DECISION_LABELS[decision] ?? titleCase(decision);
}

export interface SitePermissionsTabProps {
  permissions: SitePermission[];
  remove(origin: string, permission: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export function SitePermissionsTab({ permissions, remove, clear }: SitePermissionsTabProps) {
  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all remembered site permissions?', { destructive: true });
    if (ok) void clear();
  };

  return (
    <div className="site-permissions-tab" role="group" aria-label="Site permissions">
      <div className="site-permissions-tab__actions">
        <button
          type="button"
          aria-label="Clear all site permissions"
          disabled={permissions.length === 0}
          onClick={() => void handleClear()}
        >
          Clear all
        </button>
      </div>
      {permissions.length === 0 ? (
        <p className="site-permissions-tab__empty">No remembered site permissions.</p>
      ) : (
        <ul className="site-permissions-tab__list">
          {permissions.map((p) => (
            <li key={`${p.origin}|${p.permission}`} className="site-permissions-tab__row">
              <span className="site-permissions-tab__origin">{p.origin}</span>
              <span className="site-permissions-tab__permission">
                {permissionLabel(p.permission)}
              </span>
              <span className="site-permissions-tab__decision">{decisionLabel(p.decision)}</span>
              <button
                type="button"
                aria-label={`Revoke ${permissionLabel(p.permission)} for ${p.origin}`}
                onClick={() => void remove(p.origin, p.permission)}
              >
                Revoke
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
