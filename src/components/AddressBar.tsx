// src/components/AddressBar.tsx
import { EyeOff, Lock, Search, ShieldAlert, Trash2 } from 'lucide-react';
import {
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from 'react';
import type { Favorite, SavedItem, SitePermission } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';
import type { OmniboxSuggestion } from '../lib/omnibox';
import { useDialog } from '../hooks/useDialog';
import { useOmnibox } from '../hooks/useOmnibox';
import { useChromePopoverInset } from '../hooks/useChromePopover';
import { useMeasuredHeight } from '../hooks/useMeasuredHeight';
import { OmniboxDropdown } from './OmniboxDropdown';

/** The stores the suggestion list ranks against. */
export interface OmniboxStores {
  favorites: Favorite[];
  saved: SavedItem[];
  /** The active search template (`…?q=%s`) for the "Search for …" row. */
  searchTemplate: string;
}

export interface AddressBarProps {
  url: string;
  isLoading?: boolean;
  isPrivate?: boolean;
  siteInfo?: SiteInfo;
  /** Optional element rendered inside the address bar pill, right-aligned
   *  (e.g. the ad-block shield icon on mobile). */
  inlineRight?: ReactNode;
  /** Enables the suggestion list. Omit to render a plain address field (the
   *  hook still runs, with empty stores, so behavior is identical either way). */
  omnibox?: OmniboxStores;
  /** Notified whenever a chrome overlay anchored to the address bar opens or
   *  closes — the suggestion list or the site-information popover.
   *
   *  Desktop needs nothing: the popovers self-register their height with
   *  `useChromePopoverInset`, and the compositor insets the content webview.
   *  The mobile shell IS the callback consumer: it is a single webview, so its
   *  native content view is lowered with `view.setChromeOverlay` instead. */
  onDropdownOpenChange?(open: boolean): void;
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

// Module-level empties so the omnibox hook's effect deps stay referentially
// stable when the caller passes no stores (and across re-renders of a caller
// that builds its stores object inline).
const NO_FAVORITES: Favorite[] = [];
const NO_SAVED: SavedItem[] = [];

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

function SiteIdentityPopover({
  info,
  onClose,
  heightRef,
  anchorRef,
}: {
  info: SiteInfo;
  onClose(): void;
  /** The parent's height probe — the popover's own element is the thing to measure. */
  heightRef: RefObject<HTMLDivElement | null>;
  /** The status (padlock) button that toggles this popover — treated as "inside". */
  anchorRef: RefObject<HTMLElement | null>;
}) {
  const dialogRef = useDialog<HTMLDivElement>(onClose);
  // One element, two owners: useDialog's focus/Escape wiring and the content
  // inset probe. A stable callback ref (not a closure rebuilt each render) so React
  // never detaches the node the observer is watching.
  const setRef = useCallback(
    (el: HTMLDivElement | null) => {
      dialogRef.current = el;
      heightRef.current = el;
    },
    [dialogRef, heightRef],
  );
  // Close on an outside click, consistent with AdblockShield / ZoomIndicator /
  // ToolbarOverflow. Without this the popover was dismissable ONLY by re-clicking the
  // padlock: useDialog's Escape listener is bound to the popover subtree, so once the
  // user moved focus to the address field, neither Escape nor an outside click closed
  // it — the field looked dead because the omnibox was suppressed behind it.
  // The anchor is excluded so pointerdown-then-click on the padlock still toggles.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const handlePointerDown = (event: PointerEvent): void => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      const inside =
        (dialogRef.current?.contains(target) ?? false) ||
        (anchorRef.current?.contains(target) ?? false);
      if (!inside) onCloseRef.current();
    };
    document.addEventListener('pointerdown', handlePointerDown);
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown);
    };
  }, [dialogRef, anchorRef]);
  const originPermissions = info.origin
    ? info.permissions.filter((p) => p.origin === info.origin)
    : [];
  const canForget = info.origin !== null && originPermissions.length > 0;

  return (
    <div ref={setRef} role="dialog" aria-label="Site information" className="site-identity">
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
  inlineRight,
  omnibox,
  onDropdownOpenChange,
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

  // The input is the combobox; the dropdown is its popup listbox. `dismissed`
  // (Escape / blur) is separate from `focused` so the list can close while the
  // field keeps focus, and re-open on the next keystroke.
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  // useId keeps `aria-controls`/`aria-activedescendant` unique when more than one
  // address bar is mounted. React 19 already returns an id free of CSS-hostile
  // characters (`_r_<n>_`), so no sanitising replace is needed.
  const idPrefix = `aegis-address${useId()}`;

  const omni = useOmnibox({
    query: value,
    // The omnibox is suppressed while the site-information popover is open because
    // both hang from the same anchor. Closing the popover on focus is the recovery
    // path — see the pointerdown listener below — so a stale `open` popover can
    // never strand the field with no suggestions and no Escape (useDialog's
    // keydown listener only fires while focus is inside the popover subtree).
    active: focused,
    favorites: omnibox?.favorites ?? NO_FAVORITES,
    saved: omnibox?.saved ?? NO_SAVED,
    searchTemplate: omnibox?.searchTemplate ?? '',
    dismissed,
  });

  const [omniRef, omniHeight] = useMeasuredHeight<HTMLDivElement>(omni.open);
  const [siteRef, siteHeight] = useMeasuredHeight<HTMLDivElement>(siteOpen);
  // The padlock that toggles the site-information popover. The popover's outside-click
  // closer treats it as "inside" so clicking it toggles instead of close-then-open.
  const statusButtonRef = useRef<HTMLButtonElement>(null);
  useChromePopoverInset('address-omnibox', omniHeight);
  useChromePopoverInset('address-site', siteHeight);

  const anyOverlayOpen = omni.open || siteOpen;
  useEffect(() => {
    onDropdownOpenChange?.(anyOverlayOpen);
  }, [anyOverlayOpen, onDropdownOpenChange]);

  useEffect(() => {
    if (!focusedRef.current) setValue(display(url));
  }, [url]);

  const pick = (suggestion: OmniboxSuggestion): void => {
    // Show the resolved destination in the field (a search row turns a phrase
    // into a URL, which is what actually loaded) and close the list. Focus stays
    // put — the next keystroke re-opens, like a real browser.
    setValue(suggestion.target);
    setDismissed(true);
    onSubmit(suggestion.target);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (!omni.open) return; // let every other handler see the key (dialogs, shortcuts)
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault(); // otherwise the caret jumps to the end of the text
      omni.moveActive(e.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (e.key === 'Enter' && omni.activeIndex >= 0) {
      e.preventDefault(); // an active row wins over the plain form submit
      const active = omni.suggestions[omni.activeIndex];
      if (active) pick(active);
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault(); // close the list, keep the text and the focus
      setDismissed(true);
    }
  };

  const status = urlStatus(url);
  const StatusIcon =
    status.tone === 'secure' ? Lock : status.tone === 'warning' ? ShieldAlert : Search;
  // On a blank/typed page the chip would read "Search" right next to the
  // "Search or enter a website" placeholder — the same word twice, with an icon
  // between them. The label only earns its width once it carries real
  // information ("Secure" / "Not secure"), so it is dropped for the search tone
  // and the magnifier carries the meaning on its own.
  const showStatusLabel = status.tone !== 'search';
  // The "Enter" hint is a keyboard affordance, so it only appears while the
  // field is actually being typed into. Sitting there permanently it was
  // 1000px of dead chrome from the caret.
  const showHint = focused && !omni.open;

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
              ref={statusButtonRef}
              className="address-bar__status address-bar__status-button"
              title={`${status.label}. Open site information`}
              aria-label={`${status.label}. Open site information`}
              aria-haspopup="dialog"
              aria-expanded={siteOpen}
              onClick={() => setSiteOpen((v) => !v)}
            >
              <StatusIcon size={14} />
              {showStatusLabel && <span className="address-bar__status-label">{status.label}</span>}
            </button>
          ) : (
            <span
              className="address-bar__status"
              title={status.label}
              // With the label hidden the icon is the only thing a screen reader
              // could announce, and "Search" alone adds nothing to the field's own
              // name — so the decorative span stays out of the tree entirely.
              aria-hidden={showStatusLabel ? true : undefined}
            >
              <StatusIcon size={14} />
              {showStatusLabel && <span className="address-bar__status-label">{status.label}</span>}
            </span>
          )}
          {siteOpen && siteInfo && (
            <SiteIdentityPopover
              info={siteInfo}
              onClose={() => setSiteOpen(false)}
              heightRef={siteRef}
              anchorRef={statusButtonRef}
            />
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
          role="combobox"
          aria-label="Address"
          aria-autocomplete="list"
          aria-expanded={omni.open}
          aria-controls={omni.open ? `${idPrefix}-list` : undefined}
          aria-activedescendant={
            omni.open && omni.activeIndex >= 0 ? `${idPrefix}-opt-${omni.activeIndex}` : undefined
          }
          placeholder="Search or enter a website"
          value={value}
          spellCheck={false}
          autoComplete="off"
          // Select all on focus, like a real browser address bar, so tapping it and
          // typing replaces the URL instead of appending (critical on touch, where
          // there's no Ctrl+A).
          onFocus={(e) => {
            focusedRef.current = true;
            setFocused(true);
            setDismissed(false);
            e.currentTarget.select();
          }}
          onBlur={() => {
            focusedRef.current = false;
            setFocused(false);
            setDismissed(true);
            setValue(display(urlRef.current));
          }}
          onChange={(e) => {
            setValue(e.target.value);
            setDismissed(false);
          }}
          onKeyDown={onKeyDown}
        />
        {inlineRight && <span className="address-bar__inline-right">{inlineRight}</span>}
        {showHint && (
          <span className="address-bar__hint" aria-hidden="true">
            Enter
          </span>
        )}
        {isLoading && <span className="address-bar__progress" aria-hidden="true" />}
        {omni.open && (
          <OmniboxDropdown
            ref={omniRef}
            suggestions={omni.suggestions}
            activeIndex={omni.activeIndex}
            idPrefix={idPrefix}
            onPick={pick}
            onHover={omni.setActiveIndex}
          />
        )}
      </div>
    </form>
  );
}
