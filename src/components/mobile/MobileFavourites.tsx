import type { Favorite } from '../../../shared/types';

interface MobileFavouritesProps {
  favorites: Favorite[];
  onOpen(url: string): void;
}

export function MobileFavourites({ favorites, onOpen }: MobileFavouritesProps) {
  if (favorites.length === 0) return null;
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
    </div>
  );
}
