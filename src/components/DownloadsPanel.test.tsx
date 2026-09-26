// src/components/DownloadsPanel.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DownloadEntry } from '../../shared/types';
import { DownloadsPanel } from './DownloadsPanel';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
}));
import { confirm } from '../lib/toast';

const entry = (over: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id: 1,
  url: 'https://example.com/file.zip',
  filename: 'file.zip',
  savePath: '/home/u/Downloads/file.zip',
  state: 'completed',
  receivedBytes: 1024,
  totalBytes: 1024,
  startedAt: 1000,
  ...over,
});

function props(over: Partial<React.ComponentProps<typeof DownloadsPanel>> = {}) {
  return {
    downloads: [] as DownloadEntry[],
    remove: vi.fn(),
    clear: vi.fn(),
    openFile: vi.fn(),
    showInFolder: vi.fn(),
    cancel: vi.fn(),
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('DownloadsPanel', () => {
  it('renders an empty message when there are no downloads', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument();
  });

  it('is labelled as a Downloads group for assistive tech', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByRole('group', { name: /downloads/i })).toBeInTheDocument();
  });

  it('lists each download by filename with its host', () => {
    render(<DownloadsPanel {...props({ downloads: [entry()] })} />);
    expect(screen.getByText('file.zip')).toBeInTheDocument();
    // The host, not the full URL — the filename and size carry the detail.
    expect(screen.getByText('example.com')).toBeInTheDocument();
  });

  it('shows "received of total" while progressing and just the total once done', () => {
    const { unmount } = render(
      <DownloadsPanel
        {...props({
          downloads: [entry({ state: 'progressing', receivedBytes: 1536, totalBytes: 4_500_000 })],
        })}
      />,
    );
    expect(screen.getByText('1.5 KB of 4.3 MB')).toBeInTheDocument();
    unmount();
    render(
      <DownloadsPanel
        {...props({ downloads: [entry({ state: 'completed', totalBytes: 4_500_000 })] })}
      />,
    );
    expect(screen.getByText('4.3 MB')).toBeInTheDocument();
  });

  it('folds long lists to five rows behind a Show all toggle', async () => {
    const many = Array.from({ length: 8 }, (_, i) => entry({ id: i + 1, filename: `f${i}.zip` }));
    render(<DownloadsPanel {...props({ downloads: many })} />);
    expect(screen.getByRole('button', { name: /show all 8 downloads/i })).toBeInTheDocument();
    // Only the first five rows are rendered while folded.
    expect(screen.getByText('f4.zip')).toBeInTheDocument();
    expect(screen.queryByText('f5.zip')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /show all 8 downloads/i }));
    expect(screen.getByText('f7.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /show less/i })).toBeInTheDocument();
  });

  it('does not offer the fold when the list is short', () => {
    render(<DownloadsPanel {...props({ downloads: [entry({ id: 1 }), entry({ id: 2 })] })} />);
    expect(screen.queryByRole('button', { name: /show all/i })).not.toBeInTheDocument();
  });

  it('shows Open file / Show in folder for a completed download and calls the handlers', async () => {
    const p = props({ downloads: [entry({ id: 7, state: 'completed' })] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /open file file\.zip/i }));
    await userEvent.click(screen.getByRole('button', { name: /show file\.zip in folder/i }));
    expect(p.openFile).toHaveBeenCalledWith(7);
    expect(p.showInFolder).toHaveBeenCalledWith(7);
  });

  it('shows a Cancel action for a progressing download, confirms, then calls cancel', async () => {
    const p = props({
      downloads: [entry({ id: 3, state: 'progressing', receivedBytes: 500, totalBytes: 1000 })],
    });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel file\.zip/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.cancel).toHaveBeenCalledWith(3);
  });

  it('does NOT cancel a download when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props({
      downloads: [entry({ id: 3, state: 'progressing', receivedBytes: 500, totalBytes: 1000 })],
    });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /cancel file\.zip/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.cancel).not.toHaveBeenCalled();
  });

  it('maps each raw state to a friendly label', () => {
    const cases: Array<[DownloadEntry['state'], string]> = [
      ['progressing', 'Downloading'],
      ['completed', 'Completed'],
      ['interrupted', 'Failed'],
      ['cancelled', 'Cancelled'],
    ];
    for (const [state, label] of cases) {
      const { unmount } = render(<DownloadsPanel {...props({ downloads: [entry({ state })] })} />);
      expect(screen.getByText(label)).toBeInTheDocument();
      // Never the raw enum value.
      expect(screen.queryByText(state)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('gives failed/cancelled states the error className', () => {
    const { container, unmount } = render(
      <DownloadsPanel {...props({ downloads: [entry({ state: 'interrupted' })] })} />,
    );
    expect(container.querySelector('.downloads-panel__state--error')).toBeTruthy();
    unmount();

    const cancelled = render(
      <DownloadsPanel {...props({ downloads: [entry({ state: 'cancelled' })] })} />,
    );
    expect(cancelled.container.querySelector('.downloads-panel__state--error')).toBeTruthy();
    cancelled.unmount();

    // A completed download is NOT an error.
    const ok = render(
      <DownloadsPanel {...props({ downloads: [entry({ state: 'completed' })] })} />,
    );
    expect(ok.container.querySelector('.downloads-panel__state--error')).toBeNull();
  });

  it('does NOT offer Cancel for a completed download', () => {
    render(<DownloadsPanel {...props({ downloads: [entry({ state: 'completed' })] })} />);
    expect(screen.queryByRole('button', { name: /cancel file\.zip/i })).not.toBeInTheDocument();
  });

  it('renders a progress bar reflecting received/total for a progressing download', () => {
    render(
      <DownloadsPanel
        {...props({
          downloads: [entry({ state: 'progressing', receivedBytes: 250, totalBytes: 1000 })],
        })}
      />,
    );
    const bar = screen.getByRole('progressbar', { name: /file\.zip download progress/i });
    expect(bar).toHaveAttribute('aria-valuenow', '25');
  });

  it('removes a download via its remove button', async () => {
    const p = props({ downloads: [entry({ id: 9 })] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove file\.zip/i }));
    expect(p.remove).toHaveBeenCalledWith(9);
  });

  it('Clear all confirms then clears, and is disabled when empty', async () => {
    const p = props({ downloads: [entry()] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all downloads/i }));
    expect(confirm).toHaveBeenCalled();
    expect(p.clear).toHaveBeenCalledTimes(1);
  });

  it('does NOT clear when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props({ downloads: [entry()] });
    render(<DownloadsPanel {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all downloads/i }));
    expect(p.clear).not.toHaveBeenCalled();
  });

  it('disables Clear all when there are no downloads', () => {
    render(<DownloadsPanel {...props()} />);
    expect(screen.getByRole('button', { name: /clear all downloads/i })).toBeDisabled();
  });
});
