// src/lib/syncBus.test.ts
import { describe, it, expect, vi } from 'vitest';
import { onSyncChange, publishSyncChange } from './syncBus';

// `syncBus` is a process-wide singleton, so every listener is unsubscribed in its own
// test. Nothing here asserts on "no other listener exists" — only on this test's own
// subscription set, which is the contract the domain hooks depend on.
describe('syncBus', () => {
  it('delivers a published change to its namespace subscriber', () => {
    const fn = vi.fn();
    const off = onSyncChange('deliver', fn);
    publishSyncChange('deliver', ['a', 'b']);
    expect(fn).toHaveBeenCalledWith(['a', 'b']);
    off();
  });

  it('does not deliver across namespaces', () => {
    const favorites = vi.fn();
    const saved = vi.fn();
    const offF = onSyncChange('ns-fav', favorites);
    const offS = onSyncChange('ns-saved', saved);
    publishSyncChange('ns-fav', ['x']);
    expect(favorites).toHaveBeenCalledWith(['x']);
    expect(saved).not.toHaveBeenCalled();
    offF();
    offS();
  });

  it('delivers to every subscriber of a namespace, in subscription order', () => {
    const order: string[] = [];
    const off1 = onSyncChange('order', () => order.push('first'));
    const off2 = onSyncChange('order', () => order.push('second'));
    publishSyncChange('order', []);
    expect(order).toEqual(['first', 'second']);
    off1();
    off2();
  });

  it('stops delivering after unsubscribe, and is idempotent to call twice', () => {
    const fn = vi.fn();
    const off = onSyncChange('unsub', fn);
    off();
    off();
    publishSyncChange('unsub', ['late']);
    expect(fn).not.toHaveBeenCalled();
  });

  // The registry is a `Set`, so registering one fn reference twice is ONE
  // registration and either `off` removes it. That is fine here: every real subscriber
  // is a distinct hook closure, so no two callers share a reference. Pinned so the
  // dedupe is a known property rather than a surprise if the registry ever changes.
  it('registers one fn reference once (Set dedupe), and either off removes it', () => {
    const fn = vi.fn();
    const offA = onSyncChange('dup', fn);
    const offB = onSyncChange('dup', fn);
    publishSyncChange('dup', ['once']);
    expect(fn).toHaveBeenCalledTimes(1);
    offA();
    publishSyncChange('dup', ['gone']);
    expect(fn).toHaveBeenCalledTimes(1);
    offB();
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('a throwing listener does not stop the others (a refetch must not be lost)', () => {
    const boom = vi.fn(() => {
      throw new Error('listener exploded');
    });
    const after = vi.fn();
    const offBoom = onSyncChange('isolation', boom);
    const offAfter = onSyncChange('isolation', after);
    expect(() => publishSyncChange('isolation', ['u'])).not.toThrow();
    expect(boom).toHaveBeenCalled();
    expect(after).toHaveBeenCalledWith(['u']);
    offBoom();
    offAfter();
  });

  it('publishing to a namespace nobody subscribed to is a no-op', () => {
    expect(() => publishSyncChange('never-subscribed', ['u'])).not.toThrow();
  });

  it('a listener may unsubscribe itself from inside its own callback', () => {
    const seen: number[] = [];
    let off: () => void = () => {};
    const fn = (): void => {
      seen.push(seen.length);
      off();
    };
    off = onSyncChange('self-off', fn);
    publishSyncChange('self-off', []);
    publishSyncChange('self-off', []);
    expect(seen).toEqual([0]);
  });
});
