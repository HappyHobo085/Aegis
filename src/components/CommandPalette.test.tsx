import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act, fireEvent, waitFor } from '@testing-library/react';
import { CommandPalette } from './CommandPalette';
import type { PaletteResult } from '../lib/commandPaletteData';

// ── Mocks ────────────────────────────────────────────────────────────────
// The palette is a pure consumer of `commandPaletteData`'s five getters, so
// mocking them makes the result set deterministic. `fuzzySearch` is
// deliberately NOT mocked: the component runs the real fuzzy matcher, so the
// `<mark>` highlight assertions below exercise the actual matching code.

const {
  getTabResults,
  getBookmarkResults,
  getHistoryResults,
  getActionResults,
  getSettingsResults,
  getRecent,
  addRecent,
} = vi.hoisted(() => ({
  getTabResults: vi.fn(),
  getBookmarkResults: vi.fn(),
  getHistoryResults: vi.fn(),
  getActionResults: vi.fn(),
  getSettingsResults: vi.fn(),
  getRecent: vi.fn(),
  addRecent: vi.fn(),
}));

vi.mock('../lib/commandPaletteData', () => ({
  getTabResults,
  getBookmarkResults,
  getHistoryResults,
  getActionResults,
  getSettingsResults,
}));

vi.mock('../lib/recentActions', () => ({ getRecent, addRecent }));

// `useChromeSurface` registers the palette's id in a context so the chrome can
// avoid double-rendering it. The palette must work without that provider, which
// is exactly what a no-op mock asserts.
vi.mock('../hooks/useChromeSurfaces', () => ({ useChromeSurface: () => {} }));

function result(
  over: Partial<PaletteResult> & Pick<PaletteResult, 'id' | 'title' | 'category'>,
): PaletteResult {
  return { action: vi.fn(), ...over };
}

function actionResult(id: string, title: string, subtitle?: string): PaletteResult {
  return result({ id, title, subtitle, category: 'actions' });
}

const TABS: PaletteResult[] = [
  result({
    id: 'tab:1',
    title: 'Example Domain',
    subtitle: 'https://example.com',
    category: 'tabs',
  }),
  result({
    id: 'tab:2',
    title: 'Rust Book',
    subtitle: 'https://doc.rust-lang.org',
    category: 'tabs',
  }),
];
const BOOKMARKS: PaletteResult[] = [
  result({ id: 'bm:1', title: 'Aegis repo', category: 'bookmarks' }),
];
const HISTORY: PaletteResult[] = [result({ id: 'hist:1', title: 'Old news', category: 'history' })];
const ACTIONS: PaletteResult[] = [actionResult('action.reload', 'Reload', 'Refresh this page')];
const SETTINGS: PaletteResult[] = [
  result({ id: 'settings.sync', title: 'Sync settings', category: 'settings' }),
];

function seedAll() {
  getTabResults.mockResolvedValue(TABS);
  getBookmarkResults.mockResolvedValue(BOOKMARKS);
  getHistoryResults.mockResolvedValue(HISTORY);
  getActionResults.mockReturnValue(ACTIONS);
  getSettingsResults.mockReturnValue(SETTINGS);
}

/**
 * Type a query and wait for the debounced fetch to land.
 *
 * Real timers, not fake ones: the palette debounces on a 200 ms `setTimeout`
 * and the three async getters then resolve a promise, so the result arrives
 * two microtask/turn boundaries after the timer fires. `vi.advanceTimersByTime`
 * only controls the timer — it does not flush the promise chain — so a fake-timer
 * version would have to fake both and silently pass against an empty list.
 * `waitFor` drives real time and polls, so it covers the timer, the await, and
 * the resulting state update in one step.
 */
async function typeQuery(text: string) {
  fireEvent.change(input(), { target: { value: text } });
  await waitFor(() => expect(getTabResults).toHaveBeenCalled());
  // The fetch being called is not the same as its results being rendered.
  await waitFor(() => expect(options().length).toBeGreaterThan(0));
}

/** Let the palette's own mount-time fetch (empty query) resolve. */
async function settle() {
  await waitFor(() => expect(getTabResults).toHaveBeenCalled());
}

const options = () => screen.getAllByRole('option');
const selected = () => screen.getByRole('option', { selected: true });
const input = () => screen.getByRole('searchbox', { name: 'Search commands' });

beforeEach(() => {
  // Clear first, before re-seeding: the `ACTIONS` fixture is a module-level
  // const, so its `action` mocks would otherwise accumulate calls across tests
  // and make "called once" assertions depend on test ordering.
  vi.clearAllMocks();
  // jsdom has no layout engine and does NOT implement `scrollIntoView`, which
  // the palette's keep-the-selection-visible effect calls. Without this stub the
  // effect throws inside the tree and every later query in this file fails with
  // a confusing "unable to find role=option" rather than the real cause.
  Element.prototype.scrollIntoView = vi.fn();
  seedAll();
  // No recents, so the palette takes the grouped-by-section path rather than
  // the flat "Recent" path. Both are exercised elsewhere.
  getRecent.mockReturnValue([]);
});

// ── Tests ────────────────────────────────────────────────────────────────

describe('CommandPalette — visibility and dialog semantics', () => {
  it('renders nothing at all when closed', () => {
    const { container } = render(<CommandPalette open={false} viewId={1} onClose={vi.fn()} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('exposes a modal dialog labelled "Command palette"', () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // aria-labelledby must resolve to the sr-only heading, not dangle.
    const labelId = dialog.getAttribute('aria-labelledby');
    expect(labelId).toBeTruthy();
    expect(document.getElementById(labelId!)).toHaveTextContent('Command palette');
  });

  it('names the search field and the list for assistive tech', () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    expect(input()).toBeInTheDocument();
    expect(screen.getByRole('listbox', { name: 'Commands' })).toBeInTheDocument();
  });
});

describe('CommandPalette — results and grouping', () => {
  it('shows a "No results." empty state when nothing matches', () => {
    getActionResults.mockReturnValue([]);
    getSettingsResults.mockReturnValue([]);
    getTabResults.mockResolvedValue([]);
    getBookmarkResults.mockResolvedValue([]);
    getHistoryResults.mockResolvedValue([]);
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    expect(screen.getByText('No results.')).toBeInTheDocument();
    // `getAllByRole` throws on zero matches, so the zero case needs the
    // `query*` variant.
    expect(screen.queryAllByRole('option')).toHaveLength(0);
  });

  it('groups results under one header per section, in the fixed section order', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    // Query by class, not by role: the scrim and the <li> wrappers around each
    // option also resolve to `presentation`, so `getAllByRole` over-counts.
    const labels = [...document.querySelectorAll('.command-palette__section-header')].map(
      (el) => el.textContent?.trim() ?? '',
    );
    expect(labels).toEqual(['Tabs', 'Bookmarks', 'History', 'Actions', 'Settings']);
  });

  it('debounces the three async getters but not the two synchronous ones', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    // On mount the two SYNC getters have already run; the three async ones are
    // still waiting on their 200 ms debounce timer.
    expect(getActionResults).toHaveBeenCalled();
    expect(getSettingsResults).toHaveBeenCalled();
    expect(getTabResults).not.toHaveBeenCalled();

    await settle();
    expect(getTabResults).toHaveBeenCalledTimes(1);
    expect(getBookmarkResults).toHaveBeenCalledTimes(1);
    expect(getHistoryResults).toHaveBeenCalledTimes(1);
  });

  it('marks up the fuzzy-matched characters only for a non-empty query', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    // An empty query matches everything with NO match positions, so there is
    // deliberately nothing to highlight.
    await settle();
    await waitFor(() => expect(options().length).toBeGreaterThan(0));
    expect(document.querySelectorAll('mark.command-palette__highlight')).toHaveLength(0);

    await typeQuery('Exa');
    // "Exa" are all in "Example Domain" — first result, first three letters.
    const marks = [...document.querySelectorAll('mark.command-palette__highlight')].map(
      (m) => m.textContent,
    );
    expect(marks).toEqual(['E', 'x', 'a']);
  });
});

// The palette is a modal dialog whose search field never loses focus, so `aria-activedescendant`
// is the ONLY channel by which a screen reader can be told which row the arrow keys moved to.
// The listbox also has to OWN its options directly: an unroled `<li>` in between (implicit role
// `listitem`) breaks that association, which is why each wrapper is `role="presentation"`.
describe('CommandPalette — the listbox is reachable from the search field', () => {
  it('points the field at the listbox, and announces the row the arrow keys land on', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    const box = screen.getByRole('listbox', { name: 'Commands' });

    expect(input()).toHaveAttribute('aria-controls', box.id);
    expect(box.id).not.toBe('');

    // The FIRST option is selected on an empty query, and the field names exactly that row.
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[0].id);

    await act(async () => {
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
    });
    expect(selected()).toBe(options()[1]);
    // Not merely "some row": it must be the row `aria-selected` just moved to, or the
    // announcement and the highlight disagree.
    expect(input().getAttribute('aria-activedescendant')).toBe(options()[1].id);
    expect(document.getElementById(input().getAttribute('aria-activedescendant')!)).toBe(
      options()[1],
    );
  });

  it('announces nothing while there is nothing to announce', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
    });
    expect(input().hasAttribute('aria-activedescendant')).toBe(true);

    // Now empty every section. A nonsense query would NOT do: the two SYNC getters answer
    // from their fixtures whatever the text is, so the list would still hold their rows.
    getActionResults.mockReturnValue([]);
    getSettingsResults.mockReturnValue([]);
    getTabResults.mockResolvedValue([]);
    getBookmarkResults.mockResolvedValue([]);
    getHistoryResults.mockResolvedValue([]);
    await act(async () => {
      fireEvent.change(input(), { target: { value: 'zzz' } });
    });
    await waitFor(() => expect(screen.queryAllByRole('option')).toHaveLength(0));
    // A stale id here would make a screen reader jump to a row that no longer exists.
    expect(input().hasAttribute('aria-activedescendant')).toBe(false);
  });

  it('gives every option a distinct id, and owns them directly', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    const ids = options().map((o) => o.id);
    expect(ids.every((id) => id !== '')).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);

    // Direct ownership, asserted over the DOM rather than the role query: the wrappers are
    // `<li role="presentation">`, so an `li` left unroled here would be a `listitem` child
    // of a `listbox`, which the ARIA listbox pattern does not allow.
    const box = screen.getByRole('listbox', { name: 'Commands' });
    const unroled = [...box.children].filter((c) => c.tagName === 'LI' && !c.getAttribute('role'));
    expect(unroled).toHaveLength(0);
  });
});

describe('CommandPalette — keyboard navigation', () => {
  it('starts on the first option and wraps in both directions', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    expect(selected()).toBe(options()[0]);

    await act(async () => {
      fireEvent.keyDown(input(), { key: 'ArrowDown' });
    });
    expect(selected()).toBe(options()[1]);

    // ArrowUp from the first option must wrap to the LAST, not clamp at 0.
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'ArrowUp' });
      fireEvent.keyDown(input(), { key: 'ArrowUp' });
    });
    expect(selected()).toBe(options()[options().length - 1]);
  });

  it('selects an option on hover, mirroring what Enter would run', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await typeQuery('e');
    const third = options()[2];
    expect(third).toHaveAttribute('aria-selected', 'false');
    await act(async () => {
      fireEvent.mouseEnter(third);
    });
    expect(third).toHaveAttribute('aria-selected', 'true');
  });
});

describe('CommandPalette — activation', () => {
  it('runs the selected result, records it as recent, and closes', async () => {
    const onClose = vi.fn();
    // Filtering the query is the DATA layer's job (`commandPaletteData`), and
    // these getters are mocked, so they ignore the query entirely. Narrow the
    // seeded results here rather than relying on the palette to filter.
    getTabResults.mockResolvedValue([]);
    getBookmarkResults.mockResolvedValue([]);
    getHistoryResults.mockResolvedValue([]);
    getSettingsResults.mockReturnValue([]);
    render(<CommandPalette open viewId={1} onClose={onClose} />);
    await typeQuery('Reload');

    // "Reload" is the only match, so it is selected by default.
    const target = selected();
    expect(target).toHaveTextContent('Reload');

    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Enter' });
    });

    // Exactly once. Only `CommandPalette`'s own `handleKeyDown` can reach
    // `execute` on Enter: it calls `e.preventDefault()` and then `return`s, and
    // `useDialog`'s dialog-level `keydown` listener handles ONLY Escape and Tab
    // (`if (event.key !== 'Tab') return;`), so it never sees an Enter as a
    // command. The file's `beforeEach` already does `vi.clearAllMocks()` before
    // re-seeding, so these module-level `action` mocks carry no calls across
    // tests — nothing needs weakening here.
    expect(ACTIONS[0].action).toHaveBeenCalledTimes(1);
    // Recent is recorded BEFORE closing — a failed action must still be recallable.
    expect(addRecent).toHaveBeenCalledWith('action.reload');
    expect(onClose).toHaveBeenCalled();
  });

  it('closes on Escape without running anything', async () => {
    const onClose = vi.fn();
    render(<CommandPalette open viewId={1} onClose={onClose} />);
    await typeQuery('e');
    await act(async () => {
      fireEvent.keyDown(input(), { key: 'Escape' });
    });
    // Twice, in fact: `useDialog` binds its own Escape handler on the dialog node
    // and the search input is inside it, so one keypress reaches both. Harmless
    // for an idempotent close, but it is why this is not `toHaveBeenCalledTimes(1)`.
    expect(onClose).toHaveBeenCalled();
    // The important part: a dismiss must NOT run a command or record a recency.
    expect(ACTIONS[0].action).not.toHaveBeenCalled();
    expect(addRecent).not.toHaveBeenCalled();
  });

  it('closes on a scrim click but NOT on a click inside the dialog', async () => {
    const onClose = vi.fn();
    const { container } = render(<CommandPalette open viewId={1} onClose={onClose} />);
    const dialog = screen.getByRole('dialog');

    await act(async () => {
      fireEvent.click(dialog);
    });
    expect(onClose).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(container.querySelector('.command-palette__scrim')!);
    });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog instead of walking out of it', async () => {
    render(<CommandPalette open viewId={1} onClose={vi.fn()} />);
    await settle();
    input().focus();
    const event = new KeyboardEvent('keydown', { key: 'Tab', bubbles: true, cancelable: true });
    await act(async () => {
      input().dispatchEvent(event);
    });
    // preventDefault is the whole mechanism: without it the browser would move
    // focus to the next tabbable element outside the modal.
    expect(event.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(input());
  });
});
