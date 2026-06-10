// src/components/FilterListsTab.tsx
import { useState } from 'react';
import type { Subscription, ListUpdateResult, ListSourceResult } from '../../shared/types';

export interface FilterListsTabProps {
  subs: Subscription[];
  setEnabled(listId: string, enabled: boolean): Promise<void>;
  add(url: string): Promise<void>;
  remove(listId: string): Promise<void>;
  updateNow(): Promise<ListUpdateResult>;
}

export function FilterListsTab({ subs, setEnabled, add, remove, updateNow }: FilterListsTabProps) {
  const [newUrl, setNewUrl] = useState('');
  const [results, setResults] = useState<ListSourceResult[]>([]);
  const [updating, setUpdating] = useState(false);

  const handleAdd = (): void => {
    const url = newUrl.trim();
    if (url.length === 0) return;
    void add(url);
    setNewUrl('');
  };

  const handleUpdateAll = (): void => {
    setUpdating(true);
    void updateNow()
      .then((r) => setResults(r.perSource))
      .finally(() => setUpdating(false));
  };

  return (
    <div className="filter-lists-tab">
      <div className="filter-lists-tab__actions">
        <button type="button" disabled={updating} onClick={handleUpdateAll}>
          Update all
        </button>
      </div>

      <ul className="filter-lists-tab__list">
        {subs.map((s) => (
          <li key={s.listId} className="filter-lists-tab__row">
            <button
              type="button"
              role="switch"
              aria-checked={s.enabled}
              aria-label={`Enable list ${s.listId}`}
              onClick={() => void setEnabled(s.listId, !s.enabled)}
            >
              {s.enabled ? 'On' : 'Off'}
            </button>
            <span className="filter-lists-tab__id">{s.listId}</span>
            <span className="filter-lists-tab__url">{s.url}</span>
            <button
              type="button"
              aria-label={`Remove list ${s.listId}`}
              onClick={() => void remove(s.listId)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <div className="filter-lists-tab__add" role="group" aria-label="Add filter list">
        <input
          type="text"
          aria-label="List URL"
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
        />
        <button type="button" onClick={handleAdd}>
          Add list
        </button>
      </div>

      {results.length > 0 && (
        <ul className="filter-lists-tab__results" aria-label="Update results">
          {results.map((r) => (
            <li key={r.listId}>
              {r.listId}: {r.ok ? 'updated' : `failed — ${r.error ?? 'error'}`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
