// src/components/FavoritesManager.tsx
import { useId, useState } from 'react';
import { Trash2, X } from 'lucide-react';
import type { Favorite } from '../../shared/types';
import { useDialog } from '../hooks/useDialog';
import { TagInput } from './TagInput';

export interface FavoritesManagerProps {
  favorites: Favorite[];
  tagUnion: string[];
  onClose(): void;
  add(input: { name: string; url: string; tags: string[] }): Promise<void>;
  update(id: number, partial: { name?: string; url?: string; tags?: string[] }): Promise<void>;
  remove(id: number): Promise<void>;
  renameTag(oldT: string, newT: string): Promise<void>;
  deleteTag(tag: string): Promise<void>;
}

function FavoriteRow({
  favorite,
  tagUnion,
  update,
  remove,
}: {
  favorite: Favorite;
  tagUnion: string[];
  update: FavoritesManagerProps['update'];
  remove: FavoritesManagerProps['remove'];
}) {
  const [name, setName] = useState(favorite.name);
  const [url, setUrl] = useState(favorite.url);
  const [tags, setTags] = useState<string[]>(favorite.tags);

  return (
    <li className="favorites-manager__row">
      <span className="favorites-manager__row-name">{favorite.name}</span>
      <input
        type="text"
        aria-label={`Name for ${favorite.name}`}
        value={name}
        onChange={(e) => setName(e.target.value)}
      />
      <input
        type="text"
        aria-label={`URL for ${favorite.name}`}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
      />
      <TagInput tags={tags} suggestions={tagUnion} onChange={setTags} />
      <button
        type="button"
        aria-label={`Save favorite ${favorite.name}`}
        onClick={() => void update(favorite.id, { name, url, tags })}
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
  tagUnion,
  onClose,
  add,
  update,
  remove,
  renameTag,
  deleteTag,
}: FavoritesManagerProps) {
  const titleId = useId();
  const dialogRef = useDialog<HTMLDivElement>(onClose);

  const [newName, setNewName] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newTags, setNewTags] = useState<string[]>([]);

  const [tagToManage, setTagToManage] = useState('');
  const [renameTo, setRenameTo] = useState('');

  const handleAdd = (): void => {
    if (newName.trim().length === 0 || newUrl.trim().length === 0) return;
    void add({ name: newName.trim(), url: newUrl.trim(), tags: newTags });
    setNewName('');
    setNewUrl('');
    setNewTags([]);
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
          <FavoriteRow key={f.id} favorite={f} tagUnion={tagUnion} update={update} remove={remove} />
        ))}
      </ul>

      <div className="favorites-manager__add" role="group" aria-label="Add favorite">
        <input
          type="text"
          aria-label="New favorite name"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="text"
          aria-label="New favorite URL"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <TagInput tags={newTags} suggestions={tagUnion} onChange={setNewTags} />
        <button type="button" onClick={handleAdd}>
          Add favorite
        </button>
      </div>

      <div className="favorites-manager__tags" role="group" aria-label="Manage tags">
        <select
          aria-label="Tag to manage"
          value={tagToManage}
          onChange={(e) => setTagToManage(e.target.value)}
        >
          <option value="">Select a tag</option>
          {tagUnion.map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
        <input
          type="text"
          aria-label="Rename tag to"
          value={renameTo}
          onChange={(e) => setRenameTo(e.target.value)}
        />
        <button
          type="button"
          disabled={tagToManage.length === 0 || renameTo.trim().length === 0}
          onClick={() => {
            void renameTag(tagToManage, renameTo.trim());
            setRenameTo('');
            setTagToManage('');
          }}
        >
          Rename tag
        </button>
        <button
          type="button"
          disabled={tagToManage.length === 0}
          onClick={() => {
            void deleteTag(tagToManage);
            setTagToManage('');
          }}
        >
          Delete tag
        </button>
      </div>
    </div>
    </div>
  );
}
