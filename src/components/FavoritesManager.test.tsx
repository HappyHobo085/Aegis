// src/components/FavoritesManager.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite } from '../../shared/types';
import { FavoritesManager } from './FavoritesManager';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Alpha',
  url: 'https://alpha.example/',
  tags: ['news'],
  position: 0,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FavoritesManager>> = {}) => ({
  favorites: [
    fav({ id: 1, name: 'Alpha', url: 'https://alpha.example/', tags: ['news'] }),
    fav({ id: 2, name: 'Beta', url: 'https://beta.example/', tags: ['dev'] }),
  ],
  tagUnion: ['dev', 'news'],
  onClose: vi.fn(),
  add: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
  renameTag: vi.fn(async () => {}),
  deleteTag: vi.fn(async () => {}),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('FavoritesManager', () => {
  it('renders as a modal dialog with an accessible name', () => {
    render(<FavoritesManager {...props()} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    expect(dialog).toHaveAccessibleName(/favorites/i);
  });

  it('lists existing favorites by name', () => {
    render(<FavoritesManager {...props()} />);
    expect(screen.getByText('Alpha')).toBeInTheDocument();
    expect(screen.getByText('Beta')).toBeInTheDocument();
  });

  it('adds a favorite from the add form', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite name/i }), 'Gamma');
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite url/i }), 'https://gamma.example/');
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(p.add).toHaveBeenCalledWith({ name: 'Gamma', url: 'https://gamma.example/', tags: [] });
  });

  it('removes a favorite via its row Remove button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /remove favorite alpha/i }));
    expect(p.remove).toHaveBeenCalledWith(1);
  });

  it('edits a favorite name via its row Save button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const nameField = screen.getByRole('textbox', { name: /name for alpha/i });
    await userEvent.clear(nameField);
    await userEvent.type(nameField, 'Alpha 2');
    await userEvent.click(screen.getByRole('button', { name: /save favorite alpha/i }));
    expect(p.update).toHaveBeenCalledWith(1, { name: 'Alpha 2', url: 'https://alpha.example/', tags: ['news'] });
  });

  it('renames a tag globally via the tag-management controls', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const section = screen.getByRole('group', { name: /manage tags/i });
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: /tag to manage/i }), 'dev');
    await userEvent.type(within(section).getByRole('textbox', { name: /rename tag to/i }), 'engineering');
    await userEvent.click(within(section).getByRole('button', { name: /^rename tag$/i }));
    expect(p.renameTag).toHaveBeenCalledWith('dev', 'engineering');
  });

  it('deletes a tag globally via the tag-management controls', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const section = screen.getByRole('group', { name: /manage tags/i });
    await userEvent.selectOptions(within(section).getByRole('combobox', { name: /tag to manage/i }), 'news');
    await userEvent.click(within(section).getByRole('button', { name: /^delete tag$/i }));
    expect(p.deleteTag).toHaveBeenCalledWith('news');
  });

  it('closes on Escape and on the Close button', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^close$/i }));
    expect(p.onClose).toHaveBeenCalledTimes(1);
    p.onClose.mockClear();
    await userEvent.keyboard('{Escape}');
    expect(p.onClose).toHaveBeenCalledTimes(1);
  });
});
