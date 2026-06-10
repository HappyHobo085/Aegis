// src/components/FavoritesBar.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite } from '../../shared/types';
import { FavoritesBar } from './FavoritesBar';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Example',
  url: 'https://example.com/',
  tags: ['news'],
  position: 0,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FavoritesBar>> = {}) => ({
  favorites: [
    fav({ id: 1, name: 'Alpha', url: 'https://alpha.example/' }),
    fav({ id: 2, name: 'Beta', url: 'https://beta.example/' }),
  ],
  tagUnion: ['dev', 'news'],
  activeTags: [] as string[],
  setActiveTags: vi.fn(),
  onOpenFavorite: vi.fn(),
  onOpenManager: vi.fn(),
  ...over,
});

describe('FavoritesBar', () => {
  it('renders a chip per favorite labelled by name', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('button', { name: 'Alpha' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Beta' })).toBeInTheDocument();
  });

  it('clicking a favorite chip calls onOpenFavorite with its url', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: 'Beta' }));
    expect(p.onOpenFavorite).toHaveBeenCalledWith('https://beta.example/');
  });

  it('exposes a Manage favorites button that calls onOpenManager', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /manage favorites/i }));
    expect(p.onOpenManager).toHaveBeenCalledTimes(1);
  });

  it('renders the TagFilter internally (chips from the union)', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('button', { name: /filter by tag dev/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /filter by tag news/i })).toBeInTheDocument();
  });

  it('clicking a tag chip delegates to setActiveTags', async () => {
    const p = props();
    render(<FavoritesBar {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /filter by tag dev/i }));
    expect(p.setActiveTags).toHaveBeenCalledWith(['dev']);
  });

  it('uses a labelled toolbar/navigation landmark for the bar', () => {
    render(<FavoritesBar {...props()} />);
    expect(screen.getByRole('navigation', { name: /favorites/i })).toBeInTheDocument();
  });
});
