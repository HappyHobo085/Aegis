// src/components/OmniboxDropdown.test.tsx
//
// The ARIA 1.2 combobox popup. The two behaviours that are easy to regress:
//   1. Picking uses `onMouseDown` + `preventDefault`, NOT `click` — the input must
//      never lose focus before the pick is handled, or the list closes first and the
//      navigation is lost.
//   2. Highlighted runs are keyed by their OFFSET in the source string, and the marked
//      characters must reassemble into the original label exactly.
import { describe, it, expect, vi, type Mock } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { OmniboxDropdown } from './OmniboxDropdown';
import type { OmniboxSuggestion } from '../lib/omnibox';

const suggestion = (over: Partial<OmniboxSuggestion> = {}): OmniboxSuggestion => ({
  id: 'history:1',
  kind: 'history',
  title: 'Example Domain',
  url: 'https://example.com/',
  target: 'https://example.com/',
  titleMatches: [0, 1, 2],
  urlMatches: [],
  ...over,
});

const renderDropdown = (
  suggestions: OmniboxSuggestion[] = [suggestion()],
  activeIndex = -1,
  h: { onPick?: Mock; onHover?: Mock } = {},
) => {
  const handlers: { onPick: Mock; onHover: Mock } = {
    onPick: h.onPick ?? vi.fn(),
    onHover: h.onHover ?? vi.fn(),
  };
  render(
    <OmniboxDropdown
      suggestions={suggestions}
      activeIndex={activeIndex}
      idPrefix="addr"
      onPick={handlers.onPick as (s: OmniboxSuggestion) => void}
      onHover={handlers.onHover as (i: number) => void}
    />,
  );
  return handlers;
};

describe('OmniboxDropdown', () => {
  it('renders a listbox labelled Suggestions', () => {
    renderDropdown();
    expect(screen.getByRole('listbox', { name: 'Suggestions' })).toBeInTheDocument();
  });

  it('renders one option per suggestion', () => {
    renderDropdown([suggestion({ id: 'a' }), suggestion({ id: 'b' })]);
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('renders nothing but the hint for an empty list', () => {
    renderDropdown([]);
    expect(screen.queryAllByRole('option')).toHaveLength(0);
    expect(screen.getByText(/to navigate/)).toBeInTheDocument();
  });

  it('marks exactly the active row as selected', () => {
    renderDropdown([suggestion({ id: 'a' }), suggestion({ id: 'b' })], 1);
    const options = screen.getAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'false');
    expect(options[1]).toHaveAttribute('aria-selected', 'true');
  });

  it('marks nothing selected when the cursor is at -1', () => {
    renderDropdown([suggestion()], -1);
    expect(screen.getByRole('option')).toHaveAttribute('aria-selected', 'false');
  });

  it('gives each option an id the input can point aria-activedescendant at', () => {
    renderDropdown([suggestion()], 0, undefined);
    expect(screen.getByRole('option')).toHaveAttribute('id', 'addr-opt-0');
  });

  it('ids the list with the caller’s prefix', () => {
    renderDropdown();
    expect(screen.getByRole('listbox')).toHaveAttribute('id', 'addr-list');
  });

  describe('picking', () => {
    // THE regression this guards: switching to `onClick` lets the input blur first,
    // which closes the list before the pick is handled.
    it('picks on MOUSEDOWN, before any click', () => {
      const onPick = vi.fn();
      renderDropdown([suggestion()], -1, { onPick });
      fireEvent.mouseDown(screen.getByRole('option'));
      expect(onPick).toHaveBeenCalledTimes(1);
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'history:1' }), 0);
    });

    it('prevents the default mousedown so the input keeps focus', () => {
      renderDropdown([suggestion()]);
      const event = createMouseEvent(screen.getByRole('option'), 'mousedown');
      expect(event.defaultPrevented).toBe(true);
    });

    it('picks the row that was mousedown’d, not another one', () => {
      const onPick = vi.fn();
      renderDropdown([suggestion({ id: 'a' }), suggestion({ id: 'b' })], -1, { onPick });
      fireEvent.mouseDown(screen.getAllByRole('option')[1]);
      // The index is the SECOND argument, and it is what the popover surface reports to Rust
      // (which bounds-checks it). The suggestion stays first so the chrome, which owns the
      // array, keeps its existing one-argument signature.
      expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ id: 'b' }), 1);
    });

    it('reports the hovered index', () => {
      const onHover = vi.fn();
      renderDropdown([suggestion({ id: 'a' }), suggestion({ id: 'b' })], -1, { onHover });
      fireEvent.mouseEnter(screen.getAllByRole('option')[1]);
      expect(onHover).toHaveBeenCalledWith(1);
    });
  });

  describe('highlighting', () => {
    const labelText = (option: HTMLElement) =>
      Array.from(option.querySelectorAll('.omnibox__title span, .omnibox__title mark'))
        .map((n) => n.textContent)
        .join('');

    it('reassembles the title exactly from its runs', () => {
      renderDropdown([suggestion({ title: 'abcdef', titleMatches: [2, 3] })]);
      expect(labelText(screen.getByRole('option'))).toBe('abcdef');
    });

    it('marks only the matched characters', () => {
      renderDropdown([suggestion({ title: 'abc', titleMatches: [1] })]);
      const marks = screen.getByRole('option').querySelectorAll('.omnibox__hit');
      expect(Array.from(marks).map((m) => m.textContent)).toEqual(['b']);
    });

    it('renders no mark when there are no matches', () => {
      renderDropdown([suggestion({ title: 'abc', titleMatches: [] })]);
      expect(screen.getByRole('option').querySelectorAll('.omnibox__hit')).toHaveLength(0);
    });

    it('ignores out-of-range match indices without dropping text', () => {
      renderDropdown([suggestion({ title: 'abc', titleMatches: [0, 99, -3] })]);
      expect(labelText(screen.getByRole('option'))).toBe('abc');
      expect(screen.getByRole('option').querySelectorAll('.omnibox__hit')).toHaveLength(1);
    });

    it('merges adjacent matched characters into one run', () => {
      renderDropdown([suggestion({ title: 'abcde', titleMatches: [1, 2, 3] })]);
      const marks = screen.getByRole('option').querySelectorAll('.omnibox__hit');
      expect(Array.from(marks).map((m) => m.textContent)).toEqual(['bcd']);
    });

    it('splits non-adjacent matches into separate runs', () => {
      renderDropdown([suggestion({ title: 'abcde', titleMatches: [0, 4] })]);
      const marks = screen.getByRole('option').querySelectorAll('.omnibox__hit');
      expect(Array.from(marks).map((m) => m.textContent)).toEqual(['a', 'e']);
    });

    it('highlights the URL too, independently of the title', () => {
      renderDropdown([
        suggestion({ title: 'Title', url: 'https://ab.test/', urlMatches: [8, 10] }),
      ]);
      const url = screen.getByRole('option').querySelector('.omnibox__url');
      const marks = Array.from(url?.querySelectorAll('.omnibox__hit') ?? []);
      expect(marks.map((m) => m.textContent)).toEqual(['a', '.']);
    });
  });

  describe('layout', () => {
    it('omits the URL line for a row with no URL (the Search row)', () => {
      renderDropdown([suggestion({ kind: 'search', title: 'Search for “x”', url: '' })]);
      expect(screen.getByRole('option').querySelector('.omnibox__url')).toBeNull();
    });

    it('labels each row by kind', () => {
      renderDropdown([suggestion({ kind: 'search' })]);
      expect(screen.getByText('Search')).toBeInTheDocument();
    });

    it('labels every kind distinctly', () => {
      const kinds = ['navigate', 'favorite', 'saved', 'history', 'recent', 'search'] as const;
      const labels = ['Address', 'Favorite', 'Saved', 'History', 'Recent', 'Search'];
      renderDropdown(kinds.map((kind, i) => suggestion({ id: `s${i}`, kind })));
      for (const label of labels) expect(screen.getByText(label)).toBeInTheDocument();
    });

    it('marks the active row with the active class as well as aria-selected', () => {
      renderDropdown([suggestion()], 0);
      expect(screen.getByRole('option')).toHaveClass('omnibox__row--active');
    });
  });

  it('forwards the ref so the parent can measure it for the content inset', () => {
    const ref = { current: null as HTMLDivElement | null };
    render(
      <OmniboxDropdown
        suggestions={[suggestion()]}
        activeIndex={-1}
        idPrefix="p"
        ref={ref}
        onPick={vi.fn()}
        onHover={vi.fn()}
      />,
    );
    expect(ref.current).toBe(screen.getByRole('listbox'));
  });

  it('does not crash when the cursor is out of range', () => {
    expect(() => renderDropdown([suggestion()], 99)).not.toThrow();
  });
});

/** Dispatch a cancelable event and report whether anything prevented the default. */
function createMouseEvent(el: Element, type: string): Event {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}
