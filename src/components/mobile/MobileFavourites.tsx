import { Plus } from 'lucide-react';
import type { Favorite } from '../../../shared/types';

interface MobileFavouritesProps {
  favorites: Favorite[];
  onOpen(url: string): void;
  onAdd?(): void;
}

export function MobileFavourites({ favorites, onOpen, onAdd }: MobileFavouritesProps) {
  return (
    // A <nav>, not a <div aria-label>: aria-label is ignored on a generic element,
    // so the "Favourites" landmark never reached a screen reader. This matches the
    // desktop FavoritesBar, which is the same landmark on the same surface.
    <nav className="mobile-favourites" aria-label="Favourites">
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
    </nav>
  );
}
