// src/components/MyFiltersTab.tsx
import { useEffect, useRef, useState } from 'react';
import { toast } from '../lib/toast';
import { saveErrorText } from '../lib/saveError';

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
  // Re-sync when the persisted filters change externally (sync push / data import), unless the
  // user has unsaved edits (only adopt when the draft still matches the last-seen value).
  const lastPropRef = useRef(text);
  useEffect(() => {
    if (text !== lastPropRef.current) {
      if (draft === lastPropRef.current) setDraft(text);
      lastPropRef.current = text;
    }
  }, [text, draft]);

  const handleSave = (): void => {
    void (async () => {
      try {
        await save(draft);
        toast.success('Saved');
      } catch (e) {
        // A rejected save used to be swallowed whole: no "Saved" (good) but also no
        // error, so a refused save was indistinguishable from a dead button, and the
        // rejection escaped as an unhandled promise rejection. The draft stays put so
        // the rule that was refused can be corrected and saved again.
        toast.error(saveErrorText(e));
      }
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

export default MyFiltersTab;
