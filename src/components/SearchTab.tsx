// src/components/SearchTab.tsx
import { useState } from 'react';
import type { Settings, SearchEngine } from '../../shared/types';

export interface SearchTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

/** Lowercase the name and collapse non-alphanumeric runs to single dashes, trimming edges. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Slugify `name`, then disambiguate against `existing` ids by appending -2, -3, …. */
export function uniqueEngineId(name: string, existing: readonly string[]): string {
  const base = slugify(name) || 'engine';
  if (!existing.includes(base)) return base;
  let n = 2;
  while (existing.includes(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

export function SearchTab({ settings, update }: SearchTabProps) {
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');
  const [addError, setAddError] = useState<string | null>(null);

  const engines = settings.searchEngines;

  const setDefault = (engine: SearchEngine): void => {
    void update({ searchEngines: engines, defaultSearchTemplate: engine.template });
  };

  const remove = (id: string): void => {
    void update({ searchEngines: engines.filter((e) => e.id !== id) });
  };

  const handleAdd = (): void => {
    const name = newName.trim();
    const template = newTemplate.trim();
    if (name.length === 0) {
      setAddError('Enter a name for the engine.');
      return;
    }
    if (!template.includes('%s')) {
      setAddError('The search URL must contain %s where the query goes.');
      return;
    }
    const id = uniqueEngineId(
      name,
      engines.map((e) => e.id),
    );
    void update({ searchEngines: [...engines, { id, name, template }] });
    setNewName('');
    setNewTemplate('');
    setAddError(null);
  };

  return (
    <div className="search-tab">
      <ul className="search-tab__list">
        {engines.map((e) => (
          <li key={e.id} className="search-tab__row">
            <label className="search-tab__default">
              <input
                type="radio"
                name="search-tab-default"
                aria-label={`Default search engine ${e.name}`}
                checked={e.template === settings.defaultSearchTemplate}
                onChange={() => setDefault(e)}
              />
              <span className="search-tab__name">{e.name}</span>
            </label>
            <span className="search-tab__template">{e.template}</span>
            <button
              type="button"
              aria-label={`Remove engine ${e.name}`}
              onClick={() => remove(e.id)}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>

      <form
        className="search-tab__add"
        role="group"
        aria-label="Add search engine"
        onSubmit={(e) => {
          e.preventDefault();
          handleAdd();
        }}
      >
        <input
          type="text"
          aria-label="Engine name"
          placeholder="DuckDuckGo"
          value={newName}
          onChange={(e) => {
            setNewName(e.target.value);
            if (addError) setAddError(null);
          }}
        />
        <input
          type="text"
          aria-label="Engine template"
          placeholder="https://duckduckgo.com/?q=%s"
          value={newTemplate}
          onChange={(e) => {
            setNewTemplate(e.target.value);
            if (addError) setAddError(null);
          }}
        />
        {addError && (
          <div className="search-tab__add-error" role="alert">
            {addError}
          </div>
        )}
        <button type="submit">Add engine</button>
      </form>
    </div>
  );
}
