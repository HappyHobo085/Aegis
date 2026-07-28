// src/components/mobile/MobileApp.test.tsx
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
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
  httpsOnly: true,
  tabIdleTimeout: 30,
  webrtcPolicy: 'public-only',
  themeMode: 'system',
  antiFingerprint: 'off',
};

// Spy on applyTheme so mount tests can assert it was called with the full settings.
const applyThemeSpy = vi.fn();
const watchSystemThemeCleanup = vi.fn();
vi.mock('../../lib/theme', () => ({
  applyTheme: (...a: unknown[]) => applyThemeSpy(...a),
  watchSystemTheme: (_cb: () => void) => watchSystemThemeCleanup,
}));

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
      getState: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      setEnabled: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      toggleAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      removeAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      clearAllowlist: vi
        .fn()
        .mockResolvedValue({ enabled: true, allowlistedHosts: [], sessionBlocked: 0 }),
      onBlockedCount: vi.fn().mockReturnValue(() => {}),
    },
    lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
    sync: {
      getState: vi.fn().mockResolvedValue({
        enabled: false,
        status: 'disabled',
        serverUrl: '',
        lastSyncMs: 0,
        lastError: '',
        deviceId: '',
        accountId: '',
        vaultBacking: 'none',
        hasStoredRoot: false,
      }),
      enableNew: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
      enableFromPhrase: vi.fn().mockResolvedValue({}),
      unlock: vi.fn().mockResolvedValue({}),
      disable: vi.fn().mockResolvedValue({}),
      syncNow: vi.fn().mockResolvedValue({}),
      getRecoveryPhrase: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
      listDevices: vi.fn().mockResolvedValue([]),
      removeDevice: vi.fn().mockResolvedValue([]),
      onState: vi.fn().mockReturnValue(() => {}),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
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
    find: {
      start: vi.fn().mockResolvedValue(undefined),
      next: vi.fn().mockResolvedValue(undefined),
      prev: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    vault: {
      getState: vi.fn().mockResolvedValue({ exists: false, unlocked: false, count: 0 }),
      create: vi.fn().mockResolvedValue({ exists: true, unlocked: true, count: 0 }),
      unlock: vi.fn().mockResolvedValue({ exists: true, unlocked: true, count: 0 }),
      lock: vi.fn().mockResolvedValue({ exists: true, unlocked: false, count: 0 }),
      list: vi.fn().mockResolvedValue([]),
      add: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue([]),
      remove: vi.fn().mockResolvedValue([]),
      search: vi.fn().mockResolvedValue([]),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    zoom: {
      get: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      set: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      reset: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
      onChanged: vi.fn().mockReturnValue(() => {}),
    },
    safety: {
      getState: vi.fn().mockResolvedValue(null),
      proceed: vi.fn(),
      listExceptions: vi.fn().mockResolvedValue([]),
      removeException: vi.fn(),
      onInterstitial: vi.fn(() => () => {}),
    },
    fingerprint: {
      getState: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      toggleAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      removeAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
      clearAllowlist: vi.fn().mockResolvedValue({ level: 'off', allowlistedHosts: [] }),
    },
    proxy: {
      getState: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      setConfig: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      clear: vi.fn().mockResolvedValue({
        mode: 'off',
        scheme: 'http',
        host: '',
        port: 8080,
        bypassHosts: [],
        active: false,
        uri: null,
      }),
      testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
      onState: vi.fn().mockReturnValue(() => {}),
    },
    tabs: {
      list: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      create: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      close: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      activate: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      reorder: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      setPinned: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      reopenClosed: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      setTitle: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
      recordNav: vi.fn().mockResolvedValue({
        tabs: [{ id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false }],
        activeId: 1,
      }),
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

import { aegis } from '../../lib/ipcClient';
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
  it('enters fullscreen from the bottom bar, hiding all chrome', async () => {
    render(<MobileApp />);
    fireEvent.click(await screen.findByRole('button', { name: /enter fullscreen/i }));
    expect(screen.queryByRole('navigation', { name: /browser actions/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /enter fullscreen/i })).toBeNull();
  });

  it('calls applyTheme with the full settings (incl. themeMode) on mount', async () => {
    applyThemeSpy.mockClear();
    render(<MobileApp />);
    // Wait for the mount effect to fire: settings.get resolves and applyTheme is called.
    await waitFor(() => expect(applyThemeSpy).toHaveBeenCalled());
    const [called] = applyThemeSpy.mock.calls[0] as [Record<string, unknown>];
    expect(called).toMatchObject({ primaryColor: '#4f8cff', themeMode: 'system' });
  });

  it('records mobile native nav state back into the persistent tab registry', async () => {
    render(<MobileApp />);
    await waitFor(() =>
      expect(aegis.tabs.recordNav).toHaveBeenCalledWith(1, 'https://example.com/', 'Example'),
    );
  });
});
