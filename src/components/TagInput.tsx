// src/components/TagInput.tsx
import { useState } from 'react';
import { X } from 'lucide-react';

export interface TagInputProps {
  tags: string[];
  suggestions: string[];
  onChange(tags: string[]): void;
}

export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const [draft, setDraft] = useState('');

  // Add a tag (trimmed, no blanks, no duplicates).
  const addTag = (raw: string): void => {
    const value = raw.trim();
    if (value.length === 0 || tags.includes(value)) return;
    onChange([...tags, value]);
  };

  const commit = (): void => {
    addTag(draft);
    setDraft('');
  };

  const removeTag = (tag: string): void => {
    onChange(tags.filter((t) => t !== tag));
  };

  // In-DOM suggestions (native <datalist> popups don't render in the transparent
  // chrome WebContentsView — see TagFilter for the same button-based pattern).
  // Show tags not already applied, narrowed by what's been typed so far.
  const q = draft.trim().toLowerCase();
  const available = suggestions.filter(
    (s) => !tags.includes(s) && (q.length === 0 || s.toLowerCase().includes(q)),
  );

  return (
    <div className="tag-input-field">
      <div className="tag-input">
        <ul className="tag-input__chips">
          {tags.map((tag) => (
            <li key={tag} className="tag-input__chip">
              <span>{tag}</span>
              <button type="button" aria-label={`Remove tag ${tag}`} onClick={() => removeTag(tag)}>
                <X size={12} aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
        <input
          type="text"
          aria-label="Add tag"
          placeholder="Add a tag…"
          value={draft}
          autoComplete="off"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commit();
            }
          }}
          // Commit a typed-but-not-Entered tag when focus leaves, so it isn't
          // lost if the user clicks Save instead of pressing Enter. `commit`
          // (via addTag) already no-ops on empty/whitespace/duplicate input.
          onBlur={() => commit()}
        />
      </div>
      {available.length > 0 && (
        <div className="tag-input__suggestions" role="group" aria-label="Tag suggestions">
          {available.map((s) => (
            <button
              key={s}
              type="button"
              className="tag-input__suggestion"
              onClick={() => {
                addTag(s);
                setDraft('');
              }}
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
