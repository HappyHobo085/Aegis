import { Settings, History, Bookmark, Download, Star } from 'lucide-react';
import { MobileSheet } from './MobileSheet';

interface MobileMenuSheetProps {
  onClose(): void;
  onSettings(): void;
  onHistory(): void;
  onSaved(): void;
  onDownloads(): void;
  isCurrentSaved: boolean;
  canBookmark: boolean;
  onToggleBookmark(): void;
}

export function MobileMenuSheet({
  onClose, onSettings, onHistory, onSaved, onDownloads,
  isCurrentSaved, canBookmark, onToggleBookmark,
}: MobileMenuSheetProps) {
  return (
    <MobileSheet title="Menu" onClose={onClose}>
      <ul className="mobile-menu">
        <li>
          <button type="button" className="mobile-menu__item" disabled={!canBookmark} onClick={onToggleBookmark}>
            <Star size={20} aria-hidden="true" />
            {isCurrentSaved ? 'Remove bookmark' : 'Bookmark this page'}
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onSaved}>
            <Bookmark size={20} aria-hidden="true" />Saved
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onHistory}>
            <History size={20} aria-hidden="true" />History
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onDownloads}>
            <Download size={20} aria-hidden="true" />Downloads
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onSettings}>
            <Settings size={20} aria-hidden="true" />Settings
          </button>
        </li>
      </ul>
    </MobileSheet>
  );
}
