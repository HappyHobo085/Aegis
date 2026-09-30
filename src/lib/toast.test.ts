import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  toast,
  subscribeToasts,
  __resetToasts,
  dismissToast,
  pauseToast,
  resumeToast,
  confirm,
  registerConfirmHandler,
  type ToastItem,
} from './toast';

describe('toast actions', () => {
  beforeEach(() => __resetToasts());

  it('attaches an action to the toast', () => {
    let latest: ToastItem[] = [];
    const off = subscribeToasts((t) => (latest = t));
    toast.info('saved', { action: { label: 'Undo', onClick: () => {} } });
    expect(latest[0].action?.label).toBe('Undo');
    off();
  });

  it('respects a custom duration', () => {
    vi.useFakeTimers();
    let latest: ToastItem[] = [];
    const off = subscribeToasts((t) => (latest = t));
    toast.info('x', { durationMs: 6000 });
    vi.advanceTimersByTime(4000);
    expect(latest).toHaveLength(1);
    vi.advanceTimersByTime(2000);
    expect(latest).toHaveLength(0);
    off();
    vi.useRealTimers();
  });
});

/**
 * The auto-dismiss lifecycle: dismissing, pausing (hover) and resuming.
 *
 * `vi.getTimerCount()` is the load-bearing assertion here, NOT the visible list
 * length. A pending `setTimeout` and an already-filtered toast are indistinguishable
 * from the outside: advancing past the duration leaves zero toasts either way, so a
 * length-only assertion passes whether or not the timer was actually cancelled. The
 * timer count is the only observable that distinguishes "the timeout was cleared" from
 * "the toast is gone but will never fire again anyway".
 */
describe('the auto-dismiss timer', () => {
  let latest: ToastItem[] = [];
  let off = () => {};

  beforeEach(() => {
    __resetToasts();
    latest = [];
    off = subscribeToasts((t) => (latest = t));
    vi.useFakeTimers();
  });

  afterEach(() => {
    off();
    vi.useRealTimers();
  });

  it('clears the pending timer when a toast is dismissed by hand', () => {
    toast.info('manual');
    const id = latest[0].id;
    expect(vi.getTimerCount()).toBe(1);

    dismissToast(id);

    // The observable that a length check cannot give: the timeout is gone, so
    // advancing time can no longer emit a second (redundant) removal.
    expect(vi.getTimerCount()).toBe(0);
    expect(latest).toHaveLength(0);
  });

  it('suspends the countdown on pause and restarts it on resume', () => {
    toast.info('hovered', { durationMs: 4000 });
    const id = latest[0].id;

    pauseToast(id);
    expect(vi.getTimerCount()).toBe(0);
    // Pausing must NOT remove the toast — only stop the countdown.
    expect(latest).toHaveLength(1);

    // Time passing while paused must not dismiss anything.
    vi.advanceTimersByTime(60_000);
    expect(latest).toHaveLength(1);

    resumeToast(id);
    expect(vi.getTimerCount()).toBe(1);

    // The restart uses the toast's own duration, so it dismisses on time from now.
    vi.advanceTimersByTime(4000);
    expect(latest).toHaveLength(0);
  });

  it('ignores a resume for a toast whose timer is still running', () => {
    toast.info('not paused');
    const id = latest[0].id;

    // Resuming without a preceding pause must not schedule a SECOND timer —
    // that would leave a stray timeout able to fire after the toast is gone.
    resumeToast(id);
    expect(vi.getTimerCount()).toBe(1);

    vi.advanceTimersByTime(4000);
    expect(latest).toHaveLength(0);
  });

  it('is a no-op to resume a toast that no longer exists', () => {
    // Neither a live toast nor a live timer: nothing may be scheduled.
    expect(vi.getTimerCount()).toBe(0);
    resumeToast(4242);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('pausing a toast that has already gone is harmless', () => {
    // The absent-timer arm of the pause branch.
    pauseToast(4242);
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe('confirm', () => {
  beforeEach(() => __resetToasts());
  afterEach(() => registerConfirmHandler(null));

  // NOTE: `confirm` returns the handler's value SYNCHRONOUSLY; only the
  // no-handler fallback wraps its result in a Promise. So await the call rather
  // than using `.resolves`, which would reject the synchronous arm.
  it('routes to the registered handler, with the destructive flag when given', async () => {
    const handler = vi.fn().mockReturnValue(true);
    registerConfirmHandler(handler);

    expect(await confirm('Delete this workspace?')).toBe(true);
    // Without `destructive` the handler is called with ONE argument — the caller's
    // arity is part of the contract, so assert it rather than only the result.
    expect(handler).toHaveBeenCalledWith('Delete this workspace?');

    expect(await confirm('Delete?', { destructive: true })).toBe(true);
    expect(handler).toHaveBeenLastCalledWith('Delete?', true);

    expect(handler).toHaveBeenCalledTimes(2);
  });

  it('falls back to the platform dialog when no handler is registered', async () => {
    // No handler: the module must fall through to `window.confirm` rather than
    // throwing or silently returning false.
    const native = vi.spyOn(window, 'confirm').mockReturnValue(true);
    try {
      await expect(confirm('Proceed?')).resolves.toBe(true);
      expect(native).toHaveBeenCalledWith('Proceed?');
    } finally {
      native.mockRestore();
    }
  });
});
