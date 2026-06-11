// src/components/SavedPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedItem } from '../../shared/types';

import { SavedPanel } from './SavedPanel';

const items: SavedItem[] = [
  { id: 2, url: 'https://docs.example/', title: 'Docs', tags: ['reference', 'work'], savedAt: 1_700_000_000_000 },
  { id: 1, url: 'https://blog.example/', title: '', tags: ['reading'], savedAt: 1_600_000_000_000 },
];

const tagUnion = ['reading', 'reference', 'work'];

function props() {
  return {
    items,
    tagUnion,
    activeTags: [] as string[],
    setActiveTags: vi.fn(),
    add: vi.fn(),
    remove: vi.fn(async () => [] as SavedItem[]),
    update: vi.fn(),
    renameTag: vi.fn(),
    deleteTag: vi.fn(),
    onOpen: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('SavedPanel', () => {
  it('renders the saved items with their titles', () => {
    render(<SavedPanel {...props()} />);
    expect(screen.getByText('Docs')).toBeInTheDocument();
  });

  it('falls back to the URL as the label when an item has no title', () => {
    render(<SavedPanel {...props()} />);
    expect(screen.getByRole('button', { name: /open https:\/\/blog\.example/i })).toBeInTheDocument();
  });

  it('clicking an item calls onOpen with its url', async () => {
    const p = props();
    render(<SavedPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open https:\/\/docs\.example/i }));
    expect(p.onOpen).toHaveBeenCalledWith('https://docs.example/');
  });

  it('clicking a row remove button calls remove with the item id', async () => {
    const p = props();
    render(<SavedPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove docs/i }));
    expect(p.remove).toHaveBeenCalledWith(2);
  });

  it('shows an empty-state message when there are no saved items', () => {
    render(<SavedPanel {...props()} items={[]} />);
    expect(screen.getByText(/nothing saved/i)).toBeInTheDocument();
  });

  describe('search', () => {
    it('filters by title (case-insensitive)', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.type(screen.getByRole('searchbox', { name: /search saved/i }), 'docs');
      expect(screen.getByText('Docs')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /open https:\/\/blog\.example/i }),
      ).not.toBeInTheDocument();
    });

    it('filters by url (case-insensitive)', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.type(screen.getByRole('searchbox', { name: /search saved/i }), 'BLOG');
      expect(
        screen.getByRole('button', { name: /open https:\/\/blog\.example/i }),
      ).toBeInTheDocument();
      expect(screen.queryByText('Docs')).not.toBeInTheDocument();
    });

    it('clearing the query shows all items again', async () => {
      render(<SavedPanel {...props()} />);
      const box = screen.getByRole('searchbox', { name: /search saved/i });
      await userEvent.type(box, 'docs');
      expect(screen.queryByText('Docs')).toBeInTheDocument();
      await userEvent.clear(box);
      expect(screen.getByText('Docs')).toBeInTheDocument();
      expect(
        screen.getByRole('button', { name: /open https:\/\/blog\.example/i }),
      ).toBeInTheDocument();
    });

    it('shows a no-matches message when nothing matches but items exist', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.type(screen.getByRole('searchbox', { name: /search saved/i }), 'zzz-nope');
      expect(screen.getByText(/no matches/i)).toBeInTheDocument();
      expect(screen.queryByText('Docs')).not.toBeInTheDocument();
    });
  });

  describe('tags', () => {
    it('renders an items tag chips', () => {
      render(<SavedPanel {...props()} />);
      const openDocs = screen.getByRole('button', { name: /open https:\/\/docs\.example/i });
      const chips = within(openDocs).getAllByText(/reference|work/, {
        selector: '.saved-panel__chip',
      });
      expect(chips.map((c) => c.textContent)).toEqual(['reference', 'work']);
    });

    it('shows a tag filter (group "Filter saved by tag") when tagUnion is non-empty', () => {
      render(<SavedPanel {...props()} />);
      expect(screen.getByRole('group', { name: /filter saved by tag/i })).toBeInTheDocument();
    });

    it('does not show the tag filter when tagUnion is empty', () => {
      render(<SavedPanel {...props()} tagUnion={[]} />);
      expect(screen.queryByRole('group', { name: /filter saved by tag/i })).not.toBeInTheDocument();
    });

    it('clicking a tag filter chip calls setActiveTags with that tag', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      const group = screen.getByRole('group', { name: /filter saved by tag/i });
      await userEvent.click(within(group).getByRole('button', { name: /filter by tag work/i }));
      expect(p.setActiveTags).toHaveBeenCalledWith(['work']);
    });

    it('filters the list down to items carrying every active tag', () => {
      render(<SavedPanel {...props()} activeTags={['work']} />);
      // Only Docs carries the "work" tag.
      expect(screen.getByText('Docs')).toBeInTheDocument();
      expect(
        screen.queryByRole('button', { name: /open https:\/\/blog\.example/i }),
      ).not.toBeInTheDocument();
    });
  });

  describe('manual add', () => {
    it('shows the add form when the "Add a page" button is clicked', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      expect(screen.getByRole('textbox', { name: /url to save/i })).toBeInTheDocument();
    });

    it('offers the add affordance even when the list is empty', () => {
      render(<SavedPanel {...props()} items={[]} />);
      expect(screen.getByRole('button', { name: /add a page/i })).toBeInTheDocument();
    });

    it('the add form has a tag input', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      expect(screen.getByRole('combobox', { name: /add tag/i })).toBeInTheDocument();
    });

    it('saving a schemeless host calls add with https:// prepended, the title and tags', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /url to save/i }), 'example.com');
      await userEvent.type(screen.getByRole('textbox', { name: /title \(optional\)/i }), 'My Site');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.add).toHaveBeenCalledWith({ url: 'https://example.com', title: 'My Site', tags: [] });
    });

    it('saves the tags added in the form', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /url to save/i }), 'example.com');
      await userEvent.type(screen.getByRole('combobox', { name: /add tag/i }), 'fresh{Enter}');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.add).toHaveBeenCalledWith({ url: 'https://example.com', title: '', tags: ['fresh'] });
    });

    it('saves with an empty title when none is given', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /url to save/i }), 'https://docs.example/{Enter}');
      expect(p.add).toHaveBeenCalledWith({ url: 'https://docs.example/', title: '', tags: [] });
    });

    it('shows an inline error and does not call add for an invalid URL', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /url to save/i }), 'not a url');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.add).not.toHaveBeenCalled();
      expect(screen.getByRole('alert')).toBeInTheDocument();
      // The form stays open so the user can correct the input.
      expect(screen.getByRole('textbox', { name: /url to save/i })).toBeInTheDocument();
    });

    it('clicking Cancel closes the form without calling add', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.click(screen.getByRole('button', { name: /cancel/i }));
      expect(p.add).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: /url to save/i })).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: /add a page/i })).toBeInTheDocument();
    });

    it('pressing Escape in the URL field cancels the form', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /add a page/i }));
      await userEvent.type(screen.getByRole('textbox', { name: /url to save/i }), 'example.com{Escape}');
      expect(p.add).not.toHaveBeenCalled();
      expect(screen.queryByRole('textbox', { name: /url to save/i })).not.toBeInTheDocument();
    });
  });

  describe('inline edit', () => {
    it('clicking the edit button shows an input prefilled with the current title', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      const input = screen.getByRole('textbox', { name: /edit title/i });
      expect(input).toHaveValue('Docs');
    });

    it('changing the title and pressing Enter calls update with the new title and tags', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Documentation{Enter}');
      expect(p.update).toHaveBeenCalledWith(2, { title: 'Documentation', tags: ['reference', 'work'] });
    });

    it('changing the title and clicking Save calls update with the new title and tags', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Documentation');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.update).toHaveBeenCalledWith(2, { title: 'Documentation', tags: ['reference', 'work'] });
    });

    it('adding a tag in edit mode includes it in the update call', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      await userEvent.type(screen.getByRole('combobox', { name: /add tag/i }), 'urgent{Enter}');
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.update).toHaveBeenCalledWith(2, {
        title: 'Docs',
        tags: ['reference', 'work', 'urgent'],
      });
    });

    it('removing a tag in edit mode drops it from the update call', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      await userEvent.click(screen.getByRole('button', { name: /remove tag work/i }));
      await userEvent.click(screen.getByRole('button', { name: /^save$/i }));
      expect(p.update).toHaveBeenCalledWith(2, { title: 'Docs', tags: ['reference'] });
    });

    it('pressing Escape cancels without calling update', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByRole('button', { name: /^edit docs$/i }));
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Changed{Escape}');
      expect(p.update).not.toHaveBeenCalled();
      // Back to the display row.
      expect(screen.getByRole('button', { name: /open https:\/\/docs\.example/i })).toBeInTheDocument();
    });
  });

  describe('manage tags', () => {
    it('does not render the Manage tags section when tagUnion is empty', () => {
      render(<SavedPanel {...props()} tagUnion={[]} />);
      expect(screen.queryByText(/manage tags/i)).not.toBeInTheDocument();
    });

    it('renames the selected tag via the rename control', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByText(/manage tags/i));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: /tag to manage/i }), 'work');
      await userEvent.type(screen.getByRole('textbox', { name: /rename tag to/i }), 'job');
      await userEvent.click(screen.getByRole('button', { name: /rename tag/i }));
      expect(p.renameTag).toHaveBeenCalledWith('work', 'job');
    });

    it('deletes the selected tag via the delete control', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getByText(/manage tags/i));
      await userEvent.selectOptions(screen.getByRole('combobox', { name: /tag to manage/i }), 'work');
      await userEvent.click(screen.getByRole('button', { name: /delete tag/i }));
      expect(p.deleteTag).toHaveBeenCalledWith('work');
    });
  });
});
