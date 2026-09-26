// src/components/OmniboxDropdown.tsx
//
// The address-bar suggestion list. Purely presentational: it renders whatever
// rows `useOmnibox` produced and reports picks/hovers back.
//
// Accessibility: this is the ARIA 1.2 *combobox with a popup listbox* pattern —
// the input keeps DOM focus at all times and points at the highlighted row with
// `aria-activedescendant`, so arrow keys move a virtual cursor without the focus
// ever leaving the text field (no focus trap, unlike the `useDialog` popovers).
import { useEffect, useRef } from 'react';
import type { Ref } from 'react';
import { Bookmark, Clock, Globe, Search, Star } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import type { OmniboxSuggestion } from '../lib/omnibox';

export interface OmniboxDropdownProps {
  suggestions: OmniboxSuggestion[];
  activeIndex: number;
  /** DOM id prefix for the input's `aria-activedescendant` (useId in the parent). */
  idPrefix: string;
  /** The root element, so the parent can measure it for the content inset. */
  ref?: Ref<HTMLDivElement>;
  onPick(suggestion: OmniboxSuggestion): void;
  onHover(index: number): void;
}

const KIND_ICON: Record<OmniboxSuggestion['kind'], LucideIcon> = {
  navigate: Globe,
  favorite: Star,
  saved: Bookmark,
  history: Clock,
  recent: Clock,
  search: Search,
};

const KIND_LABEL: Record<OmniboxSuggestion['kind'], string> = {
  navigate: 'Address',
  favorite: 'Favorite',
  saved: 'Saved',
  history: 'History',
  recent: 'Recent',
  search: 'Search',
};

/** Split `text` into plain / highlighted runs at the given character indices.
 *  `start` is the run's offset in the source string, so callers can key on it
 *  (a content-independent, index-independent identity). */
function runs(
  text: string,
  matches: number[],
): Array<{ text: string; hit: boolean; start: number }> {
  if (matches.length === 0) return [{ text, hit: false, start: 0 }];
  const hitSet = new Set(matches.filter((i) => i >= 0 && i < text.length));
  const out: Array<{ text: string; hit: boolean; start: number }> = [];
  let buffer = '';
  let bufferHit = hitSet.has(0);
  let bufferStart = 0;
  for (let i = 0; i < text.length; i++) {
    const hit = hitSet.has(i);
    if (hit !== bufferHit) {
      if (buffer.length > 0) out.push({ text: buffer, hit: bufferHit, start: bufferStart });
      buffer = '';
      bufferStart = i;
      bufferHit = hit;
    }
    buffer += text[i];
  }
  if (buffer.length > 0) out.push({ text: buffer, hit: bufferHit, start: bufferStart });
  return out;
}

/** One label, with its matched characters emphasised. */
function Highlighted({ text, matches }: { text: string; matches: number[] }) {
  return (
    <>
      {runs(text, matches).map((run) =>
        run.hit ? (
          <mark key={run.start} className="omnibox__hit">
            {run.text}
          </mark>
        ) : (
          <span key={run.start}>{run.text}</span>
        ),
      )}
    </>
  );
}

export function OmniboxDropdown({
  suggestions,
  activeIndex,
  idPrefix,
  ref,
  onPick,
  onHover,
}: OmniboxDropdownProps) {
  const optionRefs = useRef<Array<HTMLDivElement | null>>([]);

  // Keep the keyboard cursor in view — arrow-keying past the fold is disorienting
  // otherwise. `nearest` avoids yanking the list when the row is already visible.
  useEffect(() => {
    if (activeIndex < 0) return;
    // Not implemented in jsdom; a real browser always has it.
    optionRefs.current[activeIndex]?.scrollIntoView?.({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div
      ref={ref}
      className="omnibox"
      role="listbox"
      aria-label="Suggestions"
      id={`${idPrefix}-list`}
    >
      {suggestions.map((s, index) => {
        const Icon = KIND_ICON[s.kind];
        const selected = index === activeIndex;
        return (
          <div
            key={s.id}
            id={`${idPrefix}-opt-${index}`}
            ref={(el) => {
              optionRefs.current[index] = el;
            }}
            role="option"
            aria-selected={selected}
            className={`omnibox__row${selected ? ' omnibox__row--active' : ''}`}
            // mousedown, not click: the input must not lose focus (and the list
            // must not close) before the pick is handled.
            onMouseDown={(e) => {
              e.preventDefault();
              onPick(s);
            }}
            onMouseEnter={() => onHover(index)}
          >
            <span className="omnibox__icon" aria-hidden="true">
              <Icon size={15} />
            </span>
            <span className="omnibox__text">
              <span className="omnibox__title">
                <Highlighted text={s.title} matches={s.titleMatches} />
              </span>
              {s.url.length > 0 && (
                <span className="omnibox__url">
                  <Highlighted text={s.url} matches={s.urlMatches} />
                </span>
              )}
            </span>
            <span className="omnibox__kind">{KIND_LABEL[s.kind]}</span>
          </div>
        );
      })}
      <p className="omnibox__hint" aria-hidden="true">
        <kbd>↑</kbd>
        <kbd>↓</kbd> to navigate · <kbd>Enter</kbd> to open · <kbd>Esc</kbd> to close
      </p>
    </div>
  );
}
