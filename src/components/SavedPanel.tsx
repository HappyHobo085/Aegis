// src/components/SavedPanel.tsx
import { Bookmark, X } from 'lucide-react';
import type { SavedItem } from '../../shared/types';

export interface SavedPanelProps {
  items: SavedItem[];
  remove(id: number): Promise<SavedItem[]> | void;
  onOpen(url: string): void;
}

export function SavedPanel({ items, remove, onOpen }: SavedPanelProps) {
  return (
    <div className="saved-panel" role="group" aria-label="Saved">
      {items.length === 0 ? (
        <div className="saved-panel__empty">
          <Bookmark size={32} aria-hidden="true" />
          <span>Nothing saved yet.</span>
          <span className="saved-panel__empty-hint">Save the current page with the bookmark button.</span>
        </div>
      ) : (
        <ul className="saved-panel__list">
          {items.map((item) => {
            const label = item.title.length > 0 ? item.title : item.url;
            return (
              <li key={item.id} className="saved-panel__row">
                <button
                  type="button"
                  className="saved-panel__open"
                  aria-label={`Open ${item.url}`}
                  onClick={() => onOpen(item.url)}
                >
                  <span className="saved-panel__title">{label}</span>
                  <span className="saved-panel__url">{item.url}</span>
                </button>
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
