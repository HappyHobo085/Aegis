import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileTopBar } from './MobileTopBar';
import type { Favorite } from '../../../shared/types';

const favs: Favorite[] = [{ id: 1, name: 'Home', url: 'https://home.test/', position: 0 }];

function setup(over = {}) {
  const props = {
    url: 'https://example.com/', isLoading: false,
    onNavigate: vi.fn(), onReloadOrStop: vi.fn(),
    favorites: favs, onOpenFavourite: vi.fn(),
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
  it('renders the favourites strip', () => {
    const p = setup();
    fireEvent.click(screen.getByRole('button', { name: 'Home' }));
    expect(p.onOpenFavourite).toHaveBeenCalledWith('https://home.test/');
  });
});
