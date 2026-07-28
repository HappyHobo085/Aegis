import { Bookmark, History, Layers, Maximize2, Menu } from 'lucide-react';

interface MobileBottomBarProps {
  onSaved(): void;
  onHistory(): void;
  onTabs(): void;
  tabCount: number;
  onFullscreen(): void;
  onMenu(): void;
}

export function MobileBottomBar({
  onSaved,
  onHistory,
  onTabs,
  tabCount,
  onFullscreen,
  onMenu,
}: MobileBottomBarProps) {
  return (
    <nav className="mobile-bottombar" aria-label="Browser actions">
      <button type="button" className="mobile-bottombar__btn" aria-label="Saved" onClick={onSaved}>
        <Bookmark size={20} aria-hidden="true" />
        <span className="mobile-bottombar__label">Saved</span>
      </button>
      <button
        type="button"
        className="mobile-bottombar__btn"
        aria-label="History"
        onClick={onHistory}
      >
        <History size={20} aria-hidden="true" />
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
      <button
        type="button"
        className="mobile-bottombar__btn"
        aria-label="Enter fullscreen"
        onClick={onFullscreen}
      >
        <Maximize2 size={20} aria-hidden="true" />
        <span className="mobile-bottombar__label">Fullscreen</span>
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="Menu" onClick={onMenu}>
        <Menu size={20} aria-hidden="true" />
        <span className="mobile-bottombar__label">Menu</span>
      </button>
    </nav>
  );
}
