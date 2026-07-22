// src/lib/ipcClient.ts
//
// The renderer's backend seam — the single module the whole React UI uses to
// reach the backend. Every method is a Tauri `invoke('ipc', {channel,…})` and
// every `onX` is a Tauri event subscription (typed by AegisApi).
import {
  AegisApi,
  NavState,
  NavFailed,
  NavCrashed,
  Favorite,
  HistoryEntry,
  SavedItem,
  Settings,
  AdblockState,
  BlockedCount,
  RedirectBlocked,
  ListUpdateResult,
  Subscription,
  DownloadEntry,
  SitePermission,
  PermissionPrompt,
  TabsState,
  TabShortcut,
  UpdateState,
  SafetyInterstitialPayload,
  SyncState,
  SyncDevice,
  SyncChanged,
  FindState,
  ZoomState,
  VaultState,
  VaultRecord,
  VaultRecordInput,
  FingerprintState,
  ProxyConfig,
  ProxyState,
  FormLoginDetectedResult,
} from '../../shared/types';
import { DEDUP_WINDOW_MS } from '../../shared/types';
import { IPC } from '../../shared/types';
import { call, on } from './tauriInvoke';
import { clampZoom } from './zoom';

type IPCChannel = (typeof IPC)[keyof typeof IPC];

// Enhanced deduplication cache with adaptive windows and telemetry
interface DedupEntry<T> {
  timestamp: number;
  promise: Promise<T>;
}

// Operations that should NEVER be deduplicated (mutations that must execute)
const NON_DEDUP_CHANNELS: Set<IPCChannel> = new Set([
  // Navigation mutations
  IPC.navNavigate,
  IPC.navBack,
  IPC.navForward,
  IPC.navReloadOrStop,
  IPC.navHome,

  // View mutations
  IPC.viewSetContentVisible,
  IPC.viewSetContentInset,
  IPC.viewSetChromeOverlay,
  IPC.viewSetSidebar,
  IPC.viewSetLayout,
  IPC.viewSetFullscreen,

  // Favorites mutations
  IPC.favoritesAdd,
  IPC.favoritesUpdate,
  IPC.favoritesRemove,
  IPC.favoritesReorder,

  // History mutations
  IPC.historyRemove,
  IPC.historyClear,

  // Saved items mutations
  IPC.savedAdd,
  IPC.savedRemove,
  IPC.savedUpdate,
  IPC.savedRenameTag,
  IPC.savedDeleteTag,

  // Subscriptions mutations
  IPC.subsSetEnabled,
  IPC.subsAdd,
  IPC.subsRemove,

  // Custom filters mutations
  IPC.customFiltersSet,

  // Adblock mutations
  IPC.adblockSetEnabled,

  // Allowlist mutations
  IPC.adblockToggleAllowlist,
  IPC.adblockRemoveAllowlist,
  IPC.adblockClearAllowlist,

  // Settings mutations
  IPC.settingsSet,

  // Vault mutations
  IPC.vaultCreate,
  IPC.vaultUnlock,
  IPC.vaultLock,
  IPC.vaultAdd,
  IPC.vaultUpdate,
  IPC.vaultRemove,

  // Proxy mutations
  IPC.proxySetConfig,
  IPC.proxyClear,

  // Sync mutations
  IPC.syncRemoveDevice,

  // Safety mutations
  IPC.safetyProceed,
  IPC.safetyRemoveException,

  // Downloads mutations
  IPC.downloadsRemove,
  IPC.downloadsClear,

  // Permissions mutations
  IPC.permissionsClear,

  // Updates mutations
  IPC.updateCheckNow,

  // Data mutations
  IPC.dataExport,
  IPC.dataImport,

  // Find mutations
  IPC.findStart,
  IPC.findNext,
  IPC.findPrev,
  IPC.findClose,

  // Zoom mutations
  IPC.zoomSet,
  IPC.zoomReset,
]);

// Different deduplication windows for different operation types (only for queries)
const DEDUP_WINDOWS: Record<string, number> = {
  // Navigation queries - shorter window as they're more time-sensitive
  [IPC.navGetState]: 100,

  // Tab queries
  [IPC.tabsList]: 150,

  // Favorites queries
  [IPC.favoritesList]: 300,

  // History queries
  [IPC.historyList]: 300,
  [IPC.historySearch]: 500, // Search might benefit from slightly longer dedup

  // Saved items queries
  [IPC.savedList]: 300,
  [IPC.savedHas]: 200,

  // Settings queries
  [IPC.settingsGet]: 300,

  // Adblock queries
  [IPC.adblockGetState]: 300,

  // Vault queries
  [IPC.vaultGetState]: 300,
  [IPC.vaultList]: 400,
  [IPC.vaultSearch]: 500, // Search might benefit from slightly longer dedup

  // Subscriptions queries
  [IPC.subsList]: 300,

  // Custom filters queries
  [IPC.customFiltersGet]: 300,

  // Allowlist queries
  // Note: adblockGetAllowlist does not exist; using adblockGetState for allowlist queries is not correct.
  // However, there is no IPC channel for getting the allowlist. The allowlist is modified via toggle/remove/clear.
  // We might need to add a channel in the future, but for now we skip deduplication for allowlist queries by not having an entry.
  // We'll leave it out and rely on the default window.

  // Proxy queries
  [IPC.proxyGetState]: 300,

  // Sync queries
  [IPC.syncGetState]: 300,

  // Safety queries
  [IPC.safetyGetState]: 300,

  // Downloads queries
  [IPC.downloadsList]: 300,

  // Permissions queries
  [IPC.permissionsList]: 300,

  // Updates queries
  [IPC.updateGetState]: 300,

  // Default window for unspecified query operations
  default: 300,
};

// Telemetry tracking for dedup effectiveness
const dedupStats = {
  hits: 0,
  misses: 0,
  hitsByChannel: new Map<string, number>(),
  missesByChannel: new Map<string, number>(),
};

const dedupeCache = new Map<string, DedupEntry<any>>();

function getDedupWindow(channel: string): number {
  return DEDUP_WINDOWS[channel] ?? DEDUP_WINDOWS.default;
}

// Simple hash function for payloads to avoid expensive JSON.stringify
function hashPayload(payload: any): string {
  // For simple primitives, use them directly
  if (payload === null || typeof payload !== 'object') {
    return String(payload);
  }

  // For objects, create a stable string representation
  try {
    return JSON.stringify(payload);
  } catch (e) {
    // Fallback for circular or complex objects
    return `[Object: ${Object.prototype.toString.call(payload)}]`;
  }
}

function dedupedCall<T>(channel: IPCChannel, payload: any): Promise<T> {
  // Skip deduplication for mutations that must always execute
  if (NON_DEDUP_CHANNELS.has(channel)) {
    return call<T>(String(channel), payload);
  }

  // Create a cache key from the channel and payload hash
  const payloadHash = hashPayload(payload);
  const key = `${channel}:${payloadHash}`;
  const now = Date.now();
  const window = getDedupWindow(channel);

  // Check if we have a recent call for this key
  const cached = dedupeCache.get(key);
  if (cached && now - cached.timestamp < window) {
    // Record hit and return the cached promise
    dedupStats.hits++;
    dedupStats.hitsByChannel.set(channel, (dedupStats.hitsByChannel.get(channel) || 0) + 1);
    return cached.promise as Promise<T>;
  }

  // Record miss
  dedupStats.misses++;
  dedupStats.missesByChannel.set(channel, (dedupStats.missesByChannel.get(channel) || 0) + 1);

  // Make the actual call and cache the promise
  const promise = call<T>(channel, payload);
  dedupeCache.set(key, { timestamp: now, promise });

  // Periodic cleanup - every 10 seconds to reduce overhead
  if (Date.now() % 10000 < 100) {
    // Roughly once per 10 seconds
    cleanupCache(now);
  }

  return promise;
}

function cleanupCache(now: number = Date.now()): void {
  for (const [key, entry] of dedupeCache.entries()) {
    // Extract channel from key to get appropriate window
    const channelPart = key.split(':')[0];

    // Check if this channel is in our non-deduplicated set
    if (NON_DEDUP_CHANNELS.has(channelPart as IPCChannel)) {
      dedupeCache.delete(key);
      continue;
    }

    // Convert to string for the getDedupWindow function
    const channelStr: string = channelPart;
    const window = getDedupWindow(channelStr);
    const cutoff = now - window * 2; // Keep entries for 2x window

    if (entry.timestamp < cutoff) {
      dedupeCache.delete(key);
    }
  }
}

// Expose stats for debugging (only in development)
if (import.meta.env.DEV) {
  (window as any).__ipcDedupStats = () => {
    const hitRate =
      dedupStats.hits + dedupStats.misses > 0
        ? (dedupStats.hits / (dedupStats.hits + dedupStats.misses)) * 100
        : 0;

    return {
      hitRate: Number(hitRate.toFixed(2)),
      total: dedupStats.hits + dedupStats.misses,
      hits: dedupStats.hits,
      misses: dedupStats.misses,
      byChannel: Array.from(dedupStats.hitsByChannel.entries()).reduce(
        (acc, [channel, count]) => {
          acc[channel] = {
            hits: count,
            misses: dedupStats.missesByChannel.get(channel) || 0,
            hitRate:
              count + (dedupStats.missesByChannel.get(channel) || 0) > 0
                ? (count / (count + (dedupStats.missesByChannel.get(channel) || 0))) * 100
                : 0,
          };
          return acc;
        },
        {} as Record<string, { hits: number; misses: number; hitRate: number }>,
      ),
    };
  };
}

/** The Kotlin content-webview bridge, injected on Android only (window.AegisAndroid).
 * On mobile there's no separate content webview on the Rust side, so nav goes here. */
interface AndroidBridge {
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  setContentHidden(hidden: boolean): void;
  openExternal(url: string): void;
  /** Tell the native Android Back handler a chrome sheet is open (so Back closes it
   * instead of navigating the page). */
  setBackInterceptActive(active: boolean): void;
  /** Hide/show the bottom action bar (the manual top-bar toggle); the content webview
   * reclaims the bar's gap when hidden. */
  setBottomBarHidden(hidden: boolean): void;
  /** Enter/exit chrome-hiding fullscreen (desktop parity): the content fills the safe
   * area with no top/bottom chrome. Back exits. */
  setFullscreen(on: boolean): void;
  /** Show tab `id` (lazily creating its native WebView at `url` if absent) and hide the
   * rest — switching, or reopening a discarded tab. `isPrivate` sets an ephemeral
   * data partition on the native WebView (Task 7). */
  activateTab(id: number, url: string, isPrivate?: boolean): void;
  /** Destroy + forget tab `id`'s native WebView. */
  closeTab(id: number): void;
  /** Destroy tab `id`'s native WebView but keep the tab (idle-sweep); recreated on next
   * activateTab. */
  discardTab(id: number): void;
  /** Begin/refine a find-in-page search on the active content WebView (Task 10 implements). */
  find(query: string, caseSensitive: boolean): void;
  /** Advance to the next find match. */
  findNext(): void;
  /** Go back to the previous find match. */
  findPrev(): void;
  /** End the find session and clear highlights. */
  findClose(): void;
  /** Set page zoom for tab `id` (percentage int, 100 == 1.0). No-op off Android. */
  setZoom(id: number, percent: number): void;
  /**
   * Apply an HTTP or SOCKS5 proxy process-globally (all WebViews in this process,
   * including the chrome).  Called by `proxy.setConfig` when `config.mode === 'proxy'`.
   * The chrome's own localhost/tauri.localhost origin is bypassed on the native side.
   * PARITY DIFFERENCE vs desktop (content-only) — documented in the proxy task report.
   */
  setProxy?(scheme: string, host: string, port: number, bypass: string): void;
  /**
   * Clear the process-global proxy override (return to direct connections).
   * Called by `proxy.setConfig` when `config.mode !== 'proxy'` and by `proxy.clear`.
   */
  clearProxy?(): void;
}
function androidBridge(): AndroidBridge | undefined {
  return (window as unknown as { AegisAndroid?: AndroidBridge }).AegisAndroid;
}

// On Android the chrome is a single phone-sized webview, so tag the document for
// the mobile toolbar CSS (.aegis-mobile in index.css). The UA is the reliable
// signal at module load — the AegisAndroid bridge is injected slightly later.
if (typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)) {
  document.documentElement.classList.add('aegis-mobile');
}

// Module-local cache for Android zoom factors (no return channel from the native bridge).
const androidZoom = new Map<number, number>();

export const aegis: AegisApi = {
  nav: {
    navigate: (viewId, url) => {
      const a = androidBridge();
      if (a) {
        a.navigate(url);
        return Promise.resolve();
      }
      return dedupedCall(IPC.navNavigate, { viewId, url });
    },
    back: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.back();
        return Promise.resolve();
      }
      return dedupedCall(IPC.navBack, { viewId });
    },
    forward: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.forward();
        return Promise.resolve();
      }
      return dedupedCall(IPC.navForward, { viewId });
    },
    reloadOrStop: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.reload();
        return Promise.resolve();
      }
      return dedupedCall(IPC.navReloadOrStop, { viewId });
    },
    home: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.navigate('about:blank');
        return Promise.resolve();
      }
      return dedupedCall(IPC.navHome, { viewId });
    },
    getState: (viewId) => dedupedCall<NavState>(IPC.navGetState, { viewId }),
    onState: (cb) => {
      // Android has no Tauri event bus on the content side; its WebViewClient pushes
      // NavState by calling window.__aegisNavState (set up here). Support multiple
      // subscribers so each unsubscribes cleanly.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisNavStateCbs?: Set<(s: NavState) => void>;
          __aegisNavState?: (s: NavState) => void;
        };
        const cbs = (w.__aegisNavStateCbs ??= new Set());
        cbs.add(cb);
        w.__aegisNavState = (s) => cbs.forEach((f) => f(s));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<NavState>(IPC.evtNavState, cb);
    },
    onFailed: (cb) => on<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb) => on<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  tabs: {
    list: () => dedupedCall<TabsState>(IPC.tabsList, undefined),
    create: (url, background, isPrivate) =>
      dedupedCall<TabsState>(IPC.tabsCreate, { url, background, private: isPrivate }),
    close: (id) => dedupedCall<TabsState>(IPC.tabsClose, { id }),
    activate: (id) => dedupedCall<TabsState>(IPC.tabsActivate, { id }),
    reorder: (ids) => dedupedCall<TabsState>(IPC.tabsReorder, { ids }),
    setPinned: (id, pinned) => dedupedCall<TabsState>(IPC.tabsSetPinned, { id, pinned }),
    reopenClosed: () => dedupedCall<TabsState>(IPC.tabsReopenClosed, undefined),
    setTitle: (id, title) => dedupedCall<TabsState>(IPC.tabsSetTitle, { id, title }),
    recordNav: (id, url, title) => dedupedCall<TabsState>(IPC.tabsRecordNav, { id, url, title }),
    onState: (cb) => on<TabsState>(IPC.evtTabsState, cb),
    onShortcut: (cb) => on<TabShortcut>(IPC.evtTabsShortcut, cb),
  },
  view: {
    setContentVisible: (viewId, visible) =>
      dedupedCall(IPC.viewSetContentVisible, { viewId, visible }),
    setContentInset: (viewId, inset) => dedupedCall(IPC.viewSetContentInset, { viewId, inset }),
    setChromeOverlay: (viewId, active) => {
      // On Android the content view is a native WebView (Rust view.rs can't reach it),
      // so hide/show it via the bridge when a chrome overlay opens/closes.
      const a = androidBridge();
      if (a) {
        a.setContentHidden(active);
        return Promise.resolve();
      }
      return dedupedCall(IPC.viewSetChromeOverlay, { viewId, active });
    },
    setSidebar: (viewId, active, width) =>
      dedupedCall(IPC.viewSetSidebar, { viewId, active, width }),
    setLayout: (viewId, opts) => dedupedCall(IPC.viewSetLayout, { viewId, ...opts }),
    setFullscreen: (viewId, on) => dedupedCall(IPC.viewSetFullscreen, { viewId, on }),
    onFullscreen: (cb) => on<{ on: boolean }>(IPC.evtViewFullscreen, cb),
  },
  favorites: {
    list: () => dedupedCall<Favorite[]>(IPC.favoritesList, undefined),
    add: (input) => dedupedCall<Favorite[]>(IPC.favoritesAdd, { input }),
    update: (id, partial) => dedupedCall<Favorite[]>(IPC.favoritesUpdate, { id, partial }),
    remove: (id) => dedupedCall<Favorite[]>(IPC.favoritesRemove, { id }),
    reorder: (ids) => dedupedCall<Favorite[]>(IPC.favoritesReorder, { ids }),
  },
  history: {
    list: (opts) => dedupedCall<HistoryEntry[]>(IPC.historyList, { opts }),
    search: (q) => dedupedCall<HistoryEntry[]>(IPC.historySearch, { q }),
    remove: (id) => dedupedCall(IPC.historyRemove, { id }),
    clear: () => dedupedCall(IPC.historyClear, undefined),
    onChanged: (cb) => on<void>(IPC.evtHistoryChanged, cb),
  },
  saved: {
    list: () => dedupedCall<SavedItem[]>(IPC.savedList, undefined),
    add: (input) => dedupedCall<SavedItem[]>(IPC.savedAdd, { input }),
    remove: (id) => dedupedCall<SavedItem[]>(IPC.savedRemove, { id }),
    has: (url) => dedupedCall<boolean>(IPC.savedHas, { url }),
    update: (id, partial) => dedupedCall<SavedItem[]>(IPC.savedUpdate, { id, partial }),
    renameTag: (oldT, newT) => dedupedCall<SavedItem[]>(IPC.savedRenameTag, { oldT, newT }),
    deleteTag: (tag) => dedupedCall<SavedItem[]>(IPC.savedDeleteTag, { tag }),
    tagUnion: () => dedupedCall<string[]>(IPC.savedTagUnion, undefined),
  },
  settings: {
    get: () => dedupedCall<Settings>(IPC.settingsGet, undefined),
    set: (partial) => dedupedCall<Settings>(IPC.settingsSet, { partial }),
  },
  adblock: {
    setEnabled: (enabled) => dedupedCall<AdblockState>(IPC.adblockSetEnabled, { enabled }),
    toggleAllowlist: (host) => dedupedCall<AdblockState>(IPC.adblockToggleAllowlist, { host }),
    removeAllowlist: (host) => dedupedCall<AdblockState>(IPC.adblockRemoveAllowlist, { host }),
    clearAllowlist: () => dedupedCall<AdblockState>(IPC.adblockClearAllowlist, undefined),
    getState: () => dedupedCall<AdblockState>(IPC.adblockGetState, undefined),
    onBlockedCount: (cb) => {
      // Android has no Tauri event bus on the content side; MainActivity pushes
      // BlockedCount via window.__aegisBlockedCount (set up here), mirroring nav state /
      // redirect.onBlocked. The desktop path uses the Tauri event.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisBlockedCountCbs?: Set<(c: BlockedCount) => void>;
          __aegisBlockedCount?: (c: BlockedCount) => void;
        };
        const cbs = (w.__aegisBlockedCountCbs ??= new Set());
        cbs.add(cb);
        w.__aegisBlockedCount = (c) => cbs.forEach((f) => f(c));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<BlockedCount>(IPC.evtAdblockBlockedCount, cb);
    },
  },
  redirect: {
    onBlocked: (cb: (r: RedirectBlocked) => void) => {
      // Android has no Tauri event bus on the content side; the Kotlin client pushes
      // RedirectBlocked via window.__aegisRedirectBlocked (set up here), mirroring nav state.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisRedirectBlockedCbs?: Set<(r: RedirectBlocked) => void>;
          __aegisRedirectBlocked?: (r: RedirectBlocked) => void;
        };
        const cbs = (w.__aegisRedirectBlockedCbs ??= new Set());
        cbs.add(cb);
        w.__aegisRedirectBlocked = (r) => cbs.forEach((f) => f(r));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<RedirectBlocked>(IPC.evtRedirectBlocked, cb);
    },
  },
  lists: {
    updateNow: () => dedupedCall<void>(IPC.listsUpdateNow, undefined),
    onUpdateResult: (cb) => on<ListUpdateResult>(IPC.evtListsUpdateResult, cb),
  },
  subs: {
    list: () => dedupedCall<Subscription[]>(IPC.subsList, undefined),
    setEnabled: (listId, enabled) =>
      dedupedCall<Subscription[]>(IPC.subsSetEnabled, { listId, enabled }),
    add: (url) => dedupedCall<Subscription[]>(IPC.subsAdd, { url }),
    remove: (listId) => dedupedCall<Subscription[]>(IPC.subsRemove, { listId }),
  },
  customFilters: {
    get: () => dedupedCall<string>(IPC.customFiltersGet, undefined),
    set: (text) => dedupedCall<string>(IPC.customFiltersSet, { text }),
  },
  downloads: {
    list: () => dedupedCall<DownloadEntry[]>(IPC.downloadsList, undefined),
    remove: (id) => dedupedCall<DownloadEntry[]>(IPC.downloadsRemove, { id }),
    clear: () => dedupedCall<DownloadEntry[]>(IPC.downloadsClear, undefined),
    openFile: (id) => dedupedCall(IPC.downloadsOpenFile, { id }),
    showInFolder: (id) => dedupedCall(IPC.downloadsShowInFolder, { id }),
    cancel: (id) => dedupedCall(IPC.downloadsCancel, { id }),
    onChanged: (cb) => on<void>(IPC.evtDownloadsChanged, cb),
  },
  permissions: {
    list: () => dedupedCall<SitePermission[]>(IPC.permissionsList, undefined),
    remove: (origin, permission) =>
      dedupedCall<SitePermission[]>(IPC.permissionsRemove, { origin, permission }),
    clear: () => dedupedCall<SitePermission[]>(IPC.permissionsClear, undefined),
    resolve: (requestId, decision) => dedupedCall(IPC.permissionsResolve, { requestId, decision }),
    onPrompt: (cb) => on<PermissionPrompt>(IPC.evtPermissionsPrompt, cb),
  },
  data: {
    // No native save dialog (it renders in the OS's light theme, clashing with
    // Aegis's dark UI). The backend writes the backup to the Downloads dir and
    // returns the path, which the Data tab shows in a toast.
    export: async () => dedupedCall<{ ok: boolean; path?: string }>(IPC.dataExport, {}),
    // No native open dialog. Import from JSON pasted into the in-app field when
    // given; otherwise restore the last export from the Downloads dir.
    import: async (mode, source) => {
      const text = source?.text?.trim() ?? '';
      const result = text
        ? await dedupedCall<{ ok: boolean; counts?: unknown }>(IPC.dataImport, { mode, text })
        : await dedupedCall<{ ok: boolean; counts?: unknown }>(IPC.dataImport, { mode });
      // Make the import live immediately — favorites/saved/settings hooks only fetch
      // on mount, so reload the chrome to re-read everything (no app restart). Delay
      // briefly so the success toast is visible first.
      if (result && result.ok) {
        setTimeout(() => window.location.reload(), 700);
      }
      return result;
    },
  },
  picker: {
    start: () => dedupedCall<{ ok: boolean; rule?: string }>(IPC.pickerStart, undefined),
  },
  update: {
    getState: () => dedupedCall<UpdateState>(IPC.updateGetState, undefined),
    checkNow: () => dedupedCall(IPC.updateCheckNow, undefined),
    // Android can't self-install via the Tauri updater; open the releases page so the
    // user can download the new APK. Desktop restarts into the installed update.
    restartToInstall: () => {
      const a = androidBridge();
      if (a) {
        a.openExternal('https://github.com/HappyHobo085/Aegis/releases/latest');
        return Promise.resolve();
      }
      return dedupedCall(IPC.updateRestartToInstall, undefined);
    },
    onState: (cb) => on<UpdateState>(IPC.evtUpdateState, cb),
  },
  safety: {
    getState: () => dedupedCall<SafetyInterstitialPayload | null>(IPC.safetyGetState, undefined),
    proceed: (url) => dedupedCall(IPC.safetyProceed, { url }),
    listExceptions: () => dedupedCall<string[]>(IPC.safetyListExceptions, undefined),
    removeException: (host) => dedupedCall(IPC.safetyRemoveException, { host }),
    onInterstitial: (cb) => on<SafetyInterstitialPayload | null>(IPC.evtSafetyInterstitial, cb),
  },
  sync: {
    getState: () => dedupedCall<SyncState>(IPC.syncGetState, undefined),
    enableNew: (opts) =>
      dedupedCall<{ recoveryPhrase: string }>(IPC.syncEnableNew, { ...(opts ?? {}) }),
    enableFromPhrase: (opts) => dedupedCall<SyncState>(IPC.syncEnableFromPhrase, { ...opts }),
    unlock: (opts) => dedupedCall<SyncState>(IPC.syncUnlock, { ...opts }),
    disable: (opts) => dedupedCall<SyncState>(IPC.syncDisable, { ...(opts ?? {}) }),
    syncNow: () => dedupedCall<SyncState>(IPC.syncNow, undefined),
    scanNow: () => dedupedCall<SyncState>(IPC.scanNow, undefined),
    testConnection: (url: string) =>
      dedupedCall<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.syncTestConnection, {
        url,
      }),
    getRecoveryPhrase: (opts) =>
      dedupedCall<{ recoveryPhrase: string }>(IPC.syncGetRecoveryPhrase, { ...opts }),
    listDevices: () => dedupedCall<SyncDevice[]>(IPC.syncListDevices, undefined),
    removeDevice: (deviceId) => dedupedCall<SyncDevice[]>(IPC.syncRemoveDevice, { deviceId }),
    onState: (cb) => on<SyncState>(IPC.evtSyncState, cb),
    onChanged: (cb) => on<SyncChanged>(IPC.evtSyncChanged, cb),
  },
  find: {
    start: (viewId, query, caseSensitive = false) => {
      const a = androidBridge();
      if (a) {
        a.find(query, caseSensitive);
        return Promise.resolve();
      }
      return dedupedCall(IPC.findStart, { viewId, query, caseSensitive });
    },
    next: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findNext();
        return Promise.resolve();
      }
      return dedupedCall(IPC.findNext, { viewId });
    },
    prev: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findPrev();
        return Promise.resolve();
      }
      return dedupedCall(IPC.findPrev, { viewId });
    },
    close: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findClose();
        return Promise.resolve();
      }
      return dedupedCall(IPC.findClose, { viewId });
    },
    onState: (cb) => {
      // Android has no Tauri event bus on the content side; the Kotlin client pushes
      // FindState via window.__aegisFindState (set up here), mirroring nav.onState's
      // __aegisNavState multi-subscriber pattern exactly. Task 10 implements the Kotlin side.
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisFindStateCbs?: Set<(s: FindState) => void>;
          __aegisFindState?: (s: FindState) => void;
        };
        const cbs = (w.__aegisFindStateCbs ??= new Set());
        cbs.add(cb);
        w.__aegisFindState = (s) => cbs.forEach((f) => f(s));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<FindState>(IPC.evtFindState, cb);
    },
  },
  zoom: {
    get: (viewId) => {
      const a = androidBridge();
      if (a) return Promise.resolve({ viewId, factor: androidZoom.get(viewId) ?? 1.0 });
      return dedupedCall<ZoomState>(IPC.zoomGet, { viewId });
    },
    set: (viewId, factor) => {
      const a = androidBridge();
      if (a) {
        const f = clampZoom(factor);
        androidZoom.set(viewId, f);
        a.setZoom(viewId, Math.round(f * 100));
        // No native event bus on Android content side; push to onChanged subscribers,
        // mirroring nav.onState's __aegisNavState multi-subscriber pattern.
        (window as unknown as { __aegisZoomChanged?: (s: ZoomState) => void }).__aegisZoomChanged?.(
          {
            viewId,
            factor: f,
          },
        );
        return Promise.resolve({ viewId, factor: f });
      }
      return dedupedCall<ZoomState>(IPC.zoomSet, { viewId, factor });
    },
    reset: (viewId) => aegis.zoom.set(viewId, 1.0),
    onChanged: (cb) => {
      if (androidBridge()) {
        const w = window as unknown as {
          __aegisZoomChangedCbs?: Set<(s: ZoomState) => void>;
          __aegisZoomChanged?: (s: ZoomState) => void;
        };
        const cbs = (w.__aegisZoomChangedCbs ??= new Set());
        cbs.add(cb);
        w.__aegisZoomChanged = (s) => cbs.forEach((f) => f(s));
        return () => {
          cbs.delete(cb);
        };
      }
      return on<ZoomState>(IPC.evtZoomChanged, cb);
    },
  },
  fingerprint: {
    getState: () => dedupedCall<FingerprintState>(IPC.fingerprintGetState, undefined),
    toggleAllowlist: (host) =>
      dedupedCall<FingerprintState>(IPC.fingerprintToggleAllowlist, { host }),
    removeAllowlist: (host) =>
      dedupedCall<FingerprintState>(IPC.fingerprintRemoveAllowlist, { host }),
    clearAllowlist: () => dedupedCall<FingerprintState>(IPC.fingerprintClearAllowlist, undefined),
  },
  proxy: {
    getState: () => dedupedCall<ProxyState>(IPC.proxyGetState, undefined),
    setConfig: (config: ProxyConfig) => {
      // On Android: drive the process-global ProxyController via the bridge in addition
      // to the normal IPC call (which persists + emits proxy.state).
      // ProxyController.setProxyOverride is PROCESS-GLOBAL (chrome webview too) —
      // documented parity difference vs desktop (content-only).  The native bridge
      // bypasses the chrome's own localhost/tauri.localhost origin so the React UI
      // is not proxied.
      const a = androidBridge();
      if (a) {
        if (config.mode === 'proxy') {
          a.setProxy?.(
            config.scheme,
            config.host,
            config.port,
            (config.bypassHosts ?? []).join(','),
          );
        } else {
          a.clearProxy?.();
        }
      }
      return dedupedCall<ProxyState>(IPC.proxySetConfig, { config });
    },
    clear: () => {
      androidBridge()?.clearProxy?.();
      return dedupedCall<ProxyState>(IPC.proxyClear, undefined);
    },
    testConnection: (config: ProxyConfig) =>
      dedupedCall<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.proxyTestConnection, {
        config,
      }),
    onState: (cb: (s: ProxyState) => void) => on<ProxyState>(IPC.evtProxyState, cb),
  },
  vault: {
    getState: () => dedupedCall<VaultState>(IPC.vaultGetState, undefined),
    create: (masterPassword: string) =>
      dedupedCall<VaultState>(IPC.vaultCreate, { masterPassword }),
    unlock: (masterPassword: string) =>
      dedupedCall<VaultState>(IPC.vaultUnlock, { masterPassword }),
    lock: () => dedupedCall<VaultState>(IPC.vaultLock, undefined),
    list: () => dedupedCall<VaultRecord[]>(IPC.vaultList, undefined),
    add: (input: VaultRecordInput) => dedupedCall<VaultRecord[]>(IPC.vaultAdd, { input }),
    update: (uuid: string, partial: Partial<VaultRecordInput>) =>
      dedupedCall<VaultRecord[]>(IPC.vaultUpdate, { uuid, partial }),
    remove: (uuid: string) => dedupedCall<VaultRecord[]>(IPC.vaultRemove, { uuid }),
    search: (q: string) => dedupedCall<VaultRecord[]>(IPC.vaultSearch, { q }),
    autofill: (options: { domain: string; username?: string }) =>
      dedupedCall<VaultRecord[]>(IPC.vaultAutofill, { ...options }),
    autofillSuggestions: (options: { q: string }) =>
      dedupedCall<VaultRecord[]>(IPC.vaultAutofillSuggestions, options),
    onState: (cb: (s: VaultState) => void) => on<VaultState>(IPC.evtVaultState, cb),
  },
  /** Form detection for autofill triggering */
  form: {
    /** Trigger a login form scan in the current content webview */
    detectLoginForm(): Promise<FormLoginDetectedResult> {
      return dedupedCall<FormLoginDetectedResult>(IPC.formDetectLoginForm, {});
    },
    /** Subscribe to login form detection events */
    onLoginFormDetected(cb: (result: FormLoginDetectedResult) => void) {
      return on<FormLoginDetectedResult>(IPC.evtFormDetectResult, cb);
    },
  },
};

/** Mobile-only: report whether a chrome sheet/menu is open so the native Android
 * Back button closes it first. No-op off Android. */
export function setBackInterceptActive(active: boolean): void {
  androidBridge()?.setBackInterceptActive(active);
}

/** Mobile-only: hide/show the bottom action bar (the top-bar toggle). No-op off Android. */
export function setBottomBarHidden(hidden: boolean): void {
  androidBridge()?.setBottomBarHidden(hidden);
}

/** Mobile-only: enter/exit chrome-hiding fullscreen (desktop parity). No-op off Android. */
export function setFullscreen(on: boolean): void {
  androidBridge()?.setFullscreen(on);
}

/** Mobile-only: show/lazily-create the active tab's native WebView. No-op off Android.
 * Pass `isPrivate=true` for private (incognito) tabs so the native side uses an ephemeral
 * data partition (Task 7). */
export function activateTab(id: number, url: string, isPrivate?: boolean): void {
  androidBridge()?.activateTab(id, url, isPrivate);
}
/** Mobile-only: destroy + forget a tab's native WebView. No-op off Android. */
export function closeTab(id: number): void {
  androidBridge()?.closeTab(id);
}
/** Mobile-only: discard a tab's native WebView (idle-sweep), keeping the tab. No-op off Android. */
export function discardTab(id: number): void {
  androidBridge()?.discardTab(id);
}
