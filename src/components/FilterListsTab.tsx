// src/components/FilterListsTab.tsx
import { useState } from 'react';
import type { Subscription, ListUpdateResult, ListSourceResult } from '../../shared/types';
import { normalizeSavedUrl } from '../lib/addressParse';

export interface FilterListsTabProps {
  subs: Subscription[];
  setEnabled(listId: string, enabled: boolean): Promise<void>;
  add(url: string): Promise<void>;
  remove(listId: string): Promise<void>;
  updateNow(): Promise<ListUpdateResult>;
}

export function FilterListsTab({ subs, setEnabled, add, remove, updateNow }: FilterListsTabProps) {
  const [newUrl, setNewUrl] = useState('');
  const [addError, setAddError] = useState<string | null>(null);
  const [results, setResults] = useState<ListSourceResult[]>([]);
  const [updating, setUpdating] = useState(false);

  const handleAdd = (): void => {
    const result = normalizeSavedUrl(newUrl);
    if (!result.ok) {
      setAddError(result.reason);
      return;
    }
    void add(result.url);
    setNewUrl('');
    setAddError(null);
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
            {s.builtin ? (
              // Built-in defaults are toggleable but not removable (disable, don't delete)
              // — re-seeding respects a removal, so hiding Remove keeps them present.
              <span className="filter-lists-tab__builtin" title="Default list (toggle to disable)">
                Built-in
              </span>
            ) : (
              <button
                type="button"
                aria-label={`Remove list ${s.listId}`}
                onClick={() => void remove(s.listId)}
              >
                Remove
              </button>
            )}
          </li>
        ))}
      </ul>

      <form
        className="filter-lists-tab__add"
        role="group"
        aria-label="Add filter list"
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
      >
        <input
          type="text"
          aria-label="List URL"
          placeholder="https://easylist.to/easylist/easylist.txt"
          value={newUrl}
          onChange={(e) => {
            setNewUrl(e.target.value);
            if (addError) setAddError(null);
          }}
        />
        {addError && (
          <div className="filter-lists-tab__add-error" role="alert">
            {addError}
          </div>
        )}
        <button type="submit">Add list</button>
      </form>

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

export default FilterListsTab;
