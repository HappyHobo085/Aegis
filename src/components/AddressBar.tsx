// src/components/AddressBar.tsx
import { EyeOff, Lock, Search, ShieldAlert, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { SitePermission } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';
import { useDialog } from '../hooks/useDialog';

export interface AddressBarProps {
  url: string;
  isLoading?: boolean;
  isPrivate?: boolean;
  siteInfo?: SiteInfo;
  onSubmit(raw: string): void;
}

export interface SiteInfo {
  origin: string | null;
  host: string | null;
  permissions: SitePermission[];
  protection: ProtectionSummary;
  onForgetSitePermissions(origin: string): void;
  onClearRememberedSiteData(origin: string): void;
  onOpenPrivacySettings(): void;
}

// The blank home page has no meaningful URL to show — present an empty address
// bar (just the placeholder) so the first tap-and-type starts a clean query.
const display = (u: string) => (u === 'about:blank' ? '' : u);

function urlStatus(url: string): { label: string; tone: 'secure' | 'warning' | 'search' } {
  if (url === 'about:blank' || url.trim().length === 0) return { label: 'Search', tone: 'search' };
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'https:') return { label: 'Secure', tone: 'secure' };
    if (parsed.protocol === 'http:') return { label: 'Not secure', tone: 'warning' };
  } catch {
    return { label: 'Search', tone: 'search' };
  }
  return { label: 'Page', tone: 'search' };
}

function SiteIdentityPopover({ info, onClose }: { info: SiteInfo; onClose(): void }) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  const originPermissions = info.origin
    ? info.permissions.filter((p) => p.origin === info.origin)
    : [];
  const canForget = info.origin !== null && originPermissions.length > 0;

  return (
    <div ref={dialogRef} role="dialog" aria-label="Site information" className="site-identity">
      <div className="site-identity__header">
        <strong>{info.host ?? 'This page'}</strong>
        <span>{info.origin ?? 'No web origin'}</span>
      </div>
      <div className="site-identity__rows">
        <div className="site-identity__row">
          <span>Connection</span>
          <strong>{info.protection.httpsOnly ? 'HTTPS upgrades on' : 'Default handling'}</strong>
        </div>
        <div className="site-identity__row">
          <span>Private tab</span>
          <strong>{info.protection.privateMode ? 'On' : 'Off'}</strong>
        </div>
        <div className="site-identity__row">
          <span>Site permissions</span>
          <strong>
            {originPermissions.length === 0 ? 'None remembered' : originPermissions.length}
          </strong>
        </div>
        <div className="site-identity__row">
          <span>Site data</span>
          <strong>
            {info.protection.privateMode ? 'Cleared on close' : 'Aegis data clearable'}
          </strong>
        </div>
      </div>
      {originPermissions.length > 0 && (
        <ul className="site-identity__permissions" aria-label="Remembered permissions">
          {originPermissions.map((permission) => (
            <li key={`${permission.origin}:${permission.permission}`}>
              <span>{permission.permission}</span>
              <strong>{permission.decision}</strong>
            </li>
          ))}
        </ul>
      )}
      <div className="site-identity__actions">
        <button
          type="button"
          disabled={info.origin === null}
          onClick={() => {
            if (info.origin) info.onClearRememberedSiteData(info.origin);
          }}
        >
          <Trash2 size={14} aria-hidden="true" />
          Clear remembered data
        </button>
        <button
          type="button"
          disabled={!canForget || info.origin === null}
          onClick={() => {
            if (info.origin) info.onForgetSitePermissions(info.origin);
          }}
        >
          Forget permissions
        </button>
        <button type="button" onClick={info.onOpenPrivacySettings}>
          Privacy settings
        </button>
      </div>
    </div>
  );
}

export function AddressBar({
  url,
  isLoading = false,
  isPrivate = false,
  siteInfo,
  onSubmit,
}: AddressBarProps) {
  const [value, setValue] = useState(display(url));
  const [siteOpen, setSiteOpen] = useState(false);
  // While the user is typing, a background nav event (page self-redirect, SPA URL change)
  // must NOT clobber their in-progress text. Guard the sync on focus; on blur, revert any
  // unsubmitted edit to the live URL (real-browser behavior).
  const focusedRef = useRef(false);
  const urlRef = useRef(url);
  urlRef.current = url;

  useEffect(() => {
    if (!focusedRef.current) setValue(display(url));
  }, [url]);

  const status = urlStatus(url);
  const StatusIcon =
    status.tone === 'secure' ? Lock : status.tone === 'warning' ? ShieldAlert : Search;

  return (
    <form
      className="address-bar"
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit(value);
      }}
    >
      <div className={`address-bar__field address-bar__field--${status.tone}`}>
        <span className="address-bar__identity-wrap">
          {siteInfo ? (
            <button
              type="button"
              className="address-bar__status address-bar__status-button"
              title={`${status.label}. Open site information`}
              aria-label={`${status.label}. Open site information`}
              aria-haspopup="dialog"
              aria-expanded={siteOpen}
              onClick={() => setSiteOpen((v) => !v)}
            >
              <StatusIcon size={14} />
              <span className="address-bar__status-label">{status.label}</span>
            </button>
          ) : (
            <span className="address-bar__status" title={status.label} aria-hidden="true">
              <StatusIcon size={14} />
              <span className="address-bar__status-label">{status.label}</span>
            </span>
          )}
          {siteOpen && siteInfo && (
            <SiteIdentityPopover info={siteInfo} onClose={() => setSiteOpen(false)} />
          )}
        </span>
        {isPrivate && (
          <span className="address-bar__private" title="Private tab">
            <EyeOff size={13} aria-hidden="true" />
            <span>Private</span>
          </span>
        )}
        <input
          type="text"
          aria-label="Address"
          placeholder="Search or enter a website"
          value={value}
          spellCheck={false}
          autoComplete="off"
          // Select all on focus, like a real browser address bar, so tapping it and
          // typing replaces the URL instead of appending (critical on touch, where
          // there's no Ctrl+A).
          onFocus={(e) => {
            focusedRef.current = true;
            e.currentTarget.select();
          }}
          onBlur={() => {
            focusedRef.current = false;
            setValue(display(urlRef.current));
          }}
          onChange={(e) => setValue(e.target.value)}
        />
        <span className="address-bar__hint" aria-hidden="true">
          Enter
        </span>
        {isLoading && <span className="address-bar__progress" aria-hidden="true" />}
      </div>
    </form>
  );
}
