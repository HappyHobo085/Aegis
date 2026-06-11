// src/components/SavedPanel.tsx
import { useId, useState } from 'react';
import { Bookmark, Check, Pencil, X } from 'lucide-react';
import type { SavedItem } from '../../shared/types';

export interface SavedPanelProps {
  items: SavedItem[];
  remove(id: number): Promise<SavedItem[]> | void;
  update(id: number, title: string): void;
  onOpen(url: string): void;
}

export function SavedPanel({ items, remove, update, onOpen }: SavedPanelProps) {
  const searchId = useId();
  const [query, setQuery] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState('');

  const q = query.trim().toLowerCase();
  const filtered =
    q.length === 0
      ? items
      : items.filter(
          (i) => i.title.toLowerCase().includes(q) || i.url.toLowerCase().includes(q),
        );

  const startEdit = (item: SavedItem): void => {
    setEditingId(item.id);
    setDraft(item.title);
  };

  const cancelEdit = (): void => {
    setEditingId(null);
  };

  const saveEdit = (id: number): void => {
    update(id, draft.trim());
    setEditingId(null);
  };

  return (
    <div className="saved-panel" role="group" aria-label="Saved">
      {items.length > 0 && (
        <form
          className="saved-panel__search"
          role="search"
          onSubmit={(e) => e.preventDefault()}
        >
          <label htmlFor={searchId} className="saved-panel__search-label">
            Search saved
          </label>
          <input
            id={searchId}
            type="search"
            role="searchbox"
            aria-label="Search saved"
            placeholder="Search saved…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </form>
      )}
      {items.length === 0 ? (
        <div className="saved-panel__empty">
          <Bookmark size={32} aria-hidden="true" />
          <span>Nothing saved yet.</span>
          <span className="saved-panel__empty-hint">Save the current page with the bookmark button.</span>
        </div>
      ) : filtered.length === 0 ? (
        <div className="saved-panel__nomatch">No matches.</div>
      ) : (
        <ul className="saved-panel__list">
          {filtered.map((item) => {
            const label = item.title.length > 0 ? item.title : item.url;
            const isEditing = editingId === item.id;
            return (
              <li key={item.id} className="saved-panel__row">
                {isEditing ? (
                  <input
                    className="saved-panel__edit-input"
                    aria-label="Edit title"
                    value={draft}
                    autoFocus
                    onChange={(e) => setDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        saveEdit(item.id);
                      } else if (e.key === 'Escape') {
                        e.preventDefault();
                        cancelEdit();
                      }
                    }}
                    onBlur={cancelEdit}
                  />
                ) : (
                  <button
                    type="button"
                    className="saved-panel__open"
                    aria-label={`Open ${item.url}`}
                    onClick={() => onOpen(item.url)}
                  >
                    <span className="saved-panel__title">{label}</span>
                    <span className="saved-panel__url">{item.url}</span>
                  </button>
                )}
                {isEditing ? (
                  <button
                    type="button"
                    className="saved-panel__save"
                    aria-label="Save title"
                    title="Save title"
                    // onMouseDown so the click registers before the input's onBlur cancels.
                    onMouseDown={(e) => {
                      e.preventDefault();
                      saveEdit(item.id);
                    }}
                  >
                    <Check size={14} aria-hidden="true" />
                  </button>
                ) : (
                  <button
                    type="button"
                    className="saved-panel__edit"
                    aria-label="Edit title"
                    title="Edit title"
                    onClick={() => startEdit(item)}
                  >
                    <Pencil size={14} aria-hidden="true" />
                  </button>
                )}
                <button
                  type="button"
                  className="saved-panel__remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => void remove(item.id)}
                >
                  <X size={14} aria-hidden="true" />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
