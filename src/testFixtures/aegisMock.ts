// Shared aegis IPC mock for use across test files.
// Extracted from src/App.test.tsx so registration.test.tsx and future tour tests
// can reuse it without duplicating the object.
import { vi } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../../shared/types';

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

export function aegisMockModule() {
  return {
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
        setLayout: vi.fn(async () => {}),
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
      redirect: {
        onBlocked: vi.fn().mockReturnValue(() => {}),
      },
      lists: { updateNow: vi.fn().mockResolvedValue({ perSource: [], lastUpdated: 0 }) },
      sync: {
        getState: vi.fn().mockResolvedValue({
          enabled: false, status: 'disabled', serverUrl: '', lastSyncMs: 0,
          lastError: '', deviceId: '', accountId: '', vaultBacking: 'none',
        }),
        enableNew: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
        enableFromPhrase: vi.fn().mockResolvedValue({}),
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
      picker: {
        start: vi.fn().mockResolvedValue({ ok: false }),
      },
      update: {
        getState: vi.fn().mockResolvedValue({ status: 'idle', version: null, percent: 0, error: null }),
        checkNow: vi.fn().mockResolvedValue(undefined),
        restartToInstall: vi.fn().mockResolvedValue(undefined),
        onState: vi.fn().mockReturnValue(() => {}),
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
        onState: vi.fn(() => () => {}),
        onShortcut: vi.fn(() => () => {}),
      },
    },
  };
}
