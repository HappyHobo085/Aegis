// electron/main/adblock/blockedCounter.test.ts
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { BlockedCounter } from './blockedCounter';
import { PRIMARY_VIEW_ID } from '../../../shared/types';

/**
 * Structural stand-in for ElectronBlocker's counting surface: the core engine
 * is an EventEmitter that emits 'request-blocked' / 'request-redirected' from
 * match(). BlockedCounter only uses `on` / `removeListener`, so a plain
 * EventEmitter is a faithful fake.
 */
function makeFakeBlocker() {
  return new EventEmitter();
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
