import type { ReactNode } from 'react';
import { RotateCw, X, ChevronUp, ChevronDown } from 'lucide-react';
import { AddressBar } from '../AddressBar';
import type { OmniboxStores, SiteInfo } from '../AddressBar';

interface MobileTopBarProps {
  url: string;
  isLoading: boolean;
  isPrivate?: boolean;
  siteInfo?: SiteInfo;
  /** Shield icon rendered inline inside the address bar pill (right edge). */
  inlineShield?: ReactNode;
  /** Stores for the address-bar suggestion list. */
  omnibox?: OmniboxStores;
  /** Reported when a chrome overlay anchored to the address bar opens/closes; the
   *  mobile shell lowers its native content view for it (see MobileApp). */
  onDropdownOpenChange?(open: boolean): void;
  onNavigate(raw: string): void;
  onReloadOrStop(): void;
  bottomBarHidden: boolean;
  onToggleBottomBar(): void;
}

export function MobileTopBar({
  url,
  isLoading,
  isPrivate = false,
  siteInfo,
  inlineShield,
  omnibox,
  onDropdownOpenChange,
  onNavigate,
  onReloadOrStop,
  bottomBarHidden,
  onToggleBottomBar,
}: MobileTopBarProps) {
  return (
    <div className="mobile-topbar">
      <div className="mobile-topbar__row">
        <AddressBar
          url={url}
          isLoading={isLoading}
          isPrivate={isPrivate}
          siteInfo={siteInfo}
          inlineRight={inlineShield}
          omnibox={omnibox}
          onDropdownOpenChange={onDropdownOpenChange}
          onSubmit={onNavigate}
        />
        <button
          type="button"
          className="mobile-topbar__reload"
          aria-label={isLoading ? 'Stop' : 'Reload'}
          onClick={onReloadOrStop}
        >
          {isLoading ? (
            <X size={20} aria-hidden="true" />
          ) : (
            <RotateCw size={20} aria-hidden="true" />
          )}
        </button>
        <button
          type="button"
          className="mobile-topbar__toggle"
          aria-label={bottomBarHidden ? 'Show toolbar' : 'Hide toolbar'}
          aria-pressed={bottomBarHidden}
          onClick={onToggleBottomBar}
        >
          {bottomBarHidden ? (
            <ChevronUp size={20} aria-hidden="true" />
          ) : (
            <ChevronDown size={20} aria-hidden="true" />
          )}
        </button>
      </div>
    </div>
  );
}
