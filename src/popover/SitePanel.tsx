// src/popover/SitePanel.tsx
//
// The site-information panel, rendered on the popover surface.
//
// This is a MIRROR. The chrome's own `.site-identity` stays mounted — hidden with `opacity: 0`
// rather than unmounted — because `useDialog`'s focus trap and its two action buttons have to
// live in a document the keyboard can reach (the surface is `aria-hidden`, and focus cannot
// cross a webview boundary at all). The cost of that choice is recorded in the Phase-4 ledger:
// keyboard activation works, but there is no visible focus ring.
//
// So this panel renders the same information and nothing else. It never acts: a button press
// reports an action NAME and the chrome runs its own handler against its own origin.
import { Trash2 } from 'lucide-react';
import { parseSitePayload } from './sitePayload';
import { reportAction } from './PopoverPanel';
import type { PanelProps } from './PopoverPanel';

export function SitePanel({ shown }: PanelProps): React.JSX.Element | null {
  const site = parseSitePayload(shown.payload);
  if (!site) return null;
  return (
    <div role="dialog" aria-label="Site information" className="site-identity">
      <div className="site-identity__header">
        <strong>{site.host ?? 'This page'}</strong>
        <span>{site.origin ?? 'No web origin'}</span>
      </div>
      <div className="site-identity__rows">
        <div className="site-identity__row">
          <span>Connection</span>
          <strong>{site.httpsOnly ? 'HTTPS upgrades on' : 'Default handling'}</strong>
        </div>
        <div className="site-identity__row">
          <span>Private tab</span>
          <strong>{site.privateMode ? 'On' : 'Off'}</strong>
        </div>
        <div className="site-identity__row">
          <span>Site permissions</span>
          <strong>
            {site.permissions.length === 0 ? 'None remembered' : site.permissions.length}
          </strong>
        </div>
        <div className="site-identity__row">
          <span>Site data</span>
          <strong>{site.privateMode ? 'Cleared on close' : 'Aegis data clearable'}</strong>
        </div>
      </div>
      {site.permissions.length > 0 && (
        <ul className="site-identity__permissions" aria-label="Remembered permissions">
          {site.permissions.map((permission) => (
            <li key={permission.permission}>
              <span>{permission.permission}</span>
              <strong>{permission.decision}</strong>
            </li>
          ))}
        </ul>
      )}
      <div className="site-identity__actions">
        <button
          type="button"
          disabled={!site.canClear}
          onClick={() => void reportAction(shown, 'clear-data')}
        >
          <Trash2 size={14} aria-hidden="true" />
          Clear remembered data
        </button>
        <button
          type="button"
          disabled={!site.canForget}
          onClick={() => void reportAction(shown, 'forget-permissions')}
        >
          Forget permissions
        </button>
        <button type="button" onClick={() => void reportAction(shown, 'privacy-settings')}>
          Privacy settings
        </button>
      </div>
    </div>
  );
}
