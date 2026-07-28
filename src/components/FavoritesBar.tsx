// src/components/FavoritesBar.tsx
import type { Favorite } from '../../shared/types';
import { useHorizontalWheel } from '../hooks/useHorizontalWheel';

export interface FavoritesBarProps {
  favorites: Favorite[];
  onOpenFavorite(url: string): void;
  onOpenManager(): void;
}

export function FavoritesBar({ favorites, onOpenFavorite, onOpenManager }: FavoritesBarProps) {
  const barRef = useHorizontalWheel<HTMLElement>();
  return (
    <nav ref={barRef} className="favorites-bar" aria-label="Bookmarks">
      <div className="favorites-bar__chips">
        {favorites.map((f) => (
          <button
            key={f.id}
            type="button"
            className="favorites-bar__chip"
            title={f.url}
            aria-label={`Open ${f.name}`}
            onClick={() => onOpenFavorite(f.url)}
          >
            {f.name}
          </button>
        ))}
      </div>
      <button
        type="button"
        className="favorites-bar__add"
        aria-label="New bookmark"
        title="New bookmark"
        onClick={onOpenManager}
      >
        +
      </button>
    </nav>
  );
}
