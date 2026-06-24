import {
  ArrowLeft,
  ArrowRight,
  Home,
  Bookmark,
  Download,
  Settings,
  Search,
  ZoomIn,
  ZoomOut,
  RotateCcw,
} from 'lucide-react';
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
  zoomPercent: string;
  onZoomIn(): void;
  onZoomOut(): void;
  onZoomReset(): void;
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
  zoomPercent,
  onZoomIn,
  onZoomOut,
  onZoomReset,
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
            <Bookmark
              size={20}
              aria-hidden="true"
              fill={isCurrentSaved ? 'currentColor' : 'none'}
            />
            {isCurrentSaved ? 'Remove bookmark' : 'Bookmark this page'}
          </button>
        </li>
        <li>
          <button type="button" className="mobile-menu__item" onClick={onFind}>
            <Search size={20} aria-hidden="true" />
            Find in page
          </button>
        </li>
        <li className="mobile-menu__item--zoom">
          <span className="mobile-menu__zoom-label">Zoom</span>
          <div className="mobile-menu__zoom-controls">
            <button
              type="button"
              className="mobile-menu__item mobile-menu__zoom-btn"
              aria-label="Zoom out"
              onClick={onZoomOut}
            >
              <ZoomOut size={18} aria-hidden="true" />
            </button>
            <span className="mobile-menu__zoom-value">{zoomPercent}</span>
            <button
              type="button"
              className="mobile-menu__item mobile-menu__zoom-btn"
              aria-label="Zoom in"
              onClick={onZoomIn}
            >
              <ZoomIn size={18} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="mobile-menu__item mobile-menu__zoom-btn"
              aria-label="Reset zoom"
              onClick={onZoomReset}
            >
              <RotateCcw size={16} aria-hidden="true" />
            </button>
          </div>
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
