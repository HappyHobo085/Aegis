// src/components/AdblockShield.tsx
import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { EyeOff, Fingerprint, Lock, Network, Shield, ShieldOff, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdblockState } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import type { ProtectionSummary } from '../lib/protectionSummary';

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
  /** When provided, the popover shows a "Reload to apply" button next to the
   *  "Applies on reload" copy. The coordinator (App) wires this to reload the
   *  active tab so an ad-block change takes effect immediately. Omit to hide it. */
  onReload?(): void;
  protection?: ProtectionSummary;
}

function protectionRows(protection: ProtectionSummary): Array<{
  key: string;
  label: string;
  value: string;
  good: boolean;
  Icon: LucideIcon;
}> {
  return [
    {
      key: 'private',
      label: 'Private tab',
      value: protection.privateMode ? 'On' : 'Off',
      good: protection.privateMode,
      Icon: EyeOff,
    },
    {
      key: 'https',
      label: 'HTTPS upgrades',
      value: protection.httpsOnly ? 'On' : 'Off',
      good: protection.httpsOnly,
      Icon: Lock,
    },
    {
      key: 'webrtc',
      label: 'WebRTC IP protection',
      value:
        protection.webrtcPolicy === 'disable'
          ? 'Blocked'
          : protection.webrtcPolicy === 'public-only'
            ? 'Public only'
            : 'Default',
      good: protection.webrtcPolicy !== 'default',
      Icon: Video,
    },
    {
      key: 'fingerprint',
      label: 'Fingerprint protection',
      value: protection.fingerprintAllowed
        ? 'Allowed here'
        : protection.fingerprintLevel === 'off'
          ? 'Off'
          : protection.fingerprintLevel,
      good: protection.fingerprintLevel !== 'off' && !protection.fingerprintAllowed,
      Icon: Fingerprint,
    },
    {
      key: 'proxy',
      label: 'Proxy',
      value: protection.proxyActive ? (protection.proxyUri ?? 'Active') : 'Off',
      good: protection.proxyActive,
      Icon: Network,
    },
  ];
}

function Popover({
  state,
  page,
  host,
  setEnabled,
  toggleAllowlist,
  onReload,
  protection,
  onClose,
  wrapperRef,
}: AdblockShieldProps & { onClose: () => void; wrapperRef: RefObject<HTMLElement | null> }) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  // Close on an outside click, consistent with ZoomIndicator / ToolbarOverflow (the shield
  // popover previously only closed on Escape / re-click).
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const wrapper = wrapperRef.current;
      if (wrapper && event.target instanceof Node && !wrapper.contains(event.target)) {
        onCloseRef.current();
      }
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [wrapperRef]);
  const allowlisted = host !== null && state.allowlistedHosts.includes(host);
  const allowLabel = host ? `Allow ads on ${host}` : 'Allow ads on this site';

  const rows = protection ? protectionRows(protection) : [];

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
          Protection status
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
      <div className="adblock-shield__reload-row">
        <p className="adblock-shield__hint">Applies on reload.</p>
        {onReload && (
          <button type="button" className="adblock-shield__reload" onClick={() => onReload()}>
            Reload to apply
          </button>
        )}
      </div>
      {host !== null && (
        <div className="adblock-shield__site">
          <span className="adblock-shield__site-host">{host}</span>
          <span className="adblock-shield__site-meta">
            {allowlisted ? 'Ad blocking allowlisted here' : 'Ad blocking active here'}
          </span>
        </div>
      )}
      <label className="adblock-shield__row adblock-shield__allowlist">
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

export function AdblockShield(props: AdblockShieldProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const changeOpen = (v: boolean) => {
    setOpen(v);
    props.onOpenChange?.(v);
  };

  // Blocking is effectively active for this host only when the global toggle is
  // on AND the host isn't allowlisted.
  const allowlisted = props.host !== null && props.state.allowlistedHosts.includes(props.host);
  const blockingActive = props.state.enabled && !allowlisted;
  const ShieldIcon = blockingActive ? Shield : ShieldOff;
  const page = props.page;

  return (
    <div ref={wrapperRef} className="adblock-shield">
      <button
        type="button"
        className={`adblock-shield__button${
          blockingActive ? ' adblock-shield__button--active' : ' adblock-shield__button--inactive'
        }`}
        aria-label={page > 0 ? `Ad blocking, ${page} blocked on this page` : 'Ad blocking'}
        title={blockingActive ? 'Ad blocking is active' : 'Ad blocking is off or allowlisted'}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => changeOpen(!open)}
      >
        <span aria-hidden="true" className="adblock-shield__icon">
          <ShieldIcon size={18} aria-hidden="true" />
        </span>
        {page > 0 && (
          <span aria-hidden="true" className="adblock-shield__badge">
            {page}
          </span>
        )}
      </button>
      {open && <Popover {...props} onClose={() => changeOpen(false)} wrapperRef={wrapperRef} />}
    </div>
  );
}
