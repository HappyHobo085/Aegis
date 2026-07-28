// src/lib/commandPaletteData.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { TabsState, Favorite, HistoryEntry } from '../../shared/types';

// Mock ipcClient before importing the module under test
vi.mock('./ipcClient', () => ({
  aegis: {
    tabs: {
      list: vi.fn(),
      activate: vi.fn(),
      create: vi.fn(),
    },
    favorites: {
      list: vi.fn(),
    },
    history: {
      list: vi.fn(),
    },
    nav: {
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reloadOrStop: vi.fn(),
      home: vi.fn(),
    },
    zoom: {
      get: vi.fn(),
      set: vi.fn(),
      reset: vi.fn(),
    },
    adblock: {
      getState: vi.fn(),
      setEnabled: vi.fn(),
    },
  },
}));

// Mock SettingsModal to control TAB_ORDER
vi.mock('../components/SettingsModal', () => ({
  TAB_ORDER: ['appearance', 'search', 'security', 'vault'],
}));

import {
  getTabResults,
  getBookmarkResults,
  getHistoryResults,
  getActionResults,
  getSettingsResults,
} from './commandPaletteData';
import { aegis } from './ipcClient';

const mockTabs = aegis.tabs as unknown as {
  list: ReturnType<typeof vi.fn>;
  activate: ReturnType<typeof vi.fn>;
  create: ReturnType<typeof vi.fn>;
};
const mockFavs = aegis.favorites as unknown as {
  list: ReturnType<typeof vi.fn>;
};
const mockHistory = aegis.history as unknown as {
  list: ReturnType<typeof vi.fn>;
};
const mockNav = aegis.nav as unknown as {
  navigate: ReturnType<typeof vi.fn>;
  back: ReturnType<typeof vi.fn>;
  forward: ReturnType<typeof vi.fn>;
  reloadOrStop: ReturnType<typeof vi.fn>;
  home: ReturnType<typeof vi.fn>;
};
const mockZoom = aegis.zoom as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};
const mockAdblock = aegis.adblock as unknown as {
  getState: ReturnType<typeof vi.fn>;
  setEnabled: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  mockTabs.list.mockResolvedValue({
    tabs: [
      {
        id: 1,
        title: 'GitHub',
        url: 'https://github.com',
        pinned: false,
        live: true,
        private: false,
        workspaceId: '',
      },
      {
        id: 2,
        title: 'YouTube',
        url: 'https://youtube.com',
        pinned: false,
        live: true,
        private: false,
        workspaceId: '',
      },
      {
        id: 3,
        title: '',
        url: 'https://example.com',
        pinned: false,
        live: true,
        private: true,
        workspaceId: '',
      },
    ] as TabsState['tabs'],
    activeId: 1,
  } satisfies TabsState);
  mockFavs.list.mockResolvedValue([
    { id: 1, name: 'GitHub', url: 'https://github.com', position: 0 },
    { id: 2, name: 'Stack Overflow', url: 'https://stackoverflow.com', position: 1 },
  ] as Favorite[]);
  mockHistory.list.mockResolvedValue([
    { id: 1, url: 'https://github.com', title: 'GitHub', visitedAt: Date.now() },
    { id: 2, url: 'https://example.com', title: 'Example', visitedAt: Date.now() },
  ] as HistoryEntry[]);
  mockZoom.get.mockResolvedValue({ viewId: 1, factor: 1.0 });
  mockAdblock.getState.mockResolvedValue({
    enabled: true,
    allowlistedHosts: [],
    sessionBlocked: 0,
  });
});

describe('getTabResults', () => {
  it('returns matching tabs', async () => {
    const results = await getTabResults('git');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('GitHub');
    expect(results[0].category).toBe('tabs');
    expect(results[0].icon).toBe('📄');
  });

  it('marks private tabs with spy icon', async () => {
    const results = await getTabResults('example');
    expect(results.length).toBe(1);
    expect(results[0].icon).toBe('🕵️');
  });

  it('returns empty for no matches', async () => {
    const results = await getTabResults('nonexistent');
    expect(results).toEqual([]);
  });

  it('calls aegis.tabs.list', async () => {
    await getTabResults('anything');
    expect(mockTabs.list).toHaveBeenCalled();
  });

  it('action calls tabs.activate with correct id', async () => {
    const results = await getTabResults('YouTube');
    results[0].action();
    expect(mockTabs.activate).toHaveBeenCalledWith(2);
  });
});

describe('getBookmarkResults', () => {
  it('returns matching bookmarks', async () => {
    const results = await getBookmarkResults('git');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('GitHub');
    expect(results[0].category).toBe('bookmarks');
    expect(results[0].icon).toBe('⭐');
  });

  it('returns empty for no matches', async () => {
    const results = await getBookmarkResults('xyz');
    expect(results).toEqual([]);
  });

  it('action navigates to bookmark URL', async () => {
    const results = await getBookmarkResults('GitHub');
    results[0].action();
    expect(mockNav.navigate).toHaveBeenCalledWith(1, 'https://github.com');
  });
});

describe('getHistoryResults', () => {
  it('returns matching history entries', async () => {
    const results = await getHistoryResults('git');
    expect(results.length).toBe(1);
    expect(results[0].title).toBe('GitHub');
    expect(results[0].category).toBe('history');
    expect(results[0].icon).toBe('🕐');
  });

  it('returns empty for no matches', async () => {
    const results = await getHistoryResults('zzz');
    expect(results).toEqual([]);
  });

  it('calls aegis.history.list with limit', async () => {
    await getHistoryResults('test');
    expect(mockHistory.list).toHaveBeenCalledWith({ limit: 200 });
  });
});

describe('getActionResults', () => {
  it('returns all actions when query is empty', () => {
    const results = getActionResults('');
    expect(results.length).toBeGreaterThan(0);
  });

  it('filters actions by title', () => {
    const results = getActionResults('zoom');
    expect(results.length).toBe(3); // zoom in, zoom out, reset zoom
    expect(results.map((r) => r.id)).toContain('action.zoomIn');
    expect(results.map((r) => r.id)).toContain('action.zoomOut');
    expect(results.map((r) => r.id)).toContain('action.zoomReset');
  });

  it('filters actions by subtitle', () => {
    const results = getActionResults('incognito');
    expect(results.length).toBe(1);
    expect(results[0].id).toBe('action.newPrivateTab');
  });

  it('all actions have required fields', () => {
    const results = getActionResults('');
    for (const r of results) {
      expect(r.id).toBeTruthy();
      expect(r.title).toBeTruthy();
      expect(r.category).toBe('actions');
      expect(typeof r.action).toBe('function');
    }
  });

  it('includes all requested actions', () => {
    const results = getActionResults('');
    const ids = results.map((r) => r.id);
    expect(ids).toContain('action.newTab');
    expect(ids).toContain('action.newPrivateTab');
    expect(ids).toContain('action.back');
    expect(ids).toContain('action.forward');
    expect(ids).toContain('action.reload');
    expect(ids).toContain('action.home');
    expect(ids).toContain('action.zoomIn');
    expect(ids).toContain('action.zoomOut');
    expect(ids).toContain('action.zoomReset');
    expect(ids).toContain('action.findInPage');
    expect(ids).toContain('action.toggleAdblock');
    expect(ids).toContain('action.toggleSidebar');
    expect(ids).toContain('action.toggleFavoritesBar');
  });

  it('toggleAdblock action calls setEnabled with toggled state', async () => {
    const results = getActionResults('ad-block');
    const toggleResult = results.find((r) => r.id === 'action.toggleAdblock');
    expect(toggleResult).toBeDefined();
    await toggleResult!.action();
    expect(mockAdblock.setEnabled).toHaveBeenCalledWith(false); // was true, toggles to false
  });

  it('zoomIn action reads current factor and increments', async () => {
    mockZoom.get.mockResolvedValue({ viewId: 1, factor: 1.2 });
    const results = getActionResults('zoom in');
    const zoomInResult = results.find((r) => r.id === 'action.zoomIn');
    expect(zoomInResult).toBeDefined();
    await zoomInResult!.action();
    expect(mockZoom.get).toHaveBeenCalledWith(1);
    expect(mockZoom.set).toHaveBeenCalledWith(1, 1.3);
  });
});

describe('getSettingsResults', () => {
  it('returns matching settings tabs', () => {
    const results = getSettingsResults('sec');
    // 'sec' matches 'security' (contains) and 'search' (fuzzy: s,e,c)
    expect(results.length).toBe(2);
    expect(results.map((r) => r.title)).toContain('Security');
    expect(results[0].category).toBe('settings');
  });

  it('returns all settings when query is empty', () => {
    const results = getSettingsResults('');
    expect(results.length).toBe(4); // mocked TAB_ORDER has 4 entries
  });

  it('all results have required fields', () => {
    const results = getSettingsResults('');
    for (const r of results) {
      expect(r.id).toMatch(/^settings:/);
      expect(r.title).toBeTruthy();
      expect(r.category).toBe('settings');
      expect(typeof r.action).toBe('function');
      expect(r.icon).toBeTruthy();
    }
  });

  it('action dispatches openSettings event with tab detail', () => {
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    const results = getSettingsResults('appearance');
    results[0].action();
    expect(dispatchSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'aegis:openSettings',
        detail: { tab: 'appearance' },
      }),
    );
    dispatchSpy.mockRestore();
  });
});
