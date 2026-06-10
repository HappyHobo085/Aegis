// src/components/HistoryPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoryEntry } from '../../shared/types';

const confirmMock = vi.fn();
vi.mock('../lib/toast', () => ({
  confirm: (...a: any[]) => confirmMock(...a),
}));

import { HistoryPanel } from './HistoryPanel';

const entries: HistoryEntry[] = [
  { id: 2, url: 'https://b.example/', title: 'Beta', visitedAt: 1_700_000_000_000 },
  { id: 1, url: 'https://a.example/', title: '', visitedAt: 1_600_000_000_000 },
];

function props() {
  return {
    entries,
    query: '',
    setQuery: vi.fn(),
    search: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onOpen: vi.fn(),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  confirmMock.mockResolvedValue(true);
});

describe('HistoryPanel', () => {
  it('renders a list of history entries with their titles', () => {
    render(<HistoryPanel {...props()} />);
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('falls back to the URL as the label when an entry has no title', () => {
    render(<HistoryPanel {...props()} />);
    expect(screen.getByRole('button', { name: /open https:\/\/a\.example/i })).toBeInTheDocument();
  });

  it('shows a localized timestamp for each entry', () => {
    render(<HistoryPanel {...props()} />);
    const expected = new Date(1_700_000_000_000).toLocaleString();
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('clicking an entry calls onOpen with its url', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open https:\/\/b\.example/i }));
    expect(p.onOpen).toHaveBeenCalledWith('https://b.example/');
  });

  it('typing in the search box updates the query and submitting searches', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    const box = screen.getByRole('searchbox', { name: /search history/i });
    await userEvent.type(box, 'b{Enter}');
    expect(p.setQuery).toHaveBeenCalled();
    expect(p.search).toHaveBeenCalled();
  });

  it('clicking a row remove button calls remove with the entry id', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove beta/i }));
    expect(p.remove).toHaveBeenCalledWith(2);
  });

  it('Clear all asks for confirmation then calls clear', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all history/i }));
    expect(confirmMock).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('Clear all does NOT clear when confirmation is declined', async () => {
    confirmMock.mockResolvedValue(false);
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all history/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('shows an empty-state message when there are no entries', () => {
    render(<HistoryPanel {...props()} entries={[]} />);
    expect(screen.getByText(/no history/i)).toBeInTheDocument();
  });
});
