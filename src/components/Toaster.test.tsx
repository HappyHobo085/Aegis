// src/components/Toaster.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Toaster } from './Toaster';
import { toast, __resetToasts } from '../lib/toast';

beforeEach(() => {
  __resetToasts();
  cleanup();
});

describe('Toaster', () => {
  it('renders an aria-live region', () => {
    render(<Toaster />);
    const region = screen.getByRole('status');
    expect(region).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a success toast when toast.success is called', async () => {
    render(<Toaster />);
    act(() => toast.success('Saved!'));
    await waitFor(() => expect(screen.getByText('Saved!')).toBeInTheDocument());
  });

  it('shows an error toast when toast.error is called', async () => {
    render(<Toaster />);
    act(() => toast.error('Boom'));
    await waitFor(() => expect(screen.getByText('Boom')).toBeInTheDocument());
  });

  it('shows an info toast when toast.info is called', async () => {
    render(<Toaster />);
    act(() => toast.info('FYI'));
    await waitFor(() => expect(screen.getByText('FYI')).toBeInTheDocument());
    const toastEl = screen.getByText('FYI').closest('.toast');
    expect(toastEl).toHaveClass('toast--info');
  });
});

describe('Toaster action', () => {
  beforeEach(() => {
    __resetToasts();
    cleanup();
  });

  it('renders the action button and fires onClick', async () => {
    render(<Toaster />);
    const onClick = vi.fn();
    toast.info('Blocked a redirect to evil.com', { action: { label: 'Open anyway', onClick } });
    const btn = await screen.findByRole('button', { name: 'Open anyway' });
    await userEvent.click(btn);
    expect(onClick).toHaveBeenCalledOnce();
  });
});
