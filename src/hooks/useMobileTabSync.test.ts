import { renderHook } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TabMeta } from '../../shared/types';

const { activateTab, closeTab, discardTab } = vi.hoisted(() => ({
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  discardTab: vi.fn(),
}));
vi.mock('../lib/ipcClient', () => ({ activateTab, closeTab, discardTab }));

import { useMobileTabSync } from './useMobileTabSync';

const t = (id: number, over: Partial<TabMeta> = {}): TabMeta =>
  ({ id, pinned: false, live: true, title: '', url: `https://t${id}.test/`, ...over });

beforeEach(() => { activateTab.mockClear(); closeTab.mockClear(); discardTab.mockClear(); });

describe('useMobileTabSync', () => {
  it('activates the active tab on mount', () => {
    renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1)], activeId: 1 },
    });
    expect(activateTab).toHaveBeenCalledWith(1, 'https://t1.test/');
  });
  it('activates the new active tab when activeId changes', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2)], activeId: 1 },
    });
    activateTab.mockClear();
    rerender({ tabs: [t(1), t(2)], activeId: 2 });
    expect(activateTab).toHaveBeenCalledWith(2, 'https://t2.test/');
  });
  it('closes a tab that disappeared from the list', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2)], activeId: 1 },
    });
    rerender({ tabs: [t(1)], activeId: 1 });
    expect(closeTab).toHaveBeenCalledWith(2);
  });
  it('discards a tab that went live -> not live', () => {
    const { rerender } = renderHook(({ tabs, activeId }) => useMobileTabSync(tabs, activeId), {
      initialProps: { tabs: [t(1), t(2, { live: true })], activeId: 1 },
    });
    rerender({ tabs: [t(1), t(2, { live: false })], activeId: 1 });
    expect(discardTab).toHaveBeenCalledWith(2);
  });
});
