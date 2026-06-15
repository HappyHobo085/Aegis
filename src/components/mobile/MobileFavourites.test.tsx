import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi } from 'vitest';
import { MobileFavourites } from './MobileFavourites';
import type { Favorite } from '../../../shared/types';

const favs: Favorite[] = [
  { id: 1, name: 'Home', url: 'https://home.test/', position: 0 },
  { id: 2, name: 'News', url: 'https://news.test/', position: 1 },
];

describe('MobileFavourites', () => {
  it('renders a chip per favourite and opens on tap', () => {
    const onOpen = vi.fn();
    render(<MobileFavourites favorites={favs} onOpen={onOpen} />);
    fireEvent.click(screen.getByRole('button', { name: 'News' }));
    expect(onOpen).toHaveBeenCalledWith('https://news.test/');
  });
  it('renders nothing when there are no favourites', () => {
    const { container } = render(<MobileFavourites favorites={[]} onOpen={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });
});
