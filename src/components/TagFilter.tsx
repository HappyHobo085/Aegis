// src/components/TagFilter.tsx
export interface TagFilterProps {
  tagUnion: string[];
  activeTags: string[];
  setActiveTags(tags: string[]): void;
  label?: string;
}

export function TagFilter({
  tagUnion,
  activeTags,
  setActiveTags,
  label = 'Filter by tag',
}: TagFilterProps) {
  if (tagUnion.length === 0) return null;

  const toggle = (tag: string): void => {
    if (activeTags.includes(tag)) {
      setActiveTags(activeTags.filter((t) => t !== tag));
    } else {
      setActiveTags([...activeTags, tag]);
    }
  };

  return (
    <div className="tag-filter" role="group" aria-label={label}>
      {tagUnion.map((tag) => {
        const active = activeTags.includes(tag);
        return (
          <button
            key={tag}
            type="button"
            className="tag-filter__chip"
            aria-label={`Filter by tag ${tag}`}
            aria-pressed={active}
            onClick={() => toggle(tag)}
          >
            {tag}
          </button>
        );
      })}
    </div>
  );
}
