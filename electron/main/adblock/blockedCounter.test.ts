// electron/main/adblock/blockedCounter.test.ts
import { describe, it, expect } from 'vitest';
import { BlockedCounter } from './blockedCounter';
import { PRIMARY_VIEW_ID } from '../../../shared/types';

/**
 * Minimal fake that mirrors the @ghostery/adblocker custom EventEmitter API:
 *   on(event, cb)          — subscribe
 *   unsubscribe(event, cb) — unsubscribe  (the real engine has no removeListener)
 *   emit(event, ...args)   — fire listeners
 *
 * Using node:events.EventEmitter was intentionally avoided: it lacks
 * `unsubscribe` and would re-mask the removeListener bug this test is meant
 * to catch.
 */
function makeFakeBlocker() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();

  return {
    on(event: string, cb: (...args: unknown[]) => void): void {
      const list = listeners.get(event) ?? [];
      list.push(cb);
      listeners.set(event, list);
    },
    unsubscribe(event: string, cb: (...args: unknown[]) => void): void {
      const list = listeners.get(event);
      if (list) {
        listeners.set(event, list.filter((fn) => fn !== cb));
      }
    },
    emit(event: string, ...args: unknown[]): void {
      const list = listeners.get(event) ?? [];
      for (const fn of [...list]) fn(...args);
    },
  };
}

const PRIMARY = PRIMARY_VIEW_ID; // ViewId is `number` (=== 1)

describe('BlockedCounter', () => {
  it('starts at zero for page and session', () => {
    const counter = new BlockedCounter(PRIMARY);
    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 0, session: 0 });
  });

  it('increments page and session on request-blocked', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-blocked', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('also increments on request-redirected', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-redirected', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('resetPage() zeroes page but leaves session monotonic', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-blocked', {}, {});
    counter.resetPage();
    blocker.emit('request-blocked', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 1, session: 3 });
  });

  it('detach() removes listeners so later emits do not count', () => {
    const blocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);
    counter.attach(blocker as never);

    blocker.emit('request-blocked', {}, {});
    counter.detach(blocker as never);
    blocker.emit('request-blocked', {}, {});
    blocker.emit('request-redirected', {}, {});

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 1, session: 1 });
  });

  it('counts against a newly attached blocker after a swap (detach old, attach new)', () => {
    const oldBlocker = makeFakeBlocker();
    const newBlocker = makeFakeBlocker();
    const counter = new BlockedCounter(PRIMARY);

    counter.attach(oldBlocker as never);
    oldBlocker.emit('request-blocked', {}, {});
    counter.detach(oldBlocker as never);

    counter.attach(newBlocker as never);
    newBlocker.emit('request-blocked', {}, {});
    oldBlocker.emit('request-blocked', {}, {}); // detached → ignored

    expect(counter.snapshot()).toEqual({ viewId: PRIMARY, page: 2, session: 2 });
  });

  it('snapshot() returns the viewId it was constructed with', () => {
    const counter = new BlockedCounter(42);
    expect(counter.snapshot().viewId).toBe(42);
  });
});
