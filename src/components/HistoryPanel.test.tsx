// src/components/HistoryPanel.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { HistoryEntry } from '../../shared/types';

const confirmMock = vi.fn();
vi.mock('../lib/toast', () => ({
  confirm: (...a: any[]) => confirmMock(...a),
}));

import { HistoryPanel } from './HistoryPanel';
import { formatRelativeTime } from '../lib/format';

const HOUR = 3_600_000;
const DAY = 86_400_000;

// A FIXED instant, not `Date.now()`.
//
// Relative-to-now was the original intent — a hard-coded epoch lands every fixture in one
// bucket and makes the grouping assertions meaningless — but it was still time-of-day flaky:
// `now - 2 * HOUR` expects the "Today" bucket, so any run between local midnight and 02:00 put
// that row in "Yesterday" and the test failed. It did exactly that on a 01:20 run.
//
// 2026-01-15 is a local Thursday noon: minus 2 h is still Thursday (Today), and minus 3 days
// is the preceding Monday, comfortably inside "Earlier this week" with no boundary nearby.
const FIXED_NOW = new Date(2026, 0, 15, 12, 0, 0).getTime();
const now = FIXED_NOW;
const entries: HistoryEntry[] = [
  { id: 2, url: 'https://b.example/', title: 'Beta', visitedAt: now - 2 * HOUR },
  { id: 1, url: 'https://a.example/', title: '', visitedAt: now - 3 * DAY },
];

type PanelProps = React.ComponentProps<typeof HistoryPanel>;

function props(overrides: Partial<PanelProps> = {}): PanelProps {
  return {
    entries,
    query: '',
    setQuery: vi.fn(),
    search: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    clear: vi.fn(async () => {}),
    onOpen: vi.fn(),
    ...overrides,
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

  it('shows the host and a relative time for each entry', () => {
    render(<HistoryPanel {...props()} />);
    // The full URL and the locale timestamp are gone: the host identifies the
    // site and the age is what people scan for.
    expect(screen.getByText('b.example')).toBeInTheDocument();
    expect(screen.getByText(formatRelativeTime(entries[0].visitedAt))).toBeInTheDocument();
    expect(screen.queryByText('https://b.example/')).not.toBeInTheDocument();
  });

  it('groups entries under day-bucket headers, newest group first', () => {
    // The panel buckets by the LOCAL calendar day, so the system clock has to agree with the
    // fixtures above. Without this the test only passes when it runs outside 00:00–02:00.
    vi.setSystemTime(FIXED_NOW);
    try {
      render(<HistoryPanel {...props()} />);
      const headers = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
      expect(headers).toEqual(['Today', 'Earlier this week']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('announces the result count while filtering', () => {
    render(<HistoryPanel {...props({ query: 'beta' })} />);
    expect(screen.getByRole('status')).toHaveTextContent('2 results for “beta”');
  });

  it('searches as you type after the debounce', async () => {
    const p = props();
    render(<HistoryPanel {...p} />);
    await userEvent.type(screen.getByRole('searchbox', { name: /search history/i }), 'x');
    expect(p.search).not.toHaveBeenCalled();
    await waitFor(() => expect(p.search).toHaveBeenCalled(), { timeout: 1000 });
  });

  it('offers a way to clear an active search', async () => {
    const p = props({ query: 'beta' });
    render(<HistoryPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear history search/i }));
    expect(p.setQuery).toHaveBeenCalledWith('');
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
