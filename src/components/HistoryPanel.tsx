// src/components/HistoryPanel.tsx
import { useId } from 'react';
import { Clock, Trash2, X } from 'lucide-react';
import type { HistoryEntry } from '../../shared/types';
import { confirm } from '../lib/toast';

export interface HistoryPanelProps {
  entries: HistoryEntry[];
  query: string;
  setQuery(q: string): void;
  search(): Promise<void> | void;
  remove(id: number): Promise<void> | void;
  clear(): Promise<void> | void;
  onOpen(url: string): void;
}

export function HistoryPanel({
  entries,
  query,
  setQuery,
  search,
  remove,
  clear,
  onOpen,
}: HistoryPanelProps) {
  const searchId = useId();

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    void search();
  };

  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all history? This cannot be undone.', { destructive: true });
    if (ok) void clear();
  };

  return (
    <div className="history-panel" role="group" aria-label="History">
      <form className="history-panel__search" role="search" onSubmit={handleSubmit}>
        <label htmlFor={searchId} className="history-panel__search-label">
          Search history
        </label>
        <input
          id={searchId}
          type="search"
          role="searchbox"
          aria-label="Search history"
          placeholder="Search history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <button type="submit" aria-label="Run history search">
          Search
        </button>
      </form>
      <button
        type="button"
        className="history-panel__clear"
        aria-label="Clear all history"
        disabled={entries.length === 0}
        onClick={() => void handleClear()}
      >
        <Trash2 size={14} aria-hidden="true" />
        Clear all
      </button>
      {entries.length === 0 ? (
        <div className="history-panel__empty">
          <Clock size={32} aria-hidden="true" />
          <span>No history yet.</span>
          <span className="history-panel__empty-hint">
            Pages you visit in regular tabs appear here. Private tabs stay out of history.
          </span>
        </div>
      ) : (
        <ul className="history-panel__list">
          {entries.map((entry) => {
            const label = entry.title.length > 0 ? entry.title : entry.url;
            return (
              <li key={entry.id} className="history-panel__row">
                <button
                  type="button"
                  className="history-panel__open"
                  aria-label={`Open ${entry.url}`}
                  onClick={() => onOpen(entry.url)}
                >
                  <span className="history-panel__title">{label}</span>
                  <span className="history-panel__url">{entry.url}</span>
                  <span className="history-panel__time">
                    {new Date(entry.visitedAt).toLocaleString()}
                  </span>
                </button>
                <button
                  type="button"
                  className="history-panel__remove"
                  aria-label={`Remove ${label}`}
                  onClick={() => void remove(entry.id)}
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
