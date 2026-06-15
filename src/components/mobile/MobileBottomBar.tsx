import type { ReactNode } from 'react';
import { ArrowLeft, ArrowRight, Home, Menu } from 'lucide-react';

interface MobileBottomBarProps {
  canGoBack: boolean;
  canGoForward: boolean;
  onBack(): void;
  onForward(): void;
  onHome(): void;
  onMenu(): void;
  shield: ReactNode;
}

export function MobileBottomBar({
  canGoBack, canGoForward, onBack, onForward, onHome, onMenu, shield,
}: MobileBottomBarProps) {
  return (
    <nav className="mobile-bottombar" aria-label="Browser actions">
      <button type="button" className="mobile-bottombar__btn" aria-label="Back" disabled={!canGoBack} onClick={onBack}>
        <ArrowLeft size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="Forward" disabled={!canGoForward} onClick={onForward}>
        <ArrowRight size={22} aria-hidden="true" />
      </button>
      <button type="button" className="mobile-bottombar__btn" aria-label="Home" onClick={onHome}>
        <Home size={22} aria-hidden="true" />
      </button>
      <div className="mobile-bottombar__shield">{shield}</div>
      <button type="button" className="mobile-bottombar__btn" aria-label="Menu" onClick={onMenu}>
        <Menu size={22} aria-hidden="true" />
      </button>
    </nav>
  );
}
