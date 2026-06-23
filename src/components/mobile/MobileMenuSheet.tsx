import { ArrowLeft, ArrowRight, Home, Star, Download, Settings, Search } from 'lucide-react';
import { MobileSheet } from './MobileSheet';

interface MobileMenuSheetProps {
  onClose(): void;
  onBack(): void;
  onForward(): void;
  canGoBack: boolean;
  canGoForward: boolean;
  onHome(): void;
  onDownloads(): void;
  onSettings(): void;
  isCurrentSaved: boolean;
  canBookmark: boolean;
  onToggleBookmark(): void;
  onFind(): void;
}

export function MobileMenuSheet({
  onClose,
  onBack,
  onForward,
  canGoBack,
  canGoForward,
  onHome,
  onDownloads,
  onSettings,
  isCurrentSaved,
  canBookmark,
  onToggleBookmark,
  onFind,
}: MobileMenuSheetProps) {
  return (
    <MobileSheet title="Menu" onClose={onClose}>
      <ul className="mobile-menu">
        <li>
          <button
            type="button"
            className="mobile-menu__item"
            disabled={!canGoBack}
            onClick={onBack}
          >
            <ArrowLeft size={20} aria-hidden="true" />
            Back
          </button>
        </li>
        <li>
          <button
            type="button"
            className="mobile-menu__item"
            disabled={!canGoForward}
            onClick={onForward}
          >
            <ArrowRight size={20} aria-hidden="true" />
            Forward
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onHome}>
            <Home size={20} aria-hidden="true" />
            Home
          </button>
        </li>
        <li>
          <button
            type="button"
            className="mobile-menu__item"
            disabled={!canBookmark}
            onClick={onToggleBookmark}
          >
            <Star size={20} aria-hidden="true" />
            {isCurrentSaved ? 'Remove bookmark' : 'Bookmark this page'}
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onFind}>
            <Search size={20} aria-hidden="true" />
            Find in page
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onDownloads}>
            <Download size={20} aria-hidden="true" />
            Downloads
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onSettings}>
            <Settings size={20} aria-hidden="true" />
            Settings
          </button>
        </li>
      </ul>
    </MobileSheet>
  );
}
