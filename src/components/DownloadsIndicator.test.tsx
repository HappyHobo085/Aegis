// src/components/DownloadsIndicator.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DownloadsIndicator } from './DownloadsIndicator';

describe('DownloadsIndicator', () => {
  it('renders a button labelled Downloads', () => {
    render(<DownloadsIndicator activeCount={0} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads/i })).toBeInTheDocument();
  });

  it('shows the active-count badge when there are active downloads', () => {
    render(<DownloadsIndicator activeCount={3} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads/i })).toHaveTextContent('3');
  });

  it('does NOT show a numeric badge when there are no active downloads', () => {
    render(<DownloadsIndicator activeCount={0} onOpen={vi.fn()} />);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('reflects the active count in the accessible name', () => {
    render(<DownloadsIndicator activeCount={2} onOpen={vi.fn()} />);
    expect(screen.getByRole('button', { name: /downloads \(2 active\)/i })).toBeInTheDocument();
  });

  it('calls onOpen when clicked', async () => {
    const onOpen = vi.fn();
    render(<DownloadsIndicator activeCount={1} onOpen={onOpen} />);
    await userEvent.click(screen.getByRole('button', { name: /downloads/i }));
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
