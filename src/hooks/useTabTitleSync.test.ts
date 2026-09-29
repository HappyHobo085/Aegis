// src/hooks/useTabTitleSync.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import type { NavState } from '../../shared/types';

const navOnState = vi.fn();
const setTitle = vi.fn();
const tabsState = { tabs: [], activeId: 1 };

vi.mock('../lib/ipcClient', () => ({
  aegis: {
    nav: { onState: (cb: (s: NavState) => void) => navOnState(cb) },
    tabs: { setTitle: (id: number, title: string) => setTitle(id, title) },
  },
}));

import { useTabTitleSync } from './useTabTitleSync';

const state = (over: Partial<NavState> = {}): NavState => ({
  viewId: 1,
  url: 'https://example.test/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
  ...over,
});

let emit: ((s: NavState) => void) | undefined;

beforeEach(() => {
  vi.clearAllMocks();
  tabsState.activeId = 1;
  navOnState.mockImplementation((cb: (s: NavState) => void) => {
    emit = cb;
    return vi.fn();
  });
  setTitle.mockResolvedValue(tabsState);
  emit = undefined;
});
afterEach(() => vi.restoreAllMocks());

describe('useTabTitleSync', () => {
  it('sends a title for a tab whose page renamed itself', () => {
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox (4) — Example' }));

    // The tab that renamed itself, not the active one: the strip shows every tab.
    expect(setTitle).toHaveBeenCalledWith(3, 'Inbox (4) — Example');
  });

  it('does not re-send a title it has already sent for that tab', () => {
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    emit?.(state({ viewId: 3, title: 'Inbox' }));

    // nav.state also fires on progress and at page load, so an unchanged title is
    // the common case; each one would otherwise be a write plus an emit_and_persist.
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it('sends again once the title actually changes', () => {
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    emit?.(state({ viewId: 3, title: 'Inbox (4)' }));

    expect(setTitle).toHaveBeenCalledTimes(2);
    expect(setTitle).toHaveBeenLastCalledWith(3, 'Inbox (4)');
  });

  it('tracks each tab separately', () => {
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 1, title: 'One' }));
    emit?.(state({ viewId: 2, title: 'Two' }));
    // Tab 1 repeating its own title must not be suppressed by tab 2's value.
    emit?.(state({ viewId: 1, title: 'One' }));
    emit?.(state({ viewId: 2, title: 'Two' }));

    expect(setTitle.mock.calls).toEqual([
      [1, 'One'],
      [2, 'Two'],
    ]);
  });

  it('ignores an empty title rather than blanking the tab', () => {
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    emit?.(state({ viewId: 3, title: '' }));
    emit?.(state({ viewId: 3, title: '   ' }));

    // A page mid-load reports no title; clearing it would make the strip fall
    // back to the URL, which is a worse answer than the last good title.
    expect(setTitle).toHaveBeenCalledTimes(1);
  });

  it('stops listening and forgets what it had sent on unmount', () => {
    const un = vi.fn();
    navOnState.mockImplementation((cb: (s: NavState) => void) => {
      emit = cb;
      return un;
    });
    const { unmount } = renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    expect(setTitle).toHaveBeenCalledTimes(1);

    unmount();
    expect(un).toHaveBeenCalledTimes(1);

    // Re-mounting starts from empty, so a page still reporting the same title
    // after a remount is re-sent rather than silently suppressed forever.
    renderHook(() => useTabTitleSync());
    emit?.(state({ viewId: 3, title: 'Inbox' }));
    expect(setTitle).toHaveBeenCalledTimes(2);
  });
});
