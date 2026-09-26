// src/components/HistoryPanel.tsx
import { useEffect, useId, useRef } from 'react';
import { Clock, Trash2, X } from 'lucide-react';
import type { HistoryEntry } from '../../shared/types';
import { formatHost, formatRelativeTime, groupByDay } from '../lib/format';
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

/** Live-search debounce. Long enough to skip a burst of keystrokes, short enough
 *  that the list still feels like it is tracking the input. */
const SEARCH_DEBOUNCE_MS = 200;

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
  const groupBaseId = useId();

  // Search as you type. The caller owns the query, so re-run the (already
  // blank-aware) search whenever it settles; a blank query falls back to the
  // full list inside the hook, so clearing the box restores everything without
  // any special case here. `search` is read through a ref so a caller that
  // re-creates the callback on every render doesn't restart the timer.
  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    const timer = setTimeout(() => {
      void searchRef.current();
    }, SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [query]);

  const handleSubmit = (event: React.FormEvent): void => {
    event.preventDefault();
    void search();
  };

  const handleClear = async (): Promise<void> => {
    const ok = await confirm('Clear all history? This cannot be undone.', { destructive: true });
    if (ok) void clear();
  };

  const trimmed = query.trim();
  const groups = groupByDay(entries, (entry) => entry.visitedAt);
  // "142 visits" while browsing, "7 results for “cat”" while filtering — the count is
  // announced politely so a screen reader hears the list shrink as results narrow.
  const countLabel = trimmed
    ? `${entries.length} result${entries.length === 1 ? '' : 's'} for “${trimmed}”`
    : `${entries.length} visit${entries.length === 1 ? '' : 's'}`;

  return (
    <div className="history-panel" role="group" aria-label="History">
      <form className="history-panel__search" role="search" onSubmit={handleSubmit}>
        <label htmlFor={searchId} className="history-panel__search-label">
          Search history
        </label>
        <input
          id={searchId}
          type="search"
          aria-label="Search history"
          placeholder="Search history…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {trimmed.length > 0 && (
          <button
            type="button"
            className="history-panel__search-clear"
            aria-label="Clear history search"
            onClick={() => setQuery('')}
          >
            <X size={14} aria-hidden="true" />
          </button>
        )}
        <button type="submit" aria-label="Run history search">
          Search
        </button>
      </form>
      <div className="history-panel__toolbar">
        <span className="history-panel__count" role="status">
          {countLabel}
        </span>
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
      </div>
      {entries.length === 0 ? (
        <div className="history-panel__empty">
          <Clock size={32} aria-hidden="true" />
          <span>No history yet.</span>
          <span className="history-panel__empty-hint">
            Pages you visit in regular tabs appear here. Private tabs stay out of history.
          </span>
        </div>
      ) : (
        <div className="history-panel__groups">
          {groups.map((group) => {
            const headerId = `${groupBaseId}-${group.bucket}`;
            return (
              <section
                key={group.bucket}
                className="history-panel__group"
                aria-labelledby={headerId}
              >
                <h3 id={headerId} className="history-panel__group-header">
                  {group.label}
                </h3>
                <ul className="history-panel__list">
                  {group.items.map((entry) => {
                    const label = entry.title.length > 0 ? entry.title : entry.url;
                    const host = formatHost(entry.url);
                    const time = formatRelativeTime(entry.visitedAt);
                    return (
                      <li key={entry.id} className="history-panel__row">
                        <button
                          type="button"
                          className="history-panel__open"
                          aria-label={`Open ${entry.url}`}
                          onClick={() => onOpen(entry.url)}
                        >
                          <span className="history-panel__title">{label}</span>
                          <span className="history-panel__meta">
                            {host.length > 0 && <span className="history-panel__host">{host}</span>}
                            {time.length > 0 && <span className="history-panel__time">{time}</span>}
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
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}
