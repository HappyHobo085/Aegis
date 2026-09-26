// src/hooks/useDialog.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useDialog } from './useDialog';

function Dialog({ onClose }: { onClose: () => void }) {
  const ref = useDialog<HTMLDivElement>(onClose);
  return (
    <div>
      <button type="button">outside-before</button>
      <div ref={ref} role="dialog" aria-modal="true">
        <button type="button">first</button>
        <button type="button">last</button>
      </div>
    </div>
  );
}

describe('useDialog', () => {
  it('focuses the first focusable element on mount', () => {
    render(<Dialog onClose={vi.fn()} />);
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);
    await userEvent.keyboard('{Escape}');
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('traps Tab from the last element back to the first', async () => {
    render(<Dialog onClose={vi.fn()} />);
    const last = screen.getByRole('button', { name: 'last' });
    last.focus();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
  });

  it('traps Shift+Tab from the first element to the last', async () => {
    render(<Dialog onClose={vi.fn()} />);
    screen.getByRole('button', { name: 'first' }).focus();
    await userEvent.tab({ shift: true });
    expect(screen.getByRole('button', { name: 'last' })).toHaveFocus();
  });

  it('restores focus to the previously-focused element on unmount', async () => {
    const { rerender } = render(
      <div>
        <button type="button" data-testid="trigger">
          trigger
        </button>
      </div>,
    );
    const trigger = screen.getByTestId('trigger');
    trigger.focus();
    expect(trigger).toHaveFocus();
    rerender(
      <div>
        <button type="button" data-testid="trigger">
          trigger
        </button>
        <Dialog onClose={vi.fn()} />
      </div>,
    );
    expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
    rerender(
      <div>
        <button type="button" data-testid="trigger">
          trigger
        </button>
      </div>,
    );
    expect(trigger).toHaveFocus();
  });

  // BUG(F3): the `open` third argument exists precisely for dialogs that stay MOUNTED and
  // render `null` while closed. Those were capturing `document.activeElement` ONCE, at the
  // component's first render, so every open AFTER the first restored focus to a stale (or
  // already-removed) element — for a removed one, `<body>`, which makes the next Tab start
  // from the document top.
  describe('always-mounted dialogs (the `open` prop)', () => {
    function PersistentDialog({ open }: { open: boolean }) {
      const ref = useDialog<HTMLDivElement>(() => {}, {}, open);
      if (!open) return null;
      return (
        <div ref={ref} role="dialog" aria-modal="true">
          <button type="button">first</button>
          <button type="button">last</button>
        </div>
      );
    }

    it('captures the focused element on EACH open, not just the first', () => {
      const outsideA = document.createElement('button');
      outsideA.textContent = 'outside-a';
      const outsideB = document.createElement('button');
      outsideB.textContent = 'outside-b';
      document.body.append(outsideA, outsideB);

      try {
        const { rerender } = render(<PersistentDialog open={false} />);

        // Open #1 — focused element is outsideA.
        outsideA.focus();
        expect(outsideA).toHaveFocus();
        rerender(<PersistentDialog open />);
        expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
        // Close #1 — focus goes back to where it came from.
        rerender(<PersistentDialog open={false} />);
        expect(outsideA).toHaveFocus();

        // Open #2 from a DIFFERENT element. A mount-time capture would still hold
        // outsideA here and restore to the wrong place.
        outsideB.focus();
        expect(outsideB).toHaveFocus();
        rerender(<PersistentDialog open />);
        expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
        rerender(<PersistentDialog open={false} />);
        expect(outsideB).toHaveFocus();
      } finally {
        outsideA.remove();
        outsideB.remove();
      }
    });

    it('restores focus to the element focused at the LAST open, not <body>', () => {
      const trigger = document.createElement('button');
      document.body.appendChild(trigger);
      try {
        const { rerender } = render(<PersistentDialog open={false} />);
        // Mount while nothing is focused at all (body) — that is what the old mount-time
        // capture stored, forever.
        rerender(<PersistentDialog open />);
        expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
        rerender(<PersistentDialog open={false} />);

        // Now the user focuses the omnibox-ish trigger and reopens.
        trigger.focus();
        rerender(<PersistentDialog open />);
        expect(screen.getByRole('button', { name: 'first' })).toHaveFocus();
        rerender(<PersistentDialog open={false} />);
        expect(trigger).toHaveFocus();
        expect(document.body).not.toHaveFocus();
      } finally {
        trigger.remove();
      }
    });
  });
});
