// src/components/ConfirmDialog.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';
import { confirm, registerConfirmHandler, __resetToasts } from '../lib/toast';
import * as toastLib from '../lib/toast';

beforeEach(() => {
  __resetToasts();
});

afterEach(() => {
  // Ensure handler is cleaned up after each test
  registerConfirmHandler(null);
});

describe('ConfirmDialog', () => {
  it('dialog does not appear until confirm() is called', () => {
    render(<ConfirmDialog />);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('dialog appears with the message when confirm() is called', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Are you sure?'));
    await screen.findByRole('dialog');
    expect(screen.getByText('Are you sure?')).toBeInTheDocument();
  });

  it('clicking OK resolves the promise to true and closes the dialog', async () => {
    render(<ConfirmDialog />);
    let result: boolean | undefined;
    act(() => {
      void confirm('Delete?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /^ok$/i }));
    expect(result).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking Cancel resolves the promise to false and closes the dialog', async () => {
    render(<ConfirmDialog />);
    let result: boolean | undefined;
    act(() => {
      void confirm('Delete?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(result).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('pressing Escape resolves the promise to false and closes the dialog', async () => {
    render(<ConfirmDialog />);
    let result: boolean | undefined;
    act(() => {
      void confirm('Delete?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    await userEvent.keyboard('{Escape}');
    expect(result).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('lands initial focus on the SAFE choice (Cancel), not the affirmative default', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Focus me safely?'));
    await screen.findByRole('dialog');
    // Cancel (the safe choice) should have focus on open so a stray Enter can't fire OK.
    expect(screen.getByRole('button', { name: /^cancel$/i })).toHaveFocus();
  });

  it('focus is trapped inside the dialog', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Trapped?'));
    await screen.findByRole('dialog');
    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    const cancelBtn = screen.getByRole('button', { name: /^cancel$/i });
    // Cancel (last focusable) has focus on open; Tab wraps back to OK (first).
    expect(cancelBtn).toHaveFocus();
    await userEvent.tab();
    expect(okBtn).toHaveFocus();
  });

  it('clicking the scrim/backdrop cancels (resolves false) and closes the dialog', async () => {
    const { container } = render(<ConfirmDialog />);
    let result: boolean | undefined;
    act(() => {
      void confirm('Backdrop?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    const scrim = container.querySelector('.confirm-dialog__scrim') as HTMLElement;
    await userEvent.click(scrim);
    expect(result).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking inside the dialog card does NOT close it (no bubble to scrim)', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Inside click?'));
    const dialog = await screen.findByRole('dialog');
    // Click the message text inside the card — should stay open.
    await userEvent.click(screen.getByText('Inside click?'));
    expect(dialog).toBeInTheDocument();
  });

  it('promise resolves exactly once even if Escape fires then Cancel is clicked', async () => {
    render(<ConfirmDialog />);
    const calls: boolean[] = [];
    act(() => {
      void confirm('Once only?').then((v) => {
        calls.push(v);
      });
    });
    await screen.findByRole('dialog');
    // Fire Escape — dialog should close and promise resolves
    await userEvent.keyboard('{Escape}');
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(false);
    // Dialog is now gone; no second resolution should happen
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(calls).toHaveLength(1);
  });

  // Regression: under React StrictMode (dev), state updaters are double-invoked to
  // surface impurity. The resolve/close updater must be PURE (no side effects that
  // change its return across invocations), or the dialog fails to close in dev.
  it('clicking OK closes the dialog under StrictMode (dev double-invoke)', async () => {
    render(
      <StrictMode>
        <ConfirmDialog />
      </StrictMode>,
    );
    let result: boolean | undefined;
    act(() => {
      void confirm('Clear all history?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /^ok$/i }));
    expect(result).toBe(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('clicking Cancel closes the dialog under StrictMode (dev double-invoke)', async () => {
    render(
      <StrictMode>
        <ConfirmDialog />
      </StrictMode>,
    );
    let result: boolean | undefined;
    act(() => {
      void confirm('Clear all history?').then((v) => {
        result = v;
      });
    });
    await screen.findByRole('dialog');
    await userEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(result).toBe(false);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('non-destructive (default): the OK button has no danger class', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Plain confirm'));
    await screen.findByRole('dialog');
    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    expect(okBtn).not.toHaveClass('confirm-dialog__confirm--danger');
  });

  it('destructive: the OK button gets the danger class when the handler is flagged', async () => {
    // The public confirm(message) wrapper forwards only the message, but ConfirmDialog
    // registers a handler that also accepts a `destructive` flag. Capture that handler
    // and drive it directly with destructive=true to exercise the danger-styling path.
    let captured: ((m: string, d?: boolean) => Promise<boolean>) | null = null;
    const spy = vi.spyOn(toastLib, 'registerConfirmHandler').mockImplementation((h) => {
      captured = h as unknown as (m: string, d?: boolean) => Promise<boolean>;
    });
    render(<ConfirmDialog />);
    expect(captured).toBeTypeOf('function');
    act(() => void captured!('Delete forever?', true));
    await screen.findByRole('dialog');
    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    expect(okBtn).toHaveClass('confirm-dialog__confirm--danger');
    spy.mockRestore();
  });

  it('dialog has accessible role, aria-modal, and aria-describedby on the message', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Accessible message'));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveAttribute('aria-modal', 'true');
    // aria-describedby should point at an element containing the message
    const describedById = dialog.getAttribute('aria-describedby');
    expect(describedById).toBeTruthy();
    const msgEl = document.getElementById(describedById!);
    expect(msgEl).not.toBeNull();
    expect(msgEl!.textContent).toContain('Accessible message');
  });
});
