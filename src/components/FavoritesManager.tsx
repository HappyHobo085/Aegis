// src/components/FavoritesManager.tsx
import { useId, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { Favorite } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { useChromeSurface } from '../hooks/useChromeSurfaces';

export interface FavoritesManagerProps {
  favorites: Favorite[];
  onClose(): void;
  add(input: { name: string; url: string }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string }): Promise<void>;
  remove(id: number): Promise<void>;
}

function FavoriteRow({
  favorite,
  update,
  remove,
}: {
  favorite: Favorite;
  update: FavoritesManagerProps['update'];
  remove: FavoritesManagerProps['remove'];
}) {
  const [name, setName] = useState(favorite.name);
  const [url, setUrl] = useState(favorite.url);

  return (
    <li className="favorites-manager__row">
      <span className="favorites-manager__row-name">{favorite.name}</span>
      <input
        type="text"
        aria-label={`Name for ${favorite.name}`}
        placeholder="Hacker News"
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        aria-label={`URL for ${favorite.name}`}
        placeholder="https://news.ycombinator.com"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <button
        type="button"
        aria-label={`Save favorite ${favorite.name}`}
        onClick={() => void update(favorite.id, { name, url })}
      >
        Save
      </button>
      <button
        type="button"
        aria-label={`Remove favorite ${favorite.name}`}
        onClick={() => void remove(favorite.id)}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
    </li>
  );
}

export function FavoritesManager({
  favorites,
  onClose,
  add,
  update,
  remove,
}: FavoritesManagerProps) {
  useChromeSurface('favoritesManager', true);
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');

  const handleAdd = (): void => {
    if (newName.trim().length === 0 || newUrl.trim().length === 0) return;
    void add({ name: newName.trim(), url: newUrl.trim() });
    setNewName('');
    setNewUrl('');
  };

  return (
    <div className="favorites-manager__scrim">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className="favorites-manager"
      >
        <div className="favorites-manager__header">
          <h2 id={titleId} className="favorites-manager__title">
            Manage favorites
          </h2>
          <button type="button" aria-label="Close" onClick={onClose}>
            <X size={18} aria-hidden="true" />
          </button>
        </div>

        <ul className="favorites-manager__list">
          {favorites.map((f) => (
            <FavoriteRow key={f.id} favorite={f} update={update} remove={remove} />
          ))}
        </ul>

        <div className="favorites-manager__add" role="group" aria-label="Add favorite">
          <input
            type="text"
            aria-label="New favorite name"
            placeholder="Hacker News"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
          />
          <input
            type="text"
            aria-label="New favorite URL"
            placeholder="https://news.ycombinator.com"
            value={newUrl}
            onChange={(e) => setNewUrl(e.target.value)}
          />
          <button type="button" onClick={handleAdd}>
            Add favorite
          </button>
        </div>
      </div>
    </div>
  );
}
