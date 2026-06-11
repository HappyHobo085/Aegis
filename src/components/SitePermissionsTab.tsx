// src/components/SitePermissionsTab.tsx
import type { SitePermission } from '../../shared/types';
import { confirm } from '../lib/toast';

export interface SitePermissionsTabProps {
  permissions: SitePermission[];
  remove(origin: string, permission: string): Promise<void> | void;
  clear(): Promise<void> | void;
}

export function SitePermissionsTab({ permissions, remove, clear }: SitePermissionsTabProps) {
  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all remembered site permissions?');
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
            <li
              key={`${p.origin}|${p.permission}`}
              className="site-permissions-tab__row"
            >
              <span className="site-permissions-tab__origin">{p.origin}</span>
              <span className="site-permissions-tab__permission">{p.permission}</span>
              <span className="site-permissions-tab__decision">{p.decision}</span>
              <button
                type="button"
                aria-label={`Revoke ${p.permission} for ${p.origin}`}
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
