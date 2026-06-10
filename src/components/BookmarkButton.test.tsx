// src/components/BookmarkButton.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BookmarkButton } from './BookmarkButton';

const props = (over: Partial<React.ComponentProps<typeof BookmarkButton>> = {}) => ({
  saved: false,
  canSave: true,
  onSave: vi.fn(),
  onUnsave: vi.fn(),
  ...over,
});

describe('BookmarkButton', () => {
  it('renders a button with an accessible bookmark name', () => {
    render(<BookmarkButton {...props()} />);
    expect(screen.getByRole('button', { name: /save|bookmark/i })).toBeInTheDocument();
  });

  it('when not saved, exposes aria-pressed=false and calls onSave on click', async () => {
    const p = props({ saved: false });
    render(<BookmarkButton {...p} />);
    const btn = screen.getByRole('button', { name: /save|bookmark/i });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(btn);
    expect(p.onSave).toHaveBeenCalledTimes(1);
    expect(p.onUnsave).not.toHaveBeenCalled();
  });

  it('when saved, exposes aria-pressed=true (filled-in) and calls onUnsave on click', async () => {
    const p = props({ saved: true });
    render(<BookmarkButton {...p} />);
    const btn = screen.getByRole('button', { name: /save|bookmark/i });
    expect(btn).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(btn);
    expect(p.onUnsave).toHaveBeenCalledTimes(1);
    expect(p.onSave).not.toHaveBeenCalled();
  });

  it('is disabled when canSave is false (e.g. no parseable host)', () => {
    render(<BookmarkButton {...props({ canSave: false })} />);
    expect(screen.getByRole('button', { name: /save|bookmark/i })).toBeDisabled();
  });

  it('does not fire callbacks when disabled', async () => {
    const p = props({ canSave: false });
    render(<BookmarkButton {...p} />);
    await userEvent.click(screen.getByRole('button', { name: /save|bookmark/i }));
    expect(p.onSave).not.toHaveBeenCalled();
    expect(p.onUnsave).not.toHaveBeenCalled();
  });
});
