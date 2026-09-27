// src/lib/updateResult.test.ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ListUpdateResult } from '../../shared/types';
import { awaitUpdateResult, UPDATE_RESULT_TIMEOUT_MS } from './updateResult';

const RESULT: ListUpdateResult = { perSource: [], lastUpdated: 123 };

/** A transport that accepts the subscription and then never says anything. */
function silentTransport() {
  const state = { released: 0 };
  const onResult = vi.fn((_cb: (r: ListUpdateResult) => void) => () => {
    state.released += 1;
  });
  const kick = vi.fn(async () => undefined);
  return { state, onResult, kick };
}

/** A transport that hands the callback back so a test can fire it later. */
function answeringTransport() {
  let fire: ((r: ListUpdateResult) => void) | null = null;
  const released = { n: 0 };
  const onResult = vi.fn((cb: (r: ListUpdateResult) => void) => {
    fire = cb;
    return () => {
      released.n += 1;
    };
  });
  return {
    released,
    onResult,
    kick: vi.fn(async () => undefined),
    deliver: (r: ListUpdateResult) => fire?.(r),
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('awaitUpdateResult', () => {
  // The defect. The core's refresh runs on a DETACHED thread and the result event is
  // that thread's last statement; a panic before the emit kills the thread silently and
  // nothing is ever delivered. "Update all" had already disabled itself and its
  // `finally` was the only thing that would re-enable it, so a silent thread left the
  // button dead for the whole session — no result, no message, no retry.
  it('REJECTS when the core never delivers a result, instead of hanging forever', async () => {
    vi.useFakeTimers();
    const t = silentTransport();
    const p = awaitUpdateResult(t.onResult, t.kick, UPDATE_RESULT_TIMEOUT_MS);
    const settled = p.then(
      () => 'resolved',
      () => 'rejected',
    );
    // Nothing has arrived, so nothing may have settled — yet.
    await vi.advanceTimersByTimeAsync(0);
    expect(await Promise.race([settled, Promise.resolve('pending')])).toBe('pending');

    await vi.advanceTimersByTimeAsync(UPDATE_RESULT_TIMEOUT_MS);
    expect(await settled).toBe('rejected');
    // The message has to tell the user their lists are intact, or a refusal reads as
    // "your filters were deleted".
    await expect(p).rejects.toThrow(/unchanged|safe to try again/i);
  });

  it('resolves with the delivered result and ignores the timeout afterwards', async () => {
    vi.useFakeTimers();
    const t = answeringTransport();
    const p = awaitUpdateResult(t.onResult, t.kick, UPDATE_RESULT_TIMEOUT_MS);
    t.deliver(RESULT);
    await expect(p).resolves.toEqual(RESULT);
    // The timer must be cleared, or this fires later and rejects an already-settled
    // promise (an unhandled rejection in production).
    await vi.advanceTimersByTimeAsync(UPDATE_RESULT_TIMEOUT_MS * 2);
    expect(t.released.n).toBe(1);
  });

  it('releases the one-shot listener on EVERY path, including the timeout', async () => {
    vi.useFakeTimers();
    const t = silentTransport();
    const p = awaitUpdateResult(t.onResult, t.kick, UPDATE_RESULT_TIMEOUT_MS);
    p.catch(() => {});
    await vi.advanceTimersByTimeAsync(UPDATE_RESULT_TIMEOUT_MS);
    expect(t.state.released).toBe(1);
  });

  it('surfaces a kick-off failure immediately rather than waiting out the timeout', async () => {
    vi.useFakeTimers();
    // A transport failure means no refresh was ever started, so the 60 s timeout would
    // be a lie about what happened.
    const onResult = vi.fn((_cb: (r: ListUpdateResult) => void) => () => {});
    const kick = vi.fn(async () => {
      throw new Error('transport unavailable');
    });
    const p = awaitUpdateResult(onResult, kick, UPDATE_RESULT_TIMEOUT_MS);
    await expect(p).rejects.toThrow('transport unavailable');
  });

  it('subscribes BEFORE kicking off, so the result cannot be missed', () => {
    // Ordering, not just settlement: the listener only exists once its `listen` IPC is
    // processed, so a kick dispatched first can finish before anyone is listening.
    const order: string[] = [];
    const onResult = vi.fn((_cb: (r: ListUpdateResult) => void) => {
      order.push('subscribe');
      return () => {};
    });
    const kick = vi.fn(async () => {
      order.push('kick');
    });
    void awaitUpdateResult(onResult, kick, UPDATE_RESULT_TIMEOUT_MS).catch(() => {});
    expect(order).toEqual(['subscribe', 'kick']);
  });

  it('a late result arriving after the timeout cannot re-settle the promise', async () => {
    vi.useFakeTimers();
    const t = answeringTransport();
    const p = awaitUpdateResult(t.onResult, t.kick, 1_000);
    const first = p.then(
      () => 'resolved',
      () => 'rejected',
    );
    await vi.advanceTimersByTimeAsync(1_000);
    expect(await first).toBe('rejected');
    // The core's thread finished after we gave up. This must be inert, not a throw.
    expect(() => t.deliver(RESULT)).not.toThrow();
    expect(await first).toBe('rejected');
  });
});
