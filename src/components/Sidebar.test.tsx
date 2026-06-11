// src/components/Sidebar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Sidebar } from './Sidebar';

function props(overrides: Partial<React.ComponentProps<typeof Sidebar>> = {}) {
  return {
    open: true,
    onClose: vi.fn(),
    history: <div data-testid="history-slot">history</div>,
    saved: <div data-testid="saved-slot">saved</div>,
    ...overrides,
  };
}

describe('Sidebar', () => {
  it('renders nothing when closed (no panel, no scrim, no tabs)', () => {
    const { container } = render(<Sidebar {...props({ open: false })} />);
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByTestId('history-slot')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByRole('complementary')).not.toBeInTheDocument();
  });

  it('renders the scrim and the right panel when open', () => {
    const { container } = render(<Sidebar {...props()} />);
    expect(container.querySelector('.sidebar__scrim')).toBeInTheDocument();
    expect(screen.getByRole('complementary', { name: /sidebar/i })).toHaveClass(
      'sidebar__panel',
    );
  });

  it('clicking the scrim calls onClose', async () => {
    const p = props();
    const { container } = render(<Sidebar {...p} />);
    const scrim = container.querySelector('.sidebar__scrim') as HTMLElement;
    await userEvent.click(scrim);
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('clicking the close button calls onClose', async () => {
    const p = props();
    render(<Sidebar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /close sidebar/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });

  it('does NOT render an internal toggle button', () => {
    render(<Sidebar {...props()} />);
    expect(screen.queryByRole('button', { name: /toggle sidebar/i })).not.toBeInTheDocument();
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

  it('exposes exactly two tabs (History, Saved) and no Downloads tab', () => {
    render(<Sidebar {...props()} />);
    const tabs = screen.getAllByRole('tab');
    expect(tabs).toHaveLength(2);
    expect(screen.getByRole('tab', { name: /history/i })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /saved/i })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: /downloads/i })).not.toBeInTheDocument();
  });
});
