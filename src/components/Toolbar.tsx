// src/components/Toolbar.tsx
import type { ReactNode } from 'react';
import type { AdblockState, NavState } from '../../shared/types';
import { NavControls } from './NavControls';
import { AddressBar } from './AddressBar';
import { AdblockShield } from './AdblockShield';

export interface ToolbarAdblockProps {
  state: AdblockState;
  page: number;
  host: string | null;
  setEnabled(enabled: boolean): void;
  toggleAllowlist(): void;
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
  /** Optional toolbar slot for the downloads indicator (Phase 5). */
  downloads?: ReactNode;
  /** Optional right-side toolbar slot for the sidebar toggle (restyle). */
  menu?: ReactNode;
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
  downloads,
  menu,
}: ToolbarProps) {
  return (
    <div className="toolbar">
      <NavControls
        state={state}
        back={back}
        forward={forward}
        reloadOrStop={reloadOrStop}
        home={home}
      />
      <AddressBar url={state.url} onSubmit={navigate} />
      <AdblockShield
        state={adblock.state}
        page={adblock.page}
        host={adblock.host}
        setEnabled={adblock.setEnabled}
        toggleAllowlist={adblock.toggleAllowlist}
      />
      {bookmark}
      {downloads}
      {gear}
      {menu}
    </div>
  );
}
