// src/components/FavoritesManager.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Favorite } from '../../shared/types';
import { FavoritesManager } from './FavoritesManager';

const fav = (over: Partial<Favorite> = {}): Favorite => ({
  id: 1,
  name: 'Alpha',
  url: 'https://alpha.example/',
  position: 0,
  ...over,
});

const props = (over: Partial<React.ComponentProps<typeof FavoritesManager>> = {}) => ({
  favorites: [
    fav({ id: 1, name: 'Alpha', url: 'https://alpha.example/' }),
    fav({ id: 2, name: 'Beta', url: 'https://beta.example/' }),
  ],
  onClose: vi.fn(),
  add: vi.fn(async () => {}),
  update: vi.fn(async () => {}),
  remove: vi.fn(async () => {}),
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
    await userEvent.type(
      screen.getByRole('textbox', { name: /new favorite url/i }),
      'https://gamma.example/',
    );
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(p.add).toHaveBeenCalledWith({ name: 'Gamma', url: 'https://gamma.example/' });
  });

  it('shows an inline error and does not add when the name is blank', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    // Fill only the URL — leave the name empty.
    await userEvent.type(
      screen.getByRole('textbox', { name: /new favorite url/i }),
      'https://gamma.example/',
    );
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(p.add).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a name/i);
  });

  it('shows an inline error and does not add when the URL is invalid', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite name/i }), 'Gamma');
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite url/i }), 'not a url');
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(p.add).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });

  it('clears the add error once the user edits a field', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    expect(screen.getByRole('alert')).toBeInTheDocument();
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite name/i }), 'G');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('normalizes a schemeless URL when adding a favorite', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite name/i }), 'Gamma');
    await userEvent.type(screen.getByRole('textbox', { name: /new favorite url/i }), 'gamma.example');
    await userEvent.click(screen.getByRole('button', { name: /^add favorite$/i }));
    // normalizeSavedUrl prepends https:// to a schemeless host (no re-serialization).
    expect(p.add).toHaveBeenCalledWith({ name: 'Gamma', url: 'https://gamma.example' });
  });

  it('blocks an edit-save with a blank name and shows an inline error', async () => {
    const p = props();
    render(<FavoritesManager {...p} />);
    const nameField = screen.getByRole('textbox', { name: /name for alpha/i });
    await userEvent.clear(nameField);
    await userEvent.click(screen.getByRole('button', { name: /save favorite alpha/i }));
    expect(p.update).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(/enter a name/i);
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
    expect(p.update).toHaveBeenCalledWith(1, { name: 'Alpha 2', url: 'https://alpha.example/' });
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
