import type { ReactNode } from 'react';
import { Bookmark, History, Layers, Menu } from 'lucide-react';

interface MobileBottomBarProps {
  onSaved(): void;
  onHistory(): void;
  onTabs(): void;
  tabCount: number;
  shield: ReactNode;
  onMenu(): void;
}

export function MobileBottomBar({
  onSaved,
  onHistory,
  onTabs,
  tabCount,
  shield,
  onMenu,
}: MobileBottomBarProps) {
  return (
    <nav className="mobile-bottombar" aria-label="Browser actions">
      <button type="button" className="mobile-bottombar__btn" aria-label="Saved" onClick={onSaved}>
        <Bookmark size={22} aria-hidden="true" />
        <span className="mobile-bottombar__label">Saved</span>
      </button>
      <button
        type="button"
        className="mobile-bottombar__btn"
        aria-label="History"
        onClick={onHistory}
      >
        <History size={22} aria-hidden="true" />
        <span className="mobile-bottombar__label">History</span>
      </button>
      <button
        type="button"
        className="mobile-bottombar__btn mobile-bottombar__tabs"
        aria-label={`Tabs (${tabCount} open)`}
        onClick={onTabs}
      >
        <Layers size={20} aria-hidden="true" />
        <span className="mobile-bottombar__count" aria-hidden="true">
          {tabCount}
        </span>
        <span className="mobile-bottombar__label">Tabs</span>
      </button>
      <div className="mobile-bottombar__shield">{shield}</div>
      <button type="button" className="mobile-bottombar__btn" aria-label="Menu" onClick={onMenu}>
        <Menu size={22} aria-hidden="true" />
        <span className="mobile-bottombar__label">Menu</span>
      </button>
    </nav>
  );
}
