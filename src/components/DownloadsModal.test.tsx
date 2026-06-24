// src/components/DownloadsModal.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadsModal } from './DownloadsModal';
import type { DownloadEntry } from '../../shared/types';

function makeEntry(overrides: Partial<DownloadEntry> = {}): DownloadEntry {
  return {
    id: 1,
    url: 'https://example.com/file.zip',
    filename: 'file.zip',
    state: 'completed',
    receivedBytes: 100,
    totalBytes: 100,
    savePath: '/tmp/file.zip',
    startedAt: 0,
    ...overrides,
  } as DownloadEntry;
}

function props(overrides: Partial<React.ComponentProps<typeof DownloadsModal>> = {}) {
  return {
    onClose: vi.fn(),
    downloads: [] as DownloadEntry[],
    remove: vi.fn(),
    clear: vi.fn(),
    openFile: vi.fn(),
    showInFolder: vi.fn(),
    cancel: vi.fn(),
    ...overrides,
  };
}

describe('DownloadsModal', () => {
  it('renders a labelled modal dialog', () => {
    render(<DownloadsModal {...props()} />);
    const dialog = screen.getByRole('dialog', { name: /downloads/i });
    expect(dialog).toBeInTheDocument();
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(screen.getByRole('heading', { name: /downloads/i })).toBeInTheDocument();
  });

  it('renders the downloads panel content (empty state)', () => {
    render(<DownloadsModal {...props()} />);
    expect(screen.getByText(/no downloads yet/i)).toBeInTheDocument();
  });

  it('renders the downloads panel content (a download row)', () => {
    render(<DownloadsModal {...props({ downloads: [makeEntry()] })} />);
    expect(screen.getByText('file.zip')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /open file file\.zip/i })).toBeInTheDocument();
  });

  it('the close button calls onClose', async () => {
    const p = props();
    render(<DownloadsModal {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('pressing Escape calls onClose', async () => {
    const p = props();
    render(<DownloadsModal {...p} />);
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the scrim/backdrop calls onClose', async () => {
    const p = props();
    const { container } = render(<DownloadsModal {...p} />);
    const scrim = container.querySelector('.downloads-modal__scrim') as HTMLElement;
    await userEvent.click(scrim);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking inside the dialog card does NOT close it (no bubble to scrim)', async () => {
    const p = props();
    render(<DownloadsModal {...p} />);
    // Click the heading inside the card — should not bubble to the scrim.
    await userEvent.click(screen.getByRole('heading', { name: /downloads/i }));
    expect(p.onClose).not.toHaveBeenCalled();
  });
});
