// Shared aegis IPC mock for use across test files.
// Extracted from src/App.test.tsx so registration.test.tsx and future tour tests
// can reuse it without duplicating the object.
import { vi } from 'vitest';
import { PRIMARY_VIEW_ID } from '../../shared/types';
import type {
  NavState,
  NavFailed,
  NavCrashed,
  Settings,
  FingerprintState,
  ProxyState,
} from '../../shared/types';

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

export function aegisMockModule() {
  return {
    // Standalone mobile-only functions exported from ipcClient (no-ops off Android;
    // the mobile tour needs these exported so MobileApp.tsx can import them).
    setBackInterceptActive: vi.fn(),
    setBottomBarHidden: vi.fn(),
    setFullscreen: vi.fn(),
    activateTab: vi.fn(),
    closeTab: vi.fn(),
    discardTab: vi.fn(),
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
        // Optional methods (Tauri desktop — called with ?. in App.tsx and catalog)
        setSidebar: vi.fn(async () => {}),
        setLayout: vi.fn(async () => {}),
        setFullscreen: vi.fn(async () => {}),
        onFullscreen: vi.fn().mockReturnValue(() => {}),
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
      redirect: {
        onBlocked: vi.fn().mockReturnValue(() => {}),
      },
      lists: {
        updateNow: vi.fn().mockResolvedValue(undefined),
        onUpdateResult: vi.fn().mockReturnValue(() => {}),
      },
      sync: (() => {
        const baseSyncState = {
          enabled: false,
          status: 'disabled' as const,
          serverUrl: '',
          lastSyncMs: 0,
          lastError: '',
          deviceId: '',
          accountId: '',
          vaultBacking: 'none' as const,
          hasStoredRoot: false,
        };
        return {
          getState: vi.fn().mockResolvedValue(baseSyncState),
          enableNew: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
          enableFromPhrase: vi
            .fn()
            .mockResolvedValue({ ...baseSyncState, enabled: true, status: 'idle' as const }),
          unlock: vi
            .fn()
            .mockResolvedValue({ ...baseSyncState, enabled: true, status: 'idle' as const }),
          disable: vi.fn().mockResolvedValue(baseSyncState),
          syncNow: vi.fn().mockResolvedValue({ ...baseSyncState, lastSyncMs: Date.now() }),
          testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 5 }),
          getRecoveryPhrase: vi.fn().mockResolvedValue({ recoveryPhrase: '' }),
          listDevices: vi.fn().mockResolvedValue([]),
          removeDevice: vi.fn().mockResolvedValue([]),
          onState: vi.fn().mockReturnValue(() => {}),
          onChanged: vi.fn().mockReturnValue(() => {}),
        };
      })(),
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
        getState: vi
          .fn()
          .mockResolvedValue({ status: 'idle', version: null, percent: 0, error: null }),
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
      find: {
        start: vi.fn(async () => {}),
        next: vi.fn(async () => {}),
        prev: vi.fn(async () => {}),
        close: vi.fn(async () => {}),
        onState: vi.fn().mockReturnValue(() => {}),
      },
      zoom: {
        get: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
        set: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
        reset: vi.fn().mockResolvedValue({ viewId: PRIMARY_VIEW_ID, factor: 1.0 }),
        onChanged: vi.fn().mockReturnValue(() => {}),
      },
      fingerprint: {
        getState: vi
          .fn()
          .mockResolvedValue({ level: 'off', allowlistedHosts: [] } satisfies FingerprintState),
        toggleAllowlist: vi
          .fn()
          .mockResolvedValue({ level: 'off', allowlistedHosts: [] } satisfies FingerprintState),
        removeAllowlist: vi
          .fn()
          .mockResolvedValue({ level: 'off', allowlistedHosts: [] } satisfies FingerprintState),
        clearAllowlist: vi
          .fn()
          .mockResolvedValue({ level: 'off', allowlistedHosts: [] } satisfies FingerprintState),
      },
      proxy: (() => {
        const baseProxyState: ProxyState = {
          mode: 'off',
          scheme: 'http',
          host: '',
          port: 8080,
          bypassHosts: [],
          active: false,
          uri: null,
        };
        return {
          getState: vi.fn().mockResolvedValue(baseProxyState),
          setConfig: vi.fn().mockResolvedValue(baseProxyState),
          clear: vi.fn().mockResolvedValue(baseProxyState),
          testConnection: vi.fn().mockResolvedValue({ ok: true, latencyMs: 1 }),
          onState: vi.fn().mockReturnValue(() => {}),
        };
      })(),
      vault: {
        getState: vi
          .fn()
          .mockResolvedValue({ exists: false, unlocked: false, count: 0, undecryptable: 0 }),
        create: vi
          .fn()
          .mockResolvedValue({ exists: true, unlocked: true, count: 0, undecryptable: 0 }),
        unlock: vi
          .fn()
          .mockResolvedValue({ exists: true, unlocked: true, count: 0, undecryptable: 0 }),
        lock: vi
          .fn()
          .mockResolvedValue({ exists: true, unlocked: false, count: 0, undecryptable: 0 }),
        list: vi.fn().mockResolvedValue([]),
        add: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue([]),
        remove: vi.fn().mockResolvedValue([]),
        search: vi.fn().mockResolvedValue([]),
        onState: vi.fn().mockReturnValue(() => {}),
      },
      tabs: {
        list: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        create: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        close: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        activate: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        reorder: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        setPinned: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        reopenClosed: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        setTitle: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        recordNav: vi.fn().mockResolvedValue({
          tabs: [
            { id: 1, pinned: false, live: true, title: '', url: 'about:blank', private: false },
          ],
          activeId: 1,
        }),
        onState: vi.fn(() => () => {}),
        onShortcut: vi.fn(() => () => {}),
      },
    },
  };
}
