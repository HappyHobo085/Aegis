import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTopBar } from './MobileTopBar';

function setup(over = {}) {
  const props = {
    url: 'https://example.com/',
    isLoading: false,
    onNavigate: vi.fn(),
    onReloadOrStop: vi.fn(),
    bottomBarHidden: false,
    onToggleBottomBar: vi.fn(),
    ...over,
  };
  render(<MobileTopBar {...props} />);
  return props;
}

describe('MobileTopBar', () => {
  it('shows a reload button that becomes stop while loading', () => {
    setup({ isLoading: false });
    expect(screen.getByRole('button', { name: /reload/i })).toBeInTheDocument();
  });
  it('shows stop while loading and fires onReloadOrStop', () => {
    const p = setup({ isLoading: true });
    const stop = screen.getByRole('button', { name: /stop/i });
    fireEvent.click(stop);
    expect(p.onReloadOrStop).toHaveBeenCalled();
  });
  it('shows a "Hide toolbar" toggle that fires onToggleBottomBar', () => {
    const p = setup({ bottomBarHidden: false });
    fireEvent.click(screen.getByRole('button', { name: /hide toolbar/i }));
    expect(p.onToggleBottomBar).toHaveBeenCalled();
  });
  it('flips the toggle to "Show toolbar" when the bottom bar is hidden', () => {
    setup({ bottomBarHidden: true });
    expect(screen.getByRole('button', { name: /show toolbar/i })).toBeInTheDocument();
  });
  it('renders the inline shield when provided', () => {
    const shield = (
      <button type="button" aria-label="Ad blocking">
        shield
      </button>
    );
    setup({ inlineShield: shield });
    expect(screen.getByRole('button', { name: /ad blocking/i })).toBeInTheDocument();
  });
});
