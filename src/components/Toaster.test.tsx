// src/components/Toaster.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen, act, waitFor } from '@testing-library/react';
import { Toaster } from './Toaster';
import { toast, __resetToasts } from '../lib/toast';

beforeEach(() => {
  __resetToasts();
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
});
