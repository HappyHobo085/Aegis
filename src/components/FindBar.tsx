import { useRef, useEffect } from 'react';
import { ChevronUp, ChevronDown, X } from 'lucide-react';
import type { FindState } from '../../shared/types';

/**
 * Infobar shown while a find-in-page session is active. Purely presentational — it
 * receives find state + callbacks as props and renders: a text input, a match-count
 * status span, prev/next navigation buttons, and a close button.
 *
 * It renders in the chrome's always-visible top strip (the content webview is opaque
 * and on top, so a floating toast can't paint over it — see App's content-inset wiring,
 * which adds FIND_BAR_H while this is shown).
 *
 * Keyboard behaviour: Enter → onNext(), Shift+Enter → onPrev(), Escape → onClose().
 * The input is auto-focused on mount, like a real browser find bar.
 */
export function FindBar({
  state,
  onQueryChange,
  onNext,
  onPrev,
  onClose,
}: {
  state: FindState;
  onQueryChange(q: string): void;
  onNext(): void;
  onPrev(): void;
  onClose(): void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);

  // Auto-focus the input when the bar mounts, like a real browser find bar.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (e.shiftKey) {
        onPrev();
      } else {
        onNext();
      }
    }
  }

  const noMatches = state.matchCount === 0;
  const countText = noMatches ? 'No matches' : `${state.activeMatchIndex}/${state.matchCount}`;

  return (
    <div className="find-bar">
      <input
        ref={inputRef}
        className="find-bar__input"
        type="text"
        aria-label="Find in page"
        value={state.query}
        onChange={(e) => onQueryChange(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Find in page…"
        spellCheck={false}
        autoComplete="off"
      />
      <span className="find-bar__count" role="status" aria-live="polite">
        {countText}
      </span>
      <button
        type="button"
        className="find-bar__nav"
        aria-label="Find previous"
        disabled={noMatches}
        onClick={onPrev}
      >
        <ChevronUp size={16} aria-hidden="true" />
      </button>
      <button
        type="button"
        className="find-bar__nav"
        aria-label="Find next"
        disabled={noMatches}
        onClick={onNext}
      >
        <ChevronDown size={16} aria-hidden="true" />
      </button>
      <button type="button" className="find-bar__close" aria-label="Close find" onClick={onClose}>
        <X size={16} aria-hidden="true" />
      </button>
    </div>
  );
}
