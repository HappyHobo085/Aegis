import { Plus } from 'lucide-react';
import type { Favorite } from '../../../shared/types';

interface MobileFavouritesProps {
  favorites: Favorite[];
  onOpen(url: string): void;
  onAdd?(): void;
}

export function MobileFavourites({ favorites, onOpen, onAdd }: MobileFavouritesProps) {
  return (
    <div className="mobile-favourites" aria-label="Favourites">
      {favorites.map((f) => (
        <button
          key={f.id}
          type="button"
          className="mobile-favourites__chip"
          title={f.name}
          onClick={() => onOpen(f.url)}
        >
          {f.name}
        </button>
      ))}
      {onAdd && (
        <button
          type="button"
          className="mobile-favourites__add"
          aria-label="Add bookmark"
          onClick={onAdd}
        >
          <Plus size={14} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
