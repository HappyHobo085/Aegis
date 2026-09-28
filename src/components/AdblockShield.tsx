// src/components/AdblockShield.tsx
import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { EyeOff, Fingerprint, Lock, Network, Shield, ShieldOff, Video } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { AdblockState } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { useChromePopoverInset } from '../hooks/useChromePopover';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import type { ProtectionSummary } from '../lib/protectionSummary';
import { hostCovered } from '../lib/url';

export interface AdblockShieldProps {
  state: AdblockState;
  page: number;
  /** The current page's hostname, or null when the URL has no parseable host. */
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  /** Notified when the popover opens/closes. The desktop compositor no longer needs
   *  this (the popover registers its own measured inset, see useChromePopover); the
   *  mobile shell still uses it to lower its native content view. */
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
      // The exemption is checked FIRST because it overrides the policy: for an
      // exempt host no shim is injected AND the native backstops are skipped, so
      // the policy that follows is not in force. Reporting the policy here is the
      // "control that lies" case — the badge would show "Public only" in green
      // for exactly the page a script can read local IPs from. Mirrors the
      // fingerprint row's shape ("Allowed here", good: false) for consistency.
      key: 'webrtc',
      label: 'WebRTC IP protection',
      value: protection.webrtcExempt
        ? 'Off here'
        : protection.webrtcPolicy === 'disable'
          ? 'Blocked'
          : protection.webrtcPolicy === 'public-only'
            ? 'Public only'
            : 'Default',
      good: !protection.webrtcExempt && protection.webrtcPolicy !== 'default',
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
  popoverRef,
}: AdblockShieldProps & {
  onClose: () => void;
  wrapperRef: RefObject<HTMLElement | null>;
  popoverRef: RefObject<HTMLDivElement | null>;
}) {
  const labelId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  // Stable: React must not detach the node the inset observer is watching.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      dialogRef.current = el;
      popoverRef.current = el;
    },
    [dialogRef, popoverRef],
  );
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
  // `hostCovered`, not `.includes()`: the core's allowlist scope is exact-OR-subdomain
  // (`adblock::host_covered`), so allowlisting `example.com` exempts `www.example.com`
  // from EVERY blocking tier. An exact test here made this row's checkbox show
  // "not allowlisted" for a subdomain the core is already exempting — the same
  // disagreement the `hostCovered` helper was extracted to end.
  const allowlisted = hostCovered(state.allowlistedHosts, host);
  const allowLabel = host ? `Allow ads on ${host}` : 'Allow ads on this site';

  // Which entries cover THIS host, and does unchecking have any chance of working?
  //
  // The core WRITES the allowlist with EXACT equality: `adblock.toggleAllowlist` picks
  // add-vs-remove with `allowlist_hosts(app).iter().any(|h| h == &host)`, and so do
  // `add_host` / `remove_host`. A host covered only by a PARENT entry — `example.com`
  // covering `www.example.com` — is therefore not itself listed, and unchecking this row
  // used to send `www.example.com`, which the core read as "not listed" and ADDED. The
  // store then held both entries, `hostCovered` was still true, and the checkbox snapped
  // straight back on having done nothing but grow the list — which is SYNCABLE, so the
  // redundant entry spread to every paired device as well.
  //
  // So unchecking can only mean "block ads on this site" when this host is NOT allowlisted,
  // or when its own exact entry is the ONLY thing covering it. Otherwise the request cannot
  // be expressed through this control at all: removing the parent is a different, broader
  // action (it un-allows every other address of that site too), so it is not something to
  // do implicitly behind a checkbox. The control says so instead of silently misfiring.
  const coveringEntries =
    host === null || host === ''
      ? []
      : state.allowlistedHosts.filter((entry) => entry !== '' && hostCovered([entry], host));
  const canUnallowHere =
    !allowlisted || (coveringEntries.length === 1 && coveringEntries[0] === host);

  const rows = protection ? protectionRows(protection) : [];

  return (
    <div
      ref={setRef}
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
          disabled={host === null || !canUnallowHere}
          onChange={() => toggleAllowlist()}
        />
        <span>{allowLabel}</span>
      </label>
      {!canUnallowHere && (
        <p className="adblock-shield__count">
          Ads are already allowed on {host} because{' '}
          {coveringEntries.length === 1 ? coveringEntries[0] : coveringEntries.join(' and ')}{' '}
          {coveringEntries.length === 1 ? 'is' : 'are'} in the allowlist. Remove{' '}
          {coveringEntries.length === 1 ? 'it' : 'them'} to block ads here again.
        </p>
      )}
      <p className="adblock-shield__count">Ads caught here: {page}</p>
      <p className="adblock-shield__count">Ads caught this session: {state.sessionBlocked}</p>
      {/* The count is NOT "requests we stopped", and on Linux it is provably not.
          The counter is fed by a `resource-load-started` signal that only fires for
          requests the capped declarative filter ALLOWED; the vast majority of real
          Linux blocks are filter-cancelled before that signal and never counted, so
          the number is a lower bound there — while on Windows and Android the same
          number IS a count of stopped requests. "Caught" is the one word true for
          all three. See `linux_layout.rs`'s block-counter module doc. */}
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

export function AdblockShield(props: AdblockShieldProps) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  // Self-registering: a popover that renders is a popover that reserves its space,
  // so the content webview can never sit on top of it.
  const [popoverRef, popoverHeight] = useMeasuredHeight<HTMLDivElement>(open);
  useChromePopoverInset('adblock-shield', popoverHeight);
  const changeOpen = (v: boolean) => {
    setOpen(v);
    props.onOpenChange?.(v);
  };

  // Blocking is effectively active for this host only when the global toggle is
  // on AND the host isn't allowlisted.
  //
  // `hostCovered`, not `.includes()` — the SAME correction the popover above already
  // makes, and for the same reason. The core's allowlist scope is exact-OR-subdomain
  // (`adblock::host_covered`, which every blocking tier consults), so allowlisting
  // `example.com` exempts `www.example.com` from blocking entirely. An exact test here
  // reported the opposite in the same render: the core blocked nothing while this button
  // claimed "Ad blocking is active" next to a popover that said the site was allowlisted.
  const allowlisted = hostCovered(props.state.allowlistedHosts, props.host);
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
        aria-label={page > 0 ? `Ad blocking, ${page} ads caught on this page` : 'Ad blocking'}
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
      {open && (
        <Popover
          {...props}
          onClose={() => changeOpen(false)}
          wrapperRef={wrapperRef}
          popoverRef={popoverRef}
        />
      )}
    </div>
  );
}
