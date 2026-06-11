// src/components/SearchTab.tsx
import { useState } from 'react';
import type { Settings, SearchEngine } from '../../shared/types';

export interface SearchTabProps {
  settings: Settings;
  update(partial: Partial<Settings>): Promise<void>;
}

export function SearchTab({ settings, update }: SearchTabProps) {
  const [newId, setNewId] = useState('');
  const [newName, setNewName] = useState('');
  const [newTemplate, setNewTemplate] = useState('');

  const engines = settings.searchEngines;

  const setDefault = (engine: SearchEngine): void => {
    void update({ searchEngines: engines, defaultSearchTemplate: engine.template });
  };

  const remove = (id: string): void => {
    void update({ searchEngines: engines.filter((e) => e.id !== id) });
  };

  const handleAdd = (): void => {
    const id = newId.trim();
    const name = newName.trim();
    const template = newTemplate.trim();
    if (id.length === 0 || name.length === 0 || template.length === 0) return;
    void update({ searchEngines: [...engines, { id, name, template }] });
    setNewId('');
    setNewName('');
    setNewTemplate('');
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

      <div className="search-tab__add" role="group" aria-label="Add search engine">
        <input
          type="text"
          aria-label="Engine id"
          placeholder="ddg"
          value={newId}
          onChange={(e) => setNewId(e.target.value)}
        />
        <input
          type="text"
          aria-label="Engine name"
          placeholder="DuckDuckGo"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
        />
        <input
          type="text"
          aria-label="Engine template"
          placeholder="https://duckduckgo.com/?q=%s"
          value={newTemplate}
          onChange={(e) => setNewTemplate(e.target.value)}
        />
        <button type="button" onClick={handleAdd}>
          Add engine
        </button>
      </div>
    </div>
  );
}
