// src/components/AllowlistTab.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

vi.mock('../lib/toast', () => ({
  confirm: vi.fn(),
}));
import { confirm } from '../lib/toast';

import { AllowlistTab } from './AllowlistTab';

const props = (over: Partial<React.ComponentProps<typeof AllowlistTab>> = {}) => ({
  hosts: ['news.example', 'shop.example'],
  removeAllowlist: vi.fn(),
  clearAllowlist: vi.fn(),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(true);
});

describe('AllowlistTab', () => {
  it('lists each allowlisted host', () => {
    render(<AllowlistTab {...props()} />);
    expect(screen.getByText('news.example')).toBeInTheDocument();
    expect(screen.getByText('shop.example')).toBeInTheDocument();
  });

  it('shows an empty-state message when there are no hosts', () => {
    render(<AllowlistTab {...props({ hosts: [] })} />);
    expect(screen.getByText(/no allowlisted hosts/i)).toBeInTheDocument();
  });

  it('removes a host via its Remove button', async () => {
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(
      screen.getByRole('button', { name: /remove news\.example from allowlist/i }),
    );
    expect(p.removeAllowlist).toHaveBeenCalledWith('news.example');
  });

  it('confirms then clears all hosts via the Clear all button', async () => {
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(confirm).toHaveBeenCalledWith('Remove all allowlisted sites?', { destructive: true });
    await waitFor(() => expect(p.clearAllowlist).toHaveBeenCalledTimes(1));
  });

  it('does NOT clear when the confirm is declined', async () => {
    (confirm as ReturnType<typeof vi.fn>).mockResolvedValue(false);
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(confirm).toHaveBeenCalled();
    // Give the rejected confirm promise a tick to settle.
    await Promise.resolve();
    expect(p.clearAllowlist).not.toHaveBeenCalled();
  });

  it('disables Clear all when the allowlist is empty', () => {
    render(<AllowlistTab {...props({ hosts: [] })} />);
    expect(screen.getByRole('button', { name: /clear all/i })).toBeDisabled();
  });
});
