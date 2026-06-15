// src/components/mobile/MobileApp.test.tsx
import { render, screen, fireEvent } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { NavState, Settings } from '../../../shared/types';
import { PRIMARY_VIEW_ID } from '../../../shared/types';

const baseState: NavState = {
  viewId: PRIMARY_VIEW_ID,
  url: 'https://example.com/',
  title: 'Example',
  canGoBack: false,
  canGoForward: false,
  isLoading: false,
  crashed: false,
};

const baseSettings: Settings = {
  homeUrl: 'https://duckduckgo.com/',
  primaryColor: '#4f8cff',
  defaultSearchTemplate: 'https://duckduckgo.com/?q=%s',
  searchEngines: [],
  hideChromeByDefault: false,
  downloadDir: '',
};

vi.mock('../../lib/ipcClient', () => ({
  aegis: {
    nav: {
      navigate: vi.fn(async () => {}),
      back: vi.fn(async () => {}),
      forward: vi.fn(async () => {}),
      reloadOrStop: vi.fn(async () => {}),
      home: vi.fn(async () => {}),
      getState: vi.fn(async () => baseState),
      onState: vi.fn().mockReturnValue(() => {}),
      onFailed: vi.fn().mockReturnValue(() => {}),
      onCrashed: vi.fn().mockReturnValue(() => {}),
    },
    view: {
      setContentVisible: vi.fn(async () => {}),
      setContentInset: vi.fn(async () => {}),
      setChromeOverlay: vi.fn(async () => {}),
      setFullscreen: vi.fn(async () => {}),
    },
    settings: { get: vi.fn(async () => baseSettings), set: vi.fn(async () => baseSettings) },
    subs: {
      list: vi.fn(async () => []),
      setEnabled: vi.fn(async () => []),
      add: vi.fn(async () => []),
      remove: vi.fn(async () => []),
    },
    customFilters: {
      get: vi.fn(async () => ''),
      set: vi.fn(async () => ''),
    },
    adblock: {
      getState: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      removeAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      clearAllowlist: vi.fn().mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
    favorites: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      reorder: vi.fn().mockResolvedValue([]),
    },
    history: {
      list: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue(undefined),
      clear: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    saved: {
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      has: vi.fn().mockResolvedValue(false),
      update: vi.fn().mockResolvedValue([]),
      renameTag: vi.fn().mockResolvedValue([]),
      deleteTag: vi.fn().mockResolvedValue([]),
      tagUnion: vi.fn().mockResolvedValue([]),
    },
    downloads: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      openFile: vi.fn().mockResolvedValue(undefined),
      showInFolder: vi.fn().mockResolvedValue(undefined),
      cancel: vi.fn().mockResolvedValue(undefined),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    permissions: {
      list: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      clear: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue(undefined),
      onPrompt: vi.fn().mockReturnValue(() => {}),
    },
    data: {
      export: vi.fn().mockResolvedValue({ ok: false }),
      import: vi.fn().mockResolvedValue({ ok: false }),
    },
    safety: {
      getState: vi.fn().mockResolvedValue(null),
      proceed: vi.fn(),
      listExceptions: vi.fn().mockResolvedValue([]),
      removeException: vi.fn(),
      onInterstitial: vi.fn(() => () => {}),
    },
    tabs: {
      list: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      create: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      close: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      activate: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      reorder: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      setPinned: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      reopenClosed: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      setTitle: vi.fn().mockResolvedValue({ tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank' }], activeId: 1 }),
      onState: vi.fn(() => () => {}),
      onShortcut: vi.fn(() => () => {}),
    },
  },
  setBackInterceptActive: vi.fn(),
  setBottomBarHidden: vi.fn(),
  setFullscreen: vi.fn(),
  activateTab: vi.fn(),
  closeTab: vi.fn(),
  discardTab: vi.fn(),
}));

import { MobileApp } from './MobileApp';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('MobileApp', () => {
  it('renders the top bar + bottom bar (no desktop Toolbar)', async () => {
    render(<MobileApp />);
    expect(await screen.findByRole('navigation', { name: /browser actions/i })).toBeInTheDocument();
    expect(screen.queryByLabelText(/toggle sidebar/i)).toBeNull();
  });
  it('opens the menu sheet from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /menu/i }));
    expect(await screen.findByRole('dialog', { name: 'Menu' })).toBeInTheDocument();
  });
  it('opens History from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /history/i }));
    expect(await screen.findByRole('dialog', { name: 'History' })).toBeInTheDocument();
  });
  it('opens the tab switcher from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /tabs/i }));
    expect(await screen.findByRole('dialog', { name: 'Tabs' })).toBeInTheDocument();
  });
  it('opens Saved directly from the bottom bar', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /saved/i }));
    expect(await screen.findByRole('dialog', { name: 'Saved' })).toBeInTheDocument();
  });
  it('hides the bottom bar via the top-bar toggle', async () => {
    render(<MobileApp />);
    expect(await screen.findByRole('navigation', { name: /browser actions/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /hide toolbar/i }));
    expect(screen.queryByRole('navigation', { name: /browser actions/i })).toBeNull();
  });
  it('enters fullscreen from the top bar, hiding all chrome', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /enter fullscreen/i }));
    expect(screen.queryByRole('navigation', { name: /browser actions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).toBeNull();
  });
});
