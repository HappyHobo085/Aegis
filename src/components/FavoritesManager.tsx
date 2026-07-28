// src/components/FavoritesManager.tsx
import { useId, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { Favorite } from '../../shared/types';
import { normalizeSavedUrl } from '../lib/addressParse';
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
  const [error, setError] = useState<string | null>(null);

  const handleSave = (): void => {
    if (name.trim().length === 0) {
      setError('Enter a name.');
      return;
    }
    const normalized = normalizeSavedUrl(url);
    if (!normalized.ok) {
      setError(normalized.reason);
      return;
    }
    setError(null);
    void update(favorite.id, { name: name.trim(), url: normalized.url });
  };

  return (
    <li className="favorites-manager__row">
      <span className="favorites-manager__row-name">{favorite.name}</span>
      <input
        type="text"
        aria-label={`Name for ${favorite.name}`}
        placeholder="Hacker News"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          if (error) setError(null);
        }}
      />
      <input
        type="text"
        aria-label={`URL for ${favorite.name}`}
        placeholder="https://news.ycombinator.com"
        value={url}
        onChange={(e) => {
          setUrl(e.target.value);
          if (error) setError(null);
        }}
      />
      <button type="button" aria-label={`Save bookmark ${favorite.name}`} onClick={handleSave}>
        Save
      </button>
      <button
        type="button"
        aria-label={`Remove bookmark ${favorite.name}`}
        onClick={() => void remove(favorite.id)}
      >
        <Trash2 size={14} aria-hidden="true" />
      </button>
      {error && (
        <div className="favorites-manager__row-error" role="alert">
          {error}
        </div>
      )}
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
  const [addError, setAddError] = useState<string | null>(null);

  const handleAdd = (): void => {
    if (newName.trim().length === 0) {
      setAddError('Enter a name.');
      return;
    }
    const normalized = normalizeSavedUrl(newUrl);
    if (!normalized.ok) {
      setAddError(normalized.reason);
      return;
    }
    void add({ name: newName.trim(), url: normalized.url });
    setNewName('');
    setNewUrl('');
    setAddError(null);
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
            Manage bookmarks
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

        <div className="favorites-manager__add" role="group" aria-label="Add bookmark">
          <input
            type="text"
            aria-label="New bookmark name"
            placeholder="Hacker News"
            value={newName}
            onChange={(e) => {
              setNewName(e.target.value);
              if (addError) setAddError(null);
            }}
          />
          <input
            type="text"
            aria-label="New bookmark URL"
            placeholder="https://news.ycombinator.com"
            value={newUrl}
            onChange={(e) => {
              setNewUrl(e.target.value);
              if (addError) setAddError(null);
            }}
          />
          <button type="button" onClick={handleAdd}>
            Add bookmark
          </button>
          {addError && (
            <div className="favorites-manager__add-error" role="alert">
              {addError}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
