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
});
