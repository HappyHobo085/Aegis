import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { RedirectBar } from './RedirectBar';

describe('RedirectBar', () => {
  beforeEach(() => cleanup());

  const redirect = { viewId: 1, from: 'https://streamex.to/', to: 'https://google.com/path?x=1' };

  it('shows the destination host (not the full URL)', () => {
    render(<RedirectBar redirect={redirect} onOpenAnyway={vi.fn()} onDismiss={vi.fn()} />);
    expect(screen.getByText('google.com')).toBeTruthy();
  });

  it('fires Open anyway and Dismiss', async () => {
    const onOpen = vi.fn();
    const onDismiss = vi.fn();
    render(<RedirectBar redirect={redirect} onOpenAnyway={onOpen} onDismiss={onDismiss} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open anyway' }));
    expect(onOpen).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
