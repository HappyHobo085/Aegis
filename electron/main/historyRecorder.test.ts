// electron/main/historyRecorder.test.ts
import { describe, it, expect, vi } from 'vitest';
import { HistoryRecorder } from './historyRecorder';

type Handler = (...args: any[]) => void;

/** A fake WebContents that captures .on handlers and exposes a current title/url. */
function makeFakeWc(title = 'Page Title', url = 'https://example.com/') {
  const handlers = new Map<string, Handler[]>();
  return {
    title,
    url,
    on(event: string, fn: Handler) {
      const arr = handlers.get(event) ?? [];
      arr.push(fn);
      handlers.set(event, arr);
      return this;
    },
    getTitle() {
      return this.title;
    },
    getURL() {
      return this.url;
    },
    /** Fire every handler registered for an event (mimics EventEmitter emit). */
    fire(event: string, ...args: any[]) {
      for (const fn of handlers.get(event) ?? []) fn({}, ...args);
    },
    /** Number of handlers registered for an event. */
    count(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

/** A fake HistoryRepo: spy methods only (no DB, no timestamps). */
function makeFakeRepo() {
  return {
    record: vi.fn(),
    setMostRecentTitle: vi.fn(),
    mostRecent: vi.fn(),
  };
}

describe('HistoryRecorder', () => {
  it('subscribes to did-navigate, did-navigate-in-page, and page-title-updated', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged: vi.fn() });
    expect(wc.count('did-navigate')).toBe(1);
    expect(wc.count('did-navigate-in-page')).toBe(1);
    expect(wc.count('page-title-updated')).toBe(1);
  });

  it('records {url, current title} and fires onChanged on did-navigate', () => {
    const wc = makeFakeWc('Example Title');
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'https://example.com/page');
    expect(repo.record).toHaveBeenCalledWith({ url: 'https://example.com/page', title: 'Example Title' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('records on a main-frame did-navigate-in-page (SPA)', () => {
    const wc = makeFakeWc('SPA Title');
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate-in-page', 'https://spa.test/route', true);
    expect(repo.record).toHaveBeenCalledWith({ url: 'https://spa.test/route', title: 'SPA Title' });
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores a non-main-frame did-navigate-in-page', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate-in-page', 'https://spa.test/iframe', false);
    expect(repo.record).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('skips non-http(s) urls (about:blank, file:, app urls)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'about:blank');
    wc.fire('did-navigate', 'file:///home/x/out/renderer/index.html');
    wc.fire('did-navigate-in-page', 'about:blank', true);
    expect(repo.record).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('updates the most-recent title and fires onChanged on page-title-updated (after a nav)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('did-navigate', 'https://example.com/page');
    onChanged.mockClear();
    wc.fire('page-title-updated', 'Updated Title');
    expect(repo.setMostRecentTitle).toHaveBeenCalledWith('https://example.com/page', 'Updated Title');
    expect(onChanged).toHaveBeenCalledTimes(1);
  });

  it('ignores page-title-updated before any recordable nav (no lastUrl yet)', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const onChanged = vi.fn();
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged });
    wc.fire('page-title-updated', 'Title With No Page');
    expect(repo.setMostRecentTitle).not.toHaveBeenCalled();
    expect(onChanged).not.toHaveBeenCalled();
  });

  it('honors a custom isRecordable predicate', () => {
    const wc = makeFakeWc();
    const repo = makeFakeRepo();
    const isRecordable = vi.fn((u: string) => u.includes('allowed'));
    new HistoryRecorder({ wc: wc as any, repo: repo as any, onChanged: vi.fn(), isRecordable });
    wc.fire('did-navigate', 'https://blocked.test/');
    expect(repo.record).not.toHaveBeenCalled();
    wc.fire('did-navigate', 'https://allowed.test/');
    expect(repo.record).toHaveBeenCalledTimes(1);
  });
});
