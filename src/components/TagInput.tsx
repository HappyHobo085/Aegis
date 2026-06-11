// src/components/TagInput.tsx
import { useId, useState } from 'react';
import { X } from 'lucide-react';

export interface TagInputProps {
  tags: string[];
  suggestions: string[];
  onChange(tags: string[]): void;
}

export function TagInput({ tags, suggestions, onChange }: TagInputProps) {
  const [draft, setDraft] = useState('');
  const listId = useId();

  const commit = (): void => {
    const value = draft.trim();
    setDraft('');
    if (value.length === 0 || tags.includes(value)) return;
    onChange([...tags, value]);
  };

  const removeTag = (tag: string): void => {
    onChange(tags.filter((t) => t !== tag));
  };

  // Suggest only tags not already applied.
  const available = suggestions.filter((s) => !tags.includes(s));

  return (
    <div className="tag-input">
      <ul className="tag-input__chips">
        {tags.map((tag) => (
          <li key={tag} className="tag-input__chip">
            <span>{tag}</span>
            <button
              type="button"
              aria-label={`Remove tag ${tag}`}
              onClick={() => removeTag(tag)}
            >
              <X size={12} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
      <input
        type="text"
        aria-label="Add tag"
        placeholder="Add a tag…"
        list={listId}
        value={draft}
        autoComplete="off"
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            commit();
          }
        }}
      />
      <datalist id={listId}>
        {available.map((s) => (
          <option key={s} value={s} />
        ))}
      </datalist>
    </div>
  );
}
