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
});
