// src/components/Toolbar.tsx
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { MoreHorizontal } from 'lucide-react';
import type { AdblockState, NavState } from '../../shared/types';
import type { ProtectionSummary } from '../lib/protectionSummary';
import type { SiteInfo } from './AddressBar';
import { NavControls } from './NavControls';
import { AddressBar } from './AddressBar';
import { AdblockShield } from './AdblockShield';
import { useDialog } from '../hooks/useDialog';

export interface ToolbarAdblockProps {
  state: AdblockState;
  page: number;
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
  onOpenChange?(open: boolean): void;
  /** Reload the active tab (the ad-block on/off + allowlist toggles apply on reload). */
  onReload?(): void;
  protection?: ProtectionSummary;
}

export interface ToolbarProps {
  state: NavState;
  navigate(raw: string): void;
  back(): void;
  forward(): void;
  reloadOrStop(): void;
  home(): void;
  adblock: ToolbarAdblockProps;
  /** Optional toolbar slot for the saved-list bookmark button (Phase 3). */
  bookmark?: ReactNode;
  /** Optional toolbar slot for the Settings gear button (Phase 4). */
  gear?: ReactNode;
  /** Optional toolbar slot for the enter-fullscreen button. */
  fullscreen?: ReactNode;
  /** Optional toolbar slot for the downloads indicator (Phase 5). */
  downloads?: ReactNode;
  /** Optional toolbar slot for the zoom indicator (between gear and menu). */
  zoom?: ReactNode;
  /** Optional right-side toolbar slot for the sidebar toggle (restyle). */
  menu?: ReactNode;
  /** When true (narrow window), the secondary slots fold into an overflow menu so
   *  the address bar keeps a usable width. */
  isNarrow?: boolean;
  isPrivate?: boolean;
  siteInfo?: SiteInfo;
}

/** The "More" overflow popover that holds the secondary toolbar actions when the
 *  window is too narrow to show them all inline. */
function ToolbarOverflow({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useDialog<HTMLDivElement>(() => setOpen(false));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent): void => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [open]);

  return (
    <div className="toolbar-overflow" ref={wrapperRef}>
      <button
        type="button"
        className="toolbar__overflow-trigger"
        aria-label="More tools"
        aria-haspopup="menu"
        aria-expanded={open}
        title="More tools"
        onClick={() => setOpen((v) => !v)}
      >
        <MoreHorizontal size={18} aria-hidden="true" />
      </button>
      {open && (
        <div
          ref={popoverRef}
          role="menu"
          aria-label="More tools"
          className="toolbar-overflow__menu"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export function Toolbar({
  state,
  navigate,
  back,
  forward,
  reloadOrStop,
  home,
  adblock,
  bookmark,
  gear,
  fullscreen,
  downloads,
  zoom,
  menu,
  isNarrow = false,
  isPrivate = false,
  siteInfo,
}: ToolbarProps) {
  const secondary = (
    <>
      <span className="toolbar__cluster toolbar__cluster--page">{bookmark}</span>
      <span className="toolbar__cluster toolbar__cluster--system">{downloads}</span>
      <span className="toolbar__cluster toolbar__cluster--view">
        {fullscreen}
        {gear}
        {zoom}
      </span>
    </>
  );
  return (
    <div className="toolbar">
      <NavControls
        state={state}
        back={back}
        forward={forward}
        reloadOrStop={reloadOrStop}
        home={home}
      />
      <AddressBar
        url={state.url}
        isLoading={state.isLoading}
        isPrivate={isPrivate}
        siteInfo={siteInfo}
        onSubmit={navigate}
      />
      <AdblockShield
        state={adblock.state}
        page={adblock.page}
        host={adblock.host}
        setEnabled={adblock.setEnabled}
        toggleAllowlist={adblock.toggleAllowlist}
        onOpenChange={adblock.onOpenChange}
        onReload={adblock.onReload}
        protection={adblock.protection}
      />
      {isNarrow ? <ToolbarOverflow>{secondary}</ToolbarOverflow> : secondary}
      <span className="toolbar__cluster toolbar__cluster--sidebar">{menu}</span>
    </div>
  );
}
