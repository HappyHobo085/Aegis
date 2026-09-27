// src/components/PickerButton.test.tsx
//
// REWRITTEN 2026-09-27. The previous version of this file was the clearest example in the
// repo of a test that proves nothing: it mocked `picker.start` to resolve
// `{ ok: true, rule: 'example.com##.ad' }` and then asserted the toast fired. No platform
// arm of `start` ever returns a `rule` — `picker.rs` returns `{"ok": true}` at lines 332,
// 352, 385 and 391 — so the test supplied the very value the production code was missing
// and the assertion could not fail. The rule arrives as an EVENT, and these tests model
// that transport.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const start = vi.fn();
// The subscriber the component registers, captured so a test can fire the event the way
// the core does. `unsubscribe` is returned so the unmount/cleanup test is real.
let picked: ((p: { rule: string }) => void) | null = null;
const unsubscribe = vi.fn();
const onPicked = vi.fn((cb: (p: { rule: string }) => void) => {
  picked = cb;
  return unsubscribe;
});

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    picker: {
      start: (...a: unknown[]) => start(...a),
      onPicked: (...a: unknown[]) => onPicked(...(a as [(p: { rule: string }) => void])),
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
  picked = null;
  // The truth: `start` injects the overlay and returns. No `rule`, on any platform.
  start.mockResolvedValue({ ok: true });
});

/** Fire `picker.picked` the way `picker.rs:302` does, after the component subscribed. */
const emitPicked = (rule: string): void => {
  expect(picked, 'component never subscribed to picker.picked').not.toBeNull();
  picked?.({ rule });
};

describe('PickerButton', () => {
  it('renders a button to pick an element to hide', () => {
    render(<PickerButton />);
    expect(screen.getByRole('button', { name: /pick element to hide/i })).toBeInTheDocument();
  });

  it('subscribes to picker.picked on mount', () => {
    render(<PickerButton />);
    expect(onPicked).toHaveBeenCalledTimes(1);
  });

  it('clicking calls aegis.picker.start', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    expect(start).toHaveBeenCalledTimes(1);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. The old version of this test passed `rule` on
  // `start`'s return value; the new one fires the event, which is the only channel the
  // core actually uses.
  it('toasts the rule from the picker.picked EVENT, not from start()s return value', async () => {
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    // start() has resolved and returned a payload with no rule in it.
    expect(start.mock.results[0]?.value).toBeDefined();
    expect(toast.success).not.toHaveBeenCalled();

    emitPicked('example.com##.ad');
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('example.com##.ad'));
  });

  it('does NOT toast from start() even if a rule appears on its reply', async () => {
    // A defensive guard on the old bug: nothing may read `rule` off the return value any
    // more, because doing so is what made the toast unreachable on a real build.
    start.mockResolvedValue({ ok: true, rule: 'sneaky.test##.ad' });
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not toast when the pick is cancelled (no event ever arrives)', async () => {
    // Cancelling is NOT `ok: false`. `ok: false` means the overlay could not be injected
    // at all (no active webview, or the no-randomness guard). A user pressing Esc after
    // the overlay is up sends NO event, which is what the absence of a toast below models.
    render(<PickerButton />);
    await userEvent.click(screen.getByRole('button', { name: /pick element to hide/i }));
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('stays usable while the user is still choosing (the event is not awaited)', async () => {
    render(<PickerButton />);
    const btn = screen.getByRole('button', { name: /pick element to hide/i });
    await userEvent.click(btn);
    await waitFor(() => expect(btn).toBeEnabled());
    // No event yet — the pick has not happened. The button must not be stuck disabled.
    expect(btn).toBeEnabled();
    emitPicked('late.test##.ad');
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('late.test##.ad'));
  });

  it('unsubscribes on unmount so a late pick cannot toast into nothing', () => {
    const { unmount } = render(<PickerButton />);
    expect(onPicked).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('disables itself only while the start() round trip is in flight', async () => {
    let resolveStart: (v: { ok: boolean }) => void = () => {};
    start.mockReturnValue(
      new Promise<{ ok: boolean }>((res) => {
        resolveStart = res;
      }),
    );
    render(<PickerButton />);
    const btn = screen.getByRole('button', { name: /pick element to hide/i });
    await userEvent.click(btn);
    expect(btn).toBeDisabled();
    resolveStart({ ok: true });
    await waitFor(() => expect(btn).toBeEnabled());
  });
});
