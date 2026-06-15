import { renderHook, act, waitFor } from '@testing-library/react';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { useTabs } from './useTabs';
import { aegis } from '../lib/ipcClient';

vi.mock('../lib/ipcClient', () => {
  const listeners: Array<(s: unknown) => void> = [];
  return {
    aegis: {
      tabs: {
        list: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
        create: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }, { id: 2, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 2 }),
        close: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
        activate: vi.fn().mockResolvedValue({ tabs: [], activeId: 2 }),
        reorder: vi.fn().mockResolvedValue({ tabs: [], activeId: 1 }),
        setPinned: vi.fn().mockResolvedValue({ tabs: [], activeId: 1 }),
        reopenClosed: vi.fn().mockResolvedValue({ tabs: [], activeId: 1 }),
        onState: vi.fn((cb: (s: unknown) => void) => { listeners.push(cb); return () => {}; }),
        __emit: (s: unknown) => listeners.forEach((f) => f(s)),
      },
    },
  };
});

describe('useTabs', () => {
  beforeEach(() => vi.clearAllMocks());

  it('loads the initial tab list', async () => {
    const { result } = renderHook(() => useTabs());
    await waitFor(() => expect(result.current.tabs.length).toBe(1));
    expect(result.current.activeId).toBe(1);
  });

  it('create() sends the command and updates state', async () => {
    const { result } = renderHook(() => useTabs());
    await waitFor(() => expect(result.current.tabs.length).toBe(1));
    await act(async () => { await result.current.create(); });
    expect(aegis.tabs.create).toHaveBeenCalled();
    expect(result.current.activeId).toBe(2);
  });

  it('applies tabs.state events from the backend (idle sweep, new-window)', async () => {
    const { result } = renderHook(() => useTabs());
    await waitFor(() => expect(result.current.tabs.length).toBe(1));
    act(() => {
      (aegis.tabs as unknown as { __emit: (s: unknown) => void }).__emit({
        tabs: [{ id: 1, pinned: false, live: false, title: '', url: 'about:blank' }], activeId: 1,
      });
    });
    expect(result.current.tabs[0].live).toBe(false);
  });
});
