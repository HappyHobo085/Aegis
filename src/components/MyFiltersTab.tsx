// src/components/MyFiltersTab.tsx
import { useState } from 'react';
import { toast } from '../lib/toast';

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

  const handleSave = (): void => {
    void (async () => {
      await save(draft);
      toast.success('Saved');
    })();
  };

  return (
    <form
      className="my-filters-tab"
      onSubmit={(e) => {
        e.preventDefault();
        handleSave();
      }}
    >
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
        <button type="submit" aria-label="Save filters">
          Save
        </button>
      </div>
    </form>
  );
}
