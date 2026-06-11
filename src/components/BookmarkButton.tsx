// src/components/BookmarkButton.tsx
import { Star } from 'lucide-react';

export interface BookmarkButtonProps {
  saved: boolean;
  canSave: boolean;
  onSave(): void;
  onUnsave(): void;
}

export function BookmarkButton({ saved, canSave, onSave, onUnsave }: BookmarkButtonProps) {
  const label = saved ? 'Remove bookmark' : 'Save bookmark';

  return (
    <button
      type="button"
      className="bookmark-button"
      aria-label={label}
      aria-pressed={saved}
      disabled={!canSave}
      onClick={() => (saved ? onUnsave() : onSave())}
    >
      <span aria-hidden="true" className="bookmark-button__icon">
        <Star size={18} aria-hidden="true" fill={saved ? 'currentColor' : 'none'} />
      </span>
    </button>
  );
}
