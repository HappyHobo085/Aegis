// src/components/SavedPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { SavedItem } from '../../shared/types';

import { SavedPanel } from './SavedPanel';

const items: SavedItem[] = [
  { id: 2, url: 'https://docs.example/', title: 'Docs', savedAt: 1_700_000_000_000 },
  { id: 1, url: 'https://blog.example/', title: '', savedAt: 1_600_000_000_000 },
];

function props() {
  return {
    items,
    remove: vi.fn(async () => [] as SavedItem[]),
    update: vi.fn(),
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

  describe('inline edit', () => {
    it('clicking the edit button shows an input prefilled with the current title', async () => {
      render(<SavedPanel {...props()} />);
      await userEvent.click(screen.getAllByRole('button', { name: /edit title/i })[0]);
      const input = screen.getByRole('textbox', { name: /edit title/i });
      expect(input).toHaveValue('Docs');
    });

    it('changing the title and pressing Enter calls update with the new title', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getAllByRole('button', { name: /edit title/i })[0]);
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Documentation{Enter}');
      expect(p.update).toHaveBeenCalledWith(2, 'Documentation');
    });

    it('changing the title and clicking Save calls update with the new title', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getAllByRole('button', { name: /edit title/i })[0]);
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Documentation');
      await userEvent.click(screen.getByRole('button', { name: /save title/i }));
      expect(p.update).toHaveBeenCalledWith(2, 'Documentation');
    });

    it('pressing Escape cancels without calling update', async () => {
      const p = props();
      render(<SavedPanel {...p} />);
      await userEvent.click(screen.getAllByRole('button', { name: /edit title/i })[0]);
      const input = screen.getByRole('textbox', { name: /edit title/i });
      await userEvent.clear(input);
      await userEvent.type(input, 'Changed{Escape}');
      expect(p.update).not.toHaveBeenCalled();
      // Back to the display row.
      expect(screen.getByRole('button', { name: /open https:\/\/docs\.example/i })).toBeInTheDocument();
    });
  });
});
