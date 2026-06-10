// src/components/Sidebar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    open: true,
    onToggle: vi.fn(),
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    ...overrides,
  };
}

describe('Sidebar', () => {
  it('renders a toggle button reflecting the open state via aria-expanded', () => {
    render(<Sidebar {...props({ open: false })} />);
    expect(screen.getByRole('button', { name: /sidebar/i })).toHaveAttribute('aria-expanded', 'false');
  });

  it('clicking the toggle calls onToggle', async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /sidebar/i }));
    expect(p.onToggle).toHaveBeenCalledTimes(1);
  });

  it('does NOT render the panel body when closed', () => {
    render(<Sidebar {...props({ open: false })} />);
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
  });

  it('shows the History tab panel by default when open', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByTestId('history-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('saved-slot')).not.toBeInTheDocument();
  });

  it('exposes History/Saved as tabs with correct aria-selected', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('tab', { name: /history/i })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'false');
  });

  it('clicking the Saved tab switches to the saved panel', async () => {
    render(<Sidebar {...props()} />);
    await userEvent.click(screen.getByRole('tab', { name: /saved/i }));
    expect(screen.getByTestId('saved-slot')).toBeInTheDocument();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toHaveAttribute('aria-selected', 'true');
  });

  it('the open sidebar region is labelled for assistive tech', () => {
    render(<Sidebar {...props()} />);
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toBeInTheDocument();
  });
});
