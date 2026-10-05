// src/components/PickerButton.test.tsx
//
// REWRITTEN 2026-09-27. The previous version of this file was the clearest example in the
// repo of a test that proves nothing: it mocked `picker.start` to resolve
// `{ ok: true, rule: 'example.com##.ad' }` and then asserted the toast fired. No platform
// arm of `start` ever returns a `rule` — `picker.rs` returns `{"ok": true}` at lines 332,
// 352, 385 and 391 — so the test supplied the very value the production code was missing
// and the assertion could not fail. The rule arrives as an EVENT, and these tests model
// that transport.
//
// EXTENDED for the toggle. The button used to be able to ARM the picker and never disarm it:
// the overlay's exits were all page-side and its opening line (`if (window.__aegisPicking)
// return;`) made every later injection a silent no-op, so only a page reload disarmed it.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const start = vi.fn();
const stop = vi.fn();
// The subscribers the component registers, captured so a test can fire the events the way
// the core does. `unsubscribe` is returned so the unmount/cleanup tests are real.
let picked: ((p: { rule: string }) => void) | null = null;
let state: ((s: { active: boolean }) => void) | null = null;
const unsubscribe = vi.fn();
const unsubscribeState = vi.fn();
const onPicked = vi.fn((cb: (p: { rule: string }) => void) => {
  picked = cb;
  return unsubscribe;
});
const onState = vi.fn((cb: (s: { active: boolean }) => void) => {
  state = cb;
  return unsubscribeState;
});

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    picker: {
      start: (...a: unknown[]) => start(...a),
      stop: (...a: unknown[]) => stop(...a),
      onPicked: (...a: unknown[]) => onPicked(...(a as [(p: { rule: string }) => void])),
      onState: (...a: unknown[]) => onState(...(a as [(s: { active: boolean }) => void])),
    },
  },
}));

vi.mock('../lib/toast', () => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));
import { toast } from '../lib/toast';

import { PickerButton } from './PickerButton';

const btn = (): HTMLElement => screen.getByRole('button', { name: /pick element to hide/i });

beforeEach(() => {
  vi.clearAllMocks();
  picked = null;
  state = null;
  // The truth on a desktop with a content webview: `start` injects the overlay, reports
  // that it is now armed, and returns. No `rule`, on any platform — and `active` is the
  // core's own answer about whether an overlay exists in the page, not something the
  // caller infers.
  start.mockResolvedValue({ ok: true, active: true });
  stop.mockResolvedValue({ ok: true, active: false });
});

/** Fire `picker.picked` the way `picker.rs` does, after the component subscribed. */
const emitPicked = (rule: string): void => {
  expect(picked, 'component never subscribed to picker.picked').not.toBeNull();
  picked?.({ rule });
};

/** Fire `picker.state` the way `picker.rs` does on every session transition. */
const emitState = (active: boolean): void => {
  expect(state, 'component never subscribed to picker.state').not.toBeNull();
  state?.({ active });
};

describe('PickerButton', () => {
  it('renders a button to pick an element to hide', () => {
    render(<PickerButton />);
    expect(btn()).toBeInTheDocument();
  });

  it('subscribes to picker.picked on mount', () => {
    render(<PickerButton />);
    expect(onPicked).toHaveBeenCalledTimes(1);
  });

  it('subscribes to picker.state on mount', () => {
    // Without this subscription the button can only learn about sessions that ended inside
    // the page by guessing, and the guessing version is the bug this toggle fixes.
    render(<PickerButton />);
    expect(onState).toHaveBeenCalledTimes(1);
  });

  it('clicking calls aegis.picker.start', async () => {
    render(<PickerButton />);
    await userEvent.click(btn());
    expect(start).toHaveBeenCalledTimes(1);
  });

  // THE REGRESSION THIS FILE EXISTS FOR. The old version of this test passed `rule` on
  // `start`'s return value; the new one fires the event, which is the only channel the
  // core actually uses.
  it('toasts the rule from the picker.picked EVENT, not from start()s return value', async () => {
    render(<PickerButton />);
    await userEvent.click(btn());
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
    start.mockResolvedValue({ ok: true, active: true, rule: 'sneaky.test##.ad' });
    render(<PickerButton />);
    await userEvent.click(btn());
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('does not toast when the pick is cancelled (no rule event ever arrives)', async () => {
    // Cancelling is NOT `ok: false`. `ok: false` means the overlay could not be injected
    // at all (no active webview, or the no-randomness guard). A user pressing Esc after
    // the overlay is up sends a cancel sentinel, which carries no rule.
    render(<PickerButton />);
    await userEvent.click(btn());
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(toast.success).not.toHaveBeenCalled();
  });

  it('stays usable while the user is still choosing (the event is not awaited)', async () => {
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toBeEnabled());
    // No event yet — the pick has not happened. The button must not be stuck disabled.
    expect(b).toBeEnabled();
    emitPicked('late.test##.ad');
    expect(toast.success).toHaveBeenCalledWith(expect.stringContaining('late.test##.ad'));
  });

  it('unsubscribes on unmount so a late pick cannot toast into nothing', () => {
    const { unmount } = render(<PickerButton />);
    expect(onPicked).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes from picker.state on unmount too', () => {
    // A state event delivered after unmount is a setState on a dead component; React 18+
    // removed the warning, so nothing would fail — which is exactly why it is pinned.
    const { unmount } = render(<PickerButton />);
    expect(onState).toHaveBeenCalledTimes(1);
    unmount();
    expect(unsubscribeState).toHaveBeenCalledTimes(1);
  });

  it('disables itself only while the start() round trip is in flight', async () => {
    let resolveStart: (v: { ok: boolean; active: boolean }) => void = () => {};
    start.mockReturnValue(
      new Promise<{ ok: boolean; active: boolean }>((res) => {
        resolveStart = res;
      }),
    );
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    expect(b).toBeDisabled();
    resolveStart({ ok: true, active: true });
    await waitFor(() => expect(b).toBeEnabled());
  });

  // ── the toggle ──────────────────────────────────────────────────────────

  it('is not pressed before anything is armed', () => {
    render(<PickerButton />);
    expect(btn()).toHaveAttribute('aria-pressed', 'false');
  });

  it('is pressed once the core reports the overlay is armed', async () => {
    render(<PickerButton />);
    await userEvent.click(btn());
    await waitFor(() => expect(btn()).toHaveAttribute('aria-pressed', 'true'));
  });

  it('a second click calls picker.stop, not picker.start', async () => {
    // THE owner's report: the button only ever enabled picking, and disabling it needed an
    // app restart. Re-arming instead of stopping is what made it look like a dead button.
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));

    await userEvent.click(b);
    await waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('clicking while armed un-presses it', async () => {
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));
  });

  it('the picker can be re-armed after a stop', async () => {
    // The other half of "toggle": a stop must not leave the button wedged, which is what
    // `if (window.__aegisPicking) return;` in the overlay used to cause from the other end.
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));

    await userEvent.click(b);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
  });

  it('an Escape in the page un-presses the button', async () => {
    // THE reason `picker.state` exists and the reason it is not optional. Escape tears the
    // overlay down inside the page; the core learns of it from the cancel sentinel and
    // reports it here. Without this the button stays pressed, and the user's next click
    // calls `stop` at a picker that is no longer armed — a no-op, i.e. the same dead
    // button one click later.
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));

    emitState(false);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));
    // And the next click must ARM again rather than stop a picker that is already gone.
    await userEvent.click(b);
    await waitFor(() => expect(start).toHaveBeenCalledTimes(2));
    expect(stop).not.toHaveBeenCalled();
  });

  it('a pick in the page un-presses the button', async () => {
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));

    emitState(false);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));
  });

  it('does NOT press itself when the core had nowhere to inject', async () => {
    // Android, or no active tab: the overlay does not exist, so a button reporting "armed"
    // would be a control claiming a state the core does not hold. The reply's `active` is
    // adopted rather than the click's optimism.
    start.mockResolvedValue({ ok: false, active: false });
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(start).toHaveBeenCalled());
    expect(b).toHaveAttribute('aria-pressed', 'false');
  });

  it('a stop is pressed off by the core even if the reply said nothing', async () => {
    // Belt and braces on the reply-vs-event split: the event is the authority for state that
    // ends in the page, and the reply is the authority for the call just made. Both agree
    // here, and either one alone must be enough to leave the button un-pressed.
    stop.mockResolvedValue({ ok: false, active: false });
    render(<PickerButton />);
    const b = btn();
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'true'));
    await userEvent.click(b);
    await waitFor(() => expect(b).toHaveAttribute('aria-pressed', 'false'));
  });
});
