// src/hooks/useDownloadToasts.test.tsx
//
// The download toast stream. Two contracts carry real weight:
//   1. The FIRST render must be silent. On mount the list is whatever the core already
//      knows, so toasting it would fire "Downloaded x." for every completed file the
//      user did not start in this session.
//   2. A state TRANSITION toasts, and the completed toast's "Open" action must reach
//      the core with the right id.
//
// Asserted against the REAL toast store (subscribeToasts) rather than a spy, so this
// also covers the message text, the kind, the duration and the action wiring as the
// Toaster would actually receive them.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { DownloadEntry } from '../../shared/types';
import { subscribeToasts, __resetToasts, type ToastItem } from '../lib/toast';
import { useDownloadToasts } from './useDownloadToasts';

const dl = (over: Partial<DownloadEntry> = {}): DownloadEntry =>
  ({
    id: 1,
    filename: 'report.pdf',
    state: 'progressing',
    ...over,
  }) as DownloadEntry;

const actions = () => ({
  openFile: vi.fn().mockResolvedValue(undefined),
  showInFolder: vi.fn(),
});

/** Collect the real toasts the hook pushes. */
function watchToasts() {
  const seen: ToastItem[] = [];
  const off = subscribeToasts((list) => {
    seen.length = 0;
    seen.push(...list);
  });
  return { seen, off, messages: () => seen.map((t) => t.message) };
}

beforeEach(() => {
  __resetToasts();
  vi.useFakeTimers();
});
afterEach(() => {
  __resetToasts();
  vi.useRealTimers();
});

describe('useDownloadToasts', () => {
  it('says nothing on the first render (the pre-existing list is not news)', () => {
    const w = watchToasts();
    renderHook(() => useDownloadToasts([dl({ state: 'completed' })], actions()));
    expect(w.seen).toEqual([]);
    w.off();
  });

  it('toasts "Downloading" when a progressing download first appears', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ id: 2, filename: 'new.pdf', state: 'progressing' })] });
    expect(w.messages()).toEqual(['Downloading new.pdf…']);
    expect(w.seen[0].kind).toBe('info');
    expect(w.seen[0].durationMs).toBe(3000);
    w.off();
  });

  it('toasts once for the start, not on every re-render while progressing', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    const started = [dl({ id: 2, filename: 'new.pdf' })];
    rerender({ list: started });
    rerender({ list: started });
    rerender({ list: started });
    expect(w.messages()).toHaveLength(1);
    w.off();
  });

  it('toasts "Downloaded" with a 7s duration on completion', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ state: 'completed' })] });
    expect(w.messages()).toEqual(['Downloaded report.pdf.']);
    expect(w.seen[0].durationMs).toBe(7000);
    w.off();
  });

  it('an interrupted download raises an ERROR toast', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ state: 'interrupted' })] });
    expect(w.messages()).toEqual(['Download failed: report.pdf.']);
    expect(w.seen[0].kind).toBe('error');
    w.off();
  });

  it('a cancelled download is informational, not an error', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ state: 'cancelled' })] });
    expect(w.messages()).toEqual(['Download cancelled: report.pdf.']);
    expect(w.seen[0].kind).toBe('info');
    expect(w.seen[0].durationMs).toBe(3000);
    w.off();
  });

  it("the completed toast's Open action opens THAT download", () => {
    const w = watchToasts();
    const a = actions();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, a), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ id: 42, state: 'completed' })] });
    expect(w.seen[0].action?.label).toBe('Open');
    w.seen[0].action?.onClick();
    expect(a.openFile).toHaveBeenCalledWith(42);
    w.off();
  });

  it('does not re-toast a completion that is still there on the next render', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    const done = [dl({ state: 'completed' })];
    rerender({ list: done });
    rerender({ list: done });
    expect(w.messages().filter((m) => m.startsWith('Downloaded'))).toHaveLength(1);
    w.off();
  });

  it('tracks each download independently', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl({ id: 1 }), dl({ id: 2, filename: 'b.pdf' })] },
    });
    rerender({ list: [dl({ id: 1, state: 'completed' }), dl({ id: 2, filename: 'b.pdf' })] });
    const msgs = w.messages();
    expect(msgs).toContain('Downloaded report.pdf.');
    expect(msgs).not.toContain('Downloaded b.pdf.');
    w.off();
  });

  it('a download removed from the list is forgotten, so re-adding looks new', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl({ id: 1 }), dl({ id: 2, filename: 'b.pdf' })] },
    });
    rerender({ list: [dl({ id: 2, filename: 'b.pdf' })] });
    rerender({ list: [dl({ id: 1 }), dl({ id: 2, filename: 'b.pdf' })] });
    expect(w.messages()).toContain('Downloading report.pdf…');
    w.off();
  });

  it('a different id for the same filename is treated as a new download', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [dl()] },
    });
    rerender({ list: [dl({ id: 2 })] });
    expect(w.messages()).toEqual(['Downloading report.pdf…']);
    w.off();
  });

  it('says nothing for an empty list', () => {
    const w = watchToasts();
    renderHook(() => useDownloadToasts([], actions()));
    expect(w.seen).toEqual([]);
    w.off();
  });

  it('a full lifecycle start → complete produces exactly the two toasts', () => {
    const w = watchToasts();
    const { rerender } = renderHook(({ list }) => useDownloadToasts(list, actions()), {
      initialProps: { list: [] as DownloadEntry[] },
    });
    rerender({ list: [dl({ id: 1, state: 'progressing' })] });
    rerender({ list: [dl({ id: 1, state: 'completed' })] });
    expect(w.messages()).toEqual(['Downloading report.pdf…', 'Downloaded report.pdf.']);
    w.off();
  });
});
