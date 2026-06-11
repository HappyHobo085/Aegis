// src/components/FavoritesBar.tsx
import { SlidersHorizontal } from 'lucide-react';
import type { Favorite } from '../../shared/types';
import { TagFilter } from './TagFilter';

export interface FavoritesBarProps {
  favorites: Favorite[];
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  onOpenFavorite(url: string): void;
  onOpenManager(): void;
}

export function FavoritesBar({
  favorites,
  tagUnion,
  activeTags,
  setActiveTags,
  onOpenFavorite,
  onOpenManager,
}: FavoritesBarProps) {
  return (
    <nav className="favorites-bar" aria-label="Favorites">
      <div className="favorites-bar__chips">
        {favorites.map((f) => (
          <button
            key={f.id}
            type="button"
            className="favorites-bar__chip"
            title={f.url}
            onClick={() => onOpenFavorite(f.url)}
          >
            {f.name}
          </button>
        ))}
      </div>
      <TagFilter tagUnion={tagUnion} activeTags={activeTags} setActiveTags={setActiveTags} />
      <button
        type="button"
        className="favorites-bar__manage"
        aria-label="Manage favorites"
        onClick={onOpenManager}
      >
        <SlidersHorizontal size={16} aria-hidden="true" />
      </button>
    </nav>
  );
}
