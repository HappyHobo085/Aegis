// electron/main/ipc/customFilters.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import { buildCustomFiltersHandlers } from './customFilters';

function makeRepo(initial: string) {
  let text = initial;
  return {
    get: vi.fn((): string => text),
    set: vi.fn((t: string): void => {
      text = t;
    }),
  };
}

describe('buildCustomFiltersHandlers', () => {
  it('registers exactly the two customFilters channels', () => {
    const repo = makeRepo('');
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache: vi.fn() });
    expect(Object.keys(handlers).sort()).toEqual(
      [IPC.customFiltersGet, IPC.customFiltersSet].sort(),
    );
  });

  it('customFiltersGet returns repo.get()', () => {
    const repo = makeRepo('x.com##.ad');
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache: vi.fn() });
    const out = handlers[IPC.customFiltersGet]();
    expect(repo.get).toHaveBeenCalledTimes(1);
    expect(out).toBe('x.com##.ad');
  });

  it('customFiltersSet persists, rebuilds from cache, and returns the stored text', () => {
    const repo = makeRepo('');
    const rebuildFromCache = vi.fn();
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache });
    const out = handlers[IPC.customFiltersSet]('||ads.test^\nx.com##.ad');
    expect(repo.set).toHaveBeenCalledWith('||ads.test^\nx.com##.ad');
    expect(rebuildFromCache).toHaveBeenCalledTimes(1);
    expect(out).toBe('||ads.test^\nx.com##.ad');
  });

  it('customFiltersSet calls set BEFORE rebuildFromCache', () => {
    const order: string[] = [];
    const repo = {
      get: vi.fn((): string => 'stored'),
      set: vi.fn((): void => {
        order.push('set');
      }),
    };
    const rebuildFromCache = vi.fn(() => {
      order.push('rebuild');
    });
    const handlers = buildCustomFiltersHandlers(repo as any, { rebuildFromCache });
    handlers[IPC.customFiltersSet]('whatever');
    expect(order).toEqual(['set', 'rebuild']);
  });
});
