// src/hooks/useOmnibox.test.ts
//
// Covers the hook's three jobs: the debounced history query, the MONOTONIC seq guard
// that keeps a slow earlier response from overwriting a fast later one, and the
// arrow-key cursor. The ranking itself is `lib/omnibox.ts`'s job and is unit-tested
// there — these tests run the real ranker and assert only the hook's own behaviour.
//
// FAKE TIMERS THROUGHOUT. The debounce is 90 ms; with real timers a 120 ms wait is
// marginal (measured: the second query had not fired at 120 ms and needed ~400 ms),
// so every timing assertion here would be a flake waiting for a loaded CI runner.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { HistoryEntry } from '../../shared/types';

const historySearch = vi.fn();
const historyList = vi.fn();

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    history: {
      search: (...a: any[]) => historySearch(...a),
      list: (...a: any[]) => historyList(...a),
    },
  },
}));

import { useOmnibox, type UseOmniboxArgs } from './useOmnibox';

const DEBOUNCE = 90;

const entry = (over: Partial<HistoryEntry> = {}): HistoryEntry =>
  ({
    id: 1,
    url: 'https://example.com/',
    title: 'Example',
    visitedAt: 1_700_000_000_000,
    ...over,
  }) as HistoryEntry;

const args = (over: Partial<UseOmniboxArgs> = {}): UseOmniboxArgs => ({
  query: 'ex',
  active: true,
  favorites: [],
  saved: [],
  searchTemplate: 'https://search.test/?q=%s',
  dismissed: false,
  ...over,
});

/** A promise plus its settle handles, for ordering two in-flight requests. */
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  // Nothing in the hook ever awaits this handle directly, so a rejection the hook
  // guards against would surface as an unhandled rejection and fail the FILE.
  promise.catch(() => {});
  return { promise, resolve, reject };
}

/** Advance past the debounce and let the resulting microtasks settle. */
async function settle(ms = DEBOUNCE + 10) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

const kinds = (result: { current: { suggestions: Array<{ kind: string }> } }) =>
  result.current.suggestions.map((s) => s.kind);
const titles = (result: { current: { suggestions: Array<{ title: string }> } }) =>
  result.current.suggestions.map((s) => s.title);

beforeEach(() => {
  // mockReset, NOT clearAllMocks: clearAllMocks leaves the `mockReturnValueOnce` queue
  // intact, so an unconsumed "once" value silently leaks into the NEXT test.
  historySearch.mockReset();
  historyList.mockReset();
  historySearch.mockResolvedValue([]);
  historyList.mockResolvedValue([]);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('useOmnibox — history query', () => {
  it('does not query at all while the input is not focused', async () => {
    renderHook(() => useOmnibox(args({ active: false })));
    await settle(500);
    expect(historySearch).not.toHaveBeenCalled();
    expect(historyList).not.toHaveBeenCalled();
  });

  it('debounces: a burst of keystrokes produces ONE query, for the final text', async () => {
    const { rerender } = renderHook(({ query }) => useOmnibox(args({ query })), {
      initialProps: { query: 'e' },
    });
    rerender({ query: 'ex' });
    rerender({ query: 'exa' });
    rerender({ query: 'exam' });
    expect(historySearch).not.toHaveBeenCalled();
    await settle();
    expect(historySearch).toHaveBeenCalledTimes(1);
    expect(historySearch).toHaveBeenCalledWith('exam');
  });

  it('does not fire before the debounce elapses', async () => {
    renderHook(() => useOmnibox(args({ query: 'exa' })));
    await settle(DEBOUNCE - 5);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it('lists recent history (not search) for an EMPTY query', async () => {
    renderHook(() => useOmnibox(args({ query: '' })));
    await settle();
    expect(historyList).toHaveBeenCalledTimes(1);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it('trims the query before sending it, so whitespace does not reach the core', async () => {
    renderHook(() => useOmnibox(args({ query: '  ex  ' })));
    await settle();
    expect(historySearch).toHaveBeenCalledWith('ex');
  });

  it('a whitespace-only query counts as empty (lists, does not search for " ")', async () => {
    renderHook(() => useOmnibox(args({ query: '   ' })));
    await settle();
    expect(historyList).toHaveBeenCalledTimes(1);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it('feeds the returned history into the ranked suggestions', async () => {
    historySearch.mockResolvedValue([entry()]);
    const { result } = renderHook(() => useOmnibox(args({ query: 'example' })));
    await settle();
    expect(kinds(result)).toContain('history');
  });

  it('ranks an EMPTY query by recency (the "Recent" jump-back list)', async () => {
    historyList.mockResolvedValue([
      entry({ id: 1, title: 'Older', visitedAt: 1_000 }),
      entry({ id: 2, title: 'Newer', visitedAt: 9_000 }),
    ]);
    const { result } = renderHook(() => useOmnibox(args({ query: '' })));
    await settle();
    expect(titles(result).slice(0, 2)).toEqual(['Newer', 'Older']);
  });

  // A non-array reply means the IPC boundary handed back something that never
  // deserialized (the raw `{}` of a failed invoke). The ranker indexes and sorts it,
  // so an unguarded `setHistory(entries)` would throw inside the memo.
  it('tolerates a non-array IPC reply instead of feeding it to the ranker', async () => {
    historySearch.mockResolvedValue({} as never);
    const { result } = renderHook(() => useOmnibox(args({ query: 'example' })));
    await settle();
    expect(() => result.current.suggestions).not.toThrow();
    expect(result.current.suggestions.every((s) => typeof s.title === 'string')).toBe(true);
  });

  it('a rejected query clears history rather than leaving the last results on screen', async () => {
    historySearch.mockResolvedValue([entry()]);
    const { result, rerender } = renderHook(({ query }) => useOmnibox(args({ query })), {
      initialProps: { query: 'example' },
    });
    await settle();
    expect(kinds(result)).toContain('history');
    historySearch.mockRejectedValue(new Error('ipc down'));
    await act(async () => {
      rerender({ query: 'example2' });
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    });
    expect(kinds(result)).not.toContain('history');
  });
});

describe('useOmnibox — the monotonic seq guard', () => {
  /** Mount with `query`, let the debounce issue the first request, then swap the text. */
  async function mountTwoInFlight() {
    const slow = deferred<HistoryEntry[]>();
    const fast = deferred<HistoryEntry[]>();
    historySearch.mockReset().mockReturnValueOnce(slow.promise).mockReturnValueOnce(fast.promise);
    const rendered = renderHook(({ query }) => useOmnibox(args({ query })), {
      initialProps: { query: 'exa' },
    });
    await settle();
    expect(historySearch).toHaveBeenCalledTimes(1);
    // The rerender and the clock advance MUST be separate act() blocks: doing both in
    // one advances the clock before React has committed the rerender's effect, so the
    // new debounce timer is armed after the advance has already passed it.
    await act(async () => {
      rendered.rerender({ query: 'exam' });
    });
    await settle();
    expect(historySearch).toHaveBeenCalledTimes(2);
    return { ...rendered, slow, fast };
  }

  // Both fixtures must MATCH the 'exam' query or the ranker drops them and the
  // assertion would pass for the wrong reason (an empty history looks identical to a
  // dropped one). Distinct URLs, so both would appear if the guard did not work.
  const FRESH = entry({ id: 2, title: 'Exam Fresh', url: 'https://exam-fresh.test/' });
  const STALE = entry({ id: 1, title: 'Exam Stale', url: 'https://exam-stale.test/' });

  // THE bug this guards: the user types "exa" (slow reply) then "exam" (fast reply).
  // Without the guard, the stale "exa" reply lands last and the dropdown shows results
  // for text the user has already moved on from.
  it('drops an EARLIER request that resolves after a LATER one', async () => {
    const { result, slow, fast } = await mountTwoInFlight();
    await act(async () => {
      fast.resolve([FRESH]);
    });
    await act(async () => {
      slow.resolve([STALE]);
    });
    const seen = titles(result);
    expect(seen).toContain('Exam Fresh');
    expect(seen).not.toContain('Exam Stale');
  });

  it('drops a stale REJECTION too, so it cannot clear the newer results', async () => {
    const { result, slow, fast } = await mountTwoInFlight();
    await act(async () => {
      fast.resolve([FRESH]);
    });
    await act(async () => {
      slow.reject(new Error('stale failure'));
    });
    expect(titles(result)).toContain('Exam Fresh');
  });

  it('still accepts the newest result when the older one is simply slow', async () => {
    const { result, slow, fast } = await mountTwoInFlight();
    await act(async () => {
      slow.resolve([STALE]);
    });
    expect(titles(result)).not.toContain('Exam Stale');
    await act(async () => {
      fast.resolve([FRESH]);
    });
    expect(titles(result)).toContain('Exam Fresh');
  });

  // Re-rendering with the SAME query must not cancel a request already in flight —
  // otherwise a parent re-render mid-flight would silently discard the results. The
  // cleanup's `if (mine === seq.current)` guard is what makes this safe.
  it('does not invalidate an in-flight request when the query is unchanged', async () => {
    const d = deferred<HistoryEntry[]>();
    historySearch.mockReset().mockReturnValue(d.promise);
    const { result, rerender } = renderHook(({ query }) => useOmnibox(args({ query })), {
      initialProps: { query: 'exa' },
    });
    await settle();
    await act(async () => {
      rerender({ query: 'exa' });
    });
    await act(async () => {
      d.resolve([entry({ title: 'Landed' })]);
    });
    expect(titles(result)).toContain('Landed');
  });

  it('cancels the pending debounce when the input loses focus mid-type', async () => {
    const { rerender } = renderHook(({ active }) => useOmnibox(args({ active })), {
      initialProps: { active: true },
    });
    rerender({ active: false });
    await settle(500);
    expect(historySearch).not.toHaveBeenCalled();
  });

  it('discards an in-flight result that lands after the effect is torn down', async () => {
    // This REPLACED a test that could not fail: it called `unmount()` and resolved the
    // promise, with only a comment saying it "would warn/throw if the guard were absent"
    // and NO assertion of any kind. It passed identically whether or not the hook guarded
    // anything.
    //
    // Two things make a real assertion possible here. First, the observable is the
    // sequence token's CONSEQUENCE — a result that lands after the effect stopped owning it
    // must not reach state — rather than a post-unmount warning: React 18 REMOVED the
    // "can't perform a state update on an unmounted component" warning entirely, so
    // spying `console.error` would see nothing even against a hook with no guard at all.
    // Second, `active: false` tears the effect down the same way `unmount` does (React runs
    // the previous cleanup, which invalidates the token, before the new effect body
    // early-returns) — and unlike unmount, it leaves the hook's state READABLE.
    //
    // This is the missing half of the two cases above it: `does not invalidate an
    // in-flight request when the query is unchanged` proves a token survives a re-run that
    // should NOT invalidate it, and `cancels the pending debounce when the input loses
    // focus mid-type` proves no NEW request is issued. Neither shows what happens to a
    // result already in flight when the owner is torn down.
    const d = deferred<HistoryEntry[]>();
    historySearch.mockReset().mockReturnValue(d.promise);
    const { result, rerender } = renderHook(({ active }) => useOmnibox(args({ active })), {
      initialProps: { active: true },
    });
    await settle();
    // Precondition: the request really is in flight, so a later "not present" cannot be
    // vacuously true because nothing was ever issued.
    expect(historySearch).toHaveBeenCalled();
    rerender({ active: false });
    await act(async () => {
      d.resolve([entry({ title: 'Landed after teardown' })]);
    });
    expect(titles(result)).not.toContain('Landed after teardown');
  });
});

describe('useOmnibox — open/closed', () => {
  it('is closed while unfocused even with rows to show', () => {
    historySearch.mockResolvedValue([entry()]);
    const { result } = renderHook(() => useOmnibox(args({ active: false, query: 'example' })));
    expect(result.current.open).toBe(false);
  });

  // Escape/blur closes the list but KEEPS the text, and the next keystroke re-opens it.
  it('stays closed while dismissed, even when focused with rows', async () => {
    historySearch.mockResolvedValue([entry()]);
    const { result, rerender } = renderHook(
      ({ dismissed }) => useOmnibox(args({ dismissed, query: 'example' })),
      { initialProps: { dismissed: false } },
    );
    await settle();
    expect(result.current.suggestions.length).toBeGreaterThan(0);
    expect(result.current.open).toBe(true);
    rerender({ dismissed: true });
    expect(result.current.open).toBe(false);
    rerender({ dismissed: false });
    expect(result.current.open).toBe(true);
  });

  it('is closed for an empty query with no history yet (nothing to show)', () => {
    const { result } = renderHook(() => useOmnibox(args({ query: '' })));
    expect(result.current.suggestions).toEqual([]);
    expect(result.current.open).toBe(false);
  });
});

describe('useOmnibox — the arrow-key cursor', () => {
  /** Mount focused on a query that yields several store rows plus the search row. */
  function mountWithRows() {
    historySearch.mockResolvedValue([
      entry({ id: 1, title: 'Example One', url: 'https://one.test/' }),
      entry({ id: 2, title: 'Example Two', url: 'https://two.test/' }),
    ]);
    return renderHook(() => useOmnibox(args({ query: 'example' })));
  }

  /** A truly empty list needs an EMPTY query and no history (a non-empty query always
   *  yields at least the "Search for …" row). */
  function mountWithNoRows() {
    return renderHook(() => useOmnibox(args({ query: '' })));
  }

  it('starts with nothing highlighted', () => {
    expect(mountWithRows().result.current.activeIndex).toBe(-1);
  });

  it('moveActive(1) from nothing highlights the FIRST row, not the second', async () => {
    const { result } = mountWithRows();
    await settle();
    act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(0);
  });

  it('moveActive(-1) from nothing highlights the LAST row (wraps backward)', async () => {
    const { result } = mountWithRows();
    await settle();
    act(() => result.current.moveActive(-1));
    expect(result.current.activeIndex).toBe(result.current.suggestions.length - 1);
  });

  // From "nothing" (-1), `n` presses land on n-1, so it takes n+1 to come back round.
  it('wraps past the end back to the first row', async () => {
    const { result } = mountWithRows();
    await settle();
    const n = result.current.suggestions.length;
    act(() => result.current.moveActive(1));
    for (let i = 1; i < n; i++) act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(n - 1);
    act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(0);
  });

  it('wraps before the start back to the last row', async () => {
    const { result } = mountWithRows();
    await settle();
    act(() => result.current.setActiveIndex(0));
    expect(result.current.activeIndex).toBe(0);
    act(() => result.current.moveActive(-1));
    expect(result.current.activeIndex).toBe(result.current.suggestions.length - 1);
  });

  it('setActiveIndex reports a hover', () => {
    const { result } = mountWithRows();
    act(() => result.current.setActiveIndex(0));
    expect(result.current.activeIndex).toBe(0);
  });

  it('moveActive on an empty list is a no-op, not a NaN/-0 cursor', () => {
    const { result } = mountWithNoRows();
    expect(result.current.suggestions).toEqual([]);
    act(() => result.current.moveActive(1));
    expect(result.current.activeIndex).toBe(-1);
  });

  it('moveActive(-1) on an empty list is also a no-op', () => {
    const { result } = mountWithNoRows();
    act(() => result.current.moveActive(-1));
    expect(result.current.activeIndex).toBe(-1);
  });

  it('never reports a cursor beyond the last row when the list shrinks', async () => {
    historySearch.mockResolvedValue([
      entry({ id: 1, title: 'Example One', url: 'https://one.test/' }),
      entry({ id: 2, title: 'Example Two', url: 'https://two.test/' }),
    ]);
    const { result, rerender } = renderHook(({ query }) => useOmnibox(args({ query })), {
      initialProps: { query: 'example' },
    });
    await settle();
    const last = result.current.suggestions.length - 1;
    act(() => result.current.setActiveIndex(last));
    expect(result.current.activeIndex).toBe(last);
    // Narrow the query so the two-row list collapses to the single search row.
    await act(async () => {
      rerender({ query: 'examplezzz' });
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    });
    expect(result.current.suggestions.length).toBeLessThan(last + 1);
    expect(result.current.activeIndex).toBeLessThanOrEqual(result.current.suggestions.length - 1);
  });

  it('clamps a cursor left past the end rather than pointing at nothing', async () => {
    const { result, rerender } = mountWithRows();
    await settle();
    act(() => result.current.setActiveIndex(result.current.suggestions.length - 1));
    await act(async () => {
      rerender({ query: 'example one' });
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    });
    expect(result.current.activeIndex).toBeLessThanOrEqual(result.current.suggestions.length - 1);
  });

  // A background history refresh returning the same NUMBER of rows must not throw away
  // the user's arrow-key position — that is what the clamp is keyed on.
  it('preserves the cursor across a refresh that keeps the same row count', async () => {
    const { result } = mountWithRows();
    await settle();
    act(() => result.current.moveActive(1));
    act(() => result.current.moveActive(1));
    const position = result.current.activeIndex;
    expect(position).toBeGreaterThan(0);
    historySearch.mockResolvedValue([
      entry({ id: 1, title: 'Example One', url: 'https://one.test/' }),
      entry({ id: 2, title: 'Example Two', url: 'https://two.test/' }),
    ]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEBOUNCE + 10);
    });
    expect(result.current.suggestions.length).toBeGreaterThan(position);
    expect(result.current.activeIndex).toBe(position);
  });
});
