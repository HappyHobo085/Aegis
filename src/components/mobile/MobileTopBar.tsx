import { RotateCw, X } from 'lucide-react';
import type { Favorite } from '../../../shared/types';
import { AddressBar } from '../AddressBar';
import { MobileFavourites } from './MobileFavourites';

interface MobileTopBarProps {
  url: string;
  isLoading: boolean;
  onNavigate(raw: string): void;
  onReloadOrStop(): void;
  favorites: Favorite[];
  onOpenFavourite(url: string): void;
}

export function MobileTopBar({
  url, isLoading, onNavigate, onReloadOrStop, favorites, onOpenFavourite,
}: MobileTopBarProps) {
  return (
    <div className="mobile-topbar">
      <div className="mobile-topbar__row">
        <AddressBar url={url} onSubmit={onNavigate} />
        <button
          type="button"
          className="mobile-topbar__reload"
          aria-label={isLoading ? 'Stop' : 'Reload'}
          onClick={onReloadOrStop}
        >
          {isLoading ? <X size={18} aria-hidden="true" /> : <RotateCw size={18} aria-hidden="true" />}
        </button>
      </div>
      <MobileFavourites favorites={favorites} onOpen={onOpenFavourite} />
    </div>
  );
}
