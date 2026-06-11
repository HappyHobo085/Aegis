// src/components/ConfirmDialog.test.tsx
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { StrictMode } from 'react';
import { render, screen, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfirmDialog } from './ConfirmDialog';
import { confirm, registerConfirmHandler, __resetToasts } from '../lib/toast';

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

  it('focus is trapped inside the dialog', async () => {
    render(<ConfirmDialog />);
    act(() => void confirm('Trapped?'));
    await screen.findByRole('dialog');
    // First focusable should have focus on open
    const okBtn = screen.getByRole('button', { name: /^ok$/i });
    expect(okBtn).toHaveFocus();
    // Tab from Cancel (last) wraps back to OK (first)
    const cancelBtn = screen.getByRole('button', { name: /^cancel$/i });
    cancelBtn.focus();
    await userEvent.tab();
    expect(okBtn).toHaveFocus();
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
