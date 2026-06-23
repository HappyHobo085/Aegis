// src/components/AllowlistTab.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AllowlistTab } from './AllowlistTab';

const props = (over: Partial<React.ComponentProps<typeof AllowlistTab>> = {}) => ({
  hosts: ['news.example', 'shop.example'],
  removeAllowlist: vi.fn(),
  clearAllowlist: vi.fn(),
  ...over,
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

  it('clears all hosts via the Clear all button', async () => {
    const p = props();
    render(<AllowlistTab {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /clear all/i }));
    expect(p.clearAllowlist).toHaveBeenCalledTimes(1);
  });

  it('disables Clear all when the allowlist is empty', () => {
    render(<AllowlistTab {...props({ hosts: [] })} />);
    expect(screen.getByRole('button', { name: /clear all/i })).toBeDisabled();
  });
});
