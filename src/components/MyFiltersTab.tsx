// src/components/MyFiltersTab.tsx
import { useState } from 'react';

export interface MyFiltersTabProps {
  text: string;
  save(text: string): Promise<void>;
}

/** Counts non-empty, non-`!comment` lines (the client-side "rules" figure). */
export function countRules(text: string): number {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('!')).length;
}

export function MyFiltersTab({ text, save }: MyFiltersTabProps) {
  const [draft, setDraft] = useState(text);

  return (
    <div className="my-filters-tab">
      <label htmlFor="my-filters-tab-text">Custom filters</label>
      <textarea
        id="my-filters-tab-text"
        aria-label="Custom filters"
        className="my-filters-tab__textarea"
        placeholder={
          '! One filter per line. Examples:\n||ads.example.com^\nexample.com##.ad-banner'
        }
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        rows={12}
      />
      <div className="my-filters-tab__footer">
        <span className="my-filters-tab__count">{countRules(draft)} rules</span>
        <button type="button" aria-label="Save filters" onClick={() => void save(draft)}>
          Save
        </button>
      </div>
    </div>
  );
}
