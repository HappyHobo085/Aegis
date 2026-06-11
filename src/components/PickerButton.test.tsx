// src/components/PickerButton.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const start = vi.fn();
vi.mock('../lib/ipcClient', () => ({
  aegis: {
    picker: {
      start: (...a: any[]) => start(...a),
    },
  },
}));

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { PickerButton } from './PickerButton';

beforeEach(() => {
  vi.clearAllMocks();
  start.mockResolvedValue({ ok: true, rule: 'example.com##.ad' });
});

describe('PickerButton', () => {
  it('renders a button to pick an element to hide', () => {
    render(<PickerButton />);
    expect(screen.getByRole('button', { name: /pick element to hide/i })).toBeInTheDocument();
  });

  it('clicking calls aegis.picker.start', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('reports the created rule via a success toast', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('example.com##.ad')));
  });

  it('does not toast success when the pick is cancelled', async () => {
    start.mockResolvedValue({ ok: false });
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('disables itself while a pick is in flight', async () => {
    let resolveStart: (v: { ok: boolean; rule?: string }) => void = () => {};
    start.mockReturnValue(
      new Promise<{ ok: boolean; rule?: string }>((res) => {
        resolveStart = res;
      }),
    );
    render(<PickerButton />);
    const btn = screen.getByRole('button', { name: /pick element to hide/i });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    resolveStart({ ok: false });
    await waitFor(() => expect(btn).toBeEnabled());
  });
});
