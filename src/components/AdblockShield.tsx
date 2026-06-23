// src/components/AdblockShield.tsx
import { useId, useState } from 'react';
import { Shield, ShieldOff } from 'lucide-react';
import type { AdblockState } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';

export interface AdblockShieldProps {
  state: AdblockState;
  page: number;
  /** The current page's hostname, or null when the URL has no parseable host. */
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  /** Notified when the popover opens/closes, so the app can raise the chrome above
   *  the opaque, always-on-top content webview on Tauri (else the popover renders
   *  behind the page). No-op on Electron's transparent-chrome architecture. */
  onOpenChange?(open: boolean): void;
}

function Popover({
  state,
  page,
  host,
  setEnabled,
  toggleAllowlist,
  onClose,
}: AdblockShieldProps & { onClose: () => void }) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const allowlisted = host !== null && state.allowlistedHosts.includes(host);
  const allowLabel = host ? `Allow ads on ${host}` : 'Allow ads on this site';

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelId}
      className="adblock-shield__popover"
    >
      <div className="adblock-shield__row">
        <span id={labelId} className="adblock-shield__title">
          Ad blocking
        </span>
        <label className="adblock-shield__switch">
          <input
            type="checkbox"
            role="switch"
            aria-label="Ad blocking"
            checked={state.enabled}
            onChange={() => setEnabled(!state.enabled)}
          />
        </label>
      </div>
      <hr className="adblock-shield__divider" />
      <label className="adblock-shield__row">
        <input
          type="checkbox"
          aria-label={allowLabel}
          checked={allowlisted}
          disabled={host === null}
          onChange={() => toggleAllowlist()}
        />
        <span>{allowLabel}</span>
      </label>
      <p className="adblock-shield__count">Blocked here: {page}</p>
      <p className="adblock-shield__count">Blocked this session: {state.sessionBlocked}</p>
      <p className="adblock-shield__hint">Applies on reload.</p>
    </div>
  );
}

export function AdblockShield(props: AdblockShieldProps) {
  const [open, setOpen] = useState(false);
  const changeOpen = (v: boolean) => {
    setOpen(v);
    props.onOpenChange?.(v);
  };

  // Blocking is effectively active for this host only when the global toggle is
  // on AND the host isn't allowlisted.
  const allowlisted = props.host !== null && props.state.allowlistedHosts.includes(props.host);
  const blockingActive = props.state.enabled && !allowlisted;
  const ShieldIcon = blockingActive ? Shield : ShieldOff;

  return (
    <div className="adblock-shield">
      <button
        type="button"
        className="adblock-shield__button"
        aria-label="Ad blocking"
        title="Ad blocking"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => changeOpen(!open)}
      >
        <span aria-hidden="true" className="adblock-shield__icon">
          <ShieldIcon size={18} aria-hidden="true" />
        </span>
        <span className="adblock-shield__badge">{props.page}</span>
      </button>
      {open && <Popover {...props} onClose={() => changeOpen(false)} />}
    </div>
  );
}
