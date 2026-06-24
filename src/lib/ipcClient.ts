// src/lib/ipcClient.ts
//
// The renderer's backend seam — the single module the whole React UI uses to
// reach the backend. Every method is a Tauri `invoke('ipc', {channel,…})` and
// every `onX` is a Tauri event subscription (typed by AegisApi).
import type {
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
} from '../../shared/types';
import { IPC } from '../../shared/types';
import { call, on } from './tauriInvoke';
import { clampZoom } from './zoom';

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
      return call(IPC.navNavigate, { viewId, url });
    },
    back: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.back();
        return Promise.resolve();
      }
      return call(IPC.navBack, { viewId });
    },
    forward: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.forward();
        return Promise.resolve();
      }
      return call(IPC.navForward, { viewId });
    },
    reloadOrStop: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.reload();
        return Promise.resolve();
      }
      return call(IPC.navReloadOrStop, { viewId });
    },
    home: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.navigate('about:blank');
        return Promise.resolve();
      }
      return call(IPC.navHome, { viewId });
    },
    getState: (viewId) => call<NavState>(IPC.navGetState, { viewId }),
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
    list: () => call<TabsState>(IPC.tabsList),
    create: (url, background, isPrivate) =>
      call<TabsState>(IPC.tabsCreate, { url, background, private: isPrivate }),
    close: (id) => call<TabsState>(IPC.tabsClose, { id }),
    activate: (id) => call<TabsState>(IPC.tabsActivate, { id }),
    reorder: (ids) => call<TabsState>(IPC.tabsReorder, { ids }),
    setPinned: (id, pinned) => call<TabsState>(IPC.tabsSetPinned, { id, pinned }),
    reopenClosed: () => call<TabsState>(IPC.tabsReopenClosed),
    setTitle: (id, title) => call<TabsState>(IPC.tabsSetTitle, { id, title }),
    onState: (cb) => on<TabsState>(IPC.evtTabsState, cb),
    onShortcut: (cb) => on<TabShortcut>(IPC.evtTabsShortcut, cb),
  },
  view: {
    setContentVisible: (viewId, visible) => call(IPC.viewSetContentVisible, { viewId, visible }),
    setContentInset: (viewId, inset) => call(IPC.viewSetContentInset, { viewId, inset }),
    setChromeOverlay: (viewId, active) => {
      // On Android the content view is a native WebView (Rust view.rs can't reach it),
      // so hide/show it via the bridge when a chrome overlay opens/closes.
      const a = androidBridge();
      if (a) {
        a.setContentHidden(active);
        return Promise.resolve();
      }
      return call(IPC.viewSetChromeOverlay, { viewId, active });
    },
    setSidebar: (viewId, active, width) => call(IPC.viewSetSidebar, { viewId, active, width }),
    setLayout: (viewId, opts) => call(IPC.viewSetLayout, { viewId, ...opts }),
    setFullscreen: (viewId, on) => call(IPC.viewSetFullscreen, { viewId, on }),
    onFullscreen: (cb) => on<{ on: boolean }>(IPC.evtViewFullscreen, cb),
  },
  favorites: {
    list: () => call<Favorite[]>(IPC.favoritesList),
    add: (input) => call<Favorite[]>(IPC.favoritesAdd, { input }),
    update: (id, partial) => call<Favorite[]>(IPC.favoritesUpdate, { id, partial }),
    remove: (id) => call<Favorite[]>(IPC.favoritesRemove, { id }),
    reorder: (ids) => call<Favorite[]>(IPC.favoritesReorder, { ids }),
  },
  history: {
    list: (opts) => call<HistoryEntry[]>(IPC.historyList, { opts }),
    search: (q) => call<HistoryEntry[]>(IPC.historySearch, { q }),
    remove: (id) => call(IPC.historyRemove, { id }),
    clear: () => call(IPC.historyClear),
    onChanged: (cb) => on<void>(IPC.evtHistoryChanged, cb),
  },
  saved: {
    list: () => call<SavedItem[]>(IPC.savedList),
    add: (input) => call<SavedItem[]>(IPC.savedAdd, { input }),
    remove: (id) => call<SavedItem[]>(IPC.savedRemove, { id }),
    has: (url) => call<boolean>(IPC.savedHas, { url }),
    update: (id, partial) => call<SavedItem[]>(IPC.savedUpdate, { id, partial }),
    renameTag: (oldT, newT) => call<SavedItem[]>(IPC.savedRenameTag, { oldT, newT }),
    deleteTag: (tag) => call<SavedItem[]>(IPC.savedDeleteTag, { tag }),
    tagUnion: () => call<string[]>(IPC.savedTagUnion),
  },
  settings: {
    get: () => call<Settings>(IPC.settingsGet),
    set: (partial) => call<Settings>(IPC.settingsSet, { partial }),
  },
  adblock: {
    setEnabled: (enabled) => call<AdblockState>(IPC.adblockSetEnabled, { enabled }),
    toggleAllowlist: (host) => call<AdblockState>(IPC.adblockToggleAllowlist, { host }),
    removeAllowlist: (host) => call<AdblockState>(IPC.adblockRemoveAllowlist, { host }),
    clearAllowlist: () => call<AdblockState>(IPC.adblockClearAllowlist),
    getState: () => call<AdblockState>(IPC.adblockGetState),
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
    updateNow: () => call<ListUpdateResult>(IPC.listsUpdateNow),
  },
  subs: {
    list: () => call<Subscription[]>(IPC.subsList),
    setEnabled: (listId, enabled) => call<Subscription[]>(IPC.subsSetEnabled, { listId, enabled }),
    add: (url) => call<Subscription[]>(IPC.subsAdd, { url }),
    remove: (listId) => call<Subscription[]>(IPC.subsRemove, { listId }),
  },
  customFilters: {
    get: () => call<string>(IPC.customFiltersGet),
    set: (text) => call<string>(IPC.customFiltersSet, { text }),
  },
  downloads: {
    list: () => call<DownloadEntry[]>(IPC.downloadsList),
    remove: (id) => call<DownloadEntry[]>(IPC.downloadsRemove, { id }),
    clear: () => call<DownloadEntry[]>(IPC.downloadsClear),
    openFile: (id) => call(IPC.downloadsOpenFile, { id }),
    showInFolder: (id) => call(IPC.downloadsShowInFolder, { id }),
    cancel: (id) => call(IPC.downloadsCancel, { id }),
    onChanged: (cb) => on<void>(IPC.evtDownloadsChanged, cb),
  },
  permissions: {
    list: () => call<SitePermission[]>(IPC.permissionsList),
    remove: (origin, permission) =>
      call<SitePermission[]>(IPC.permissionsRemove, { origin, permission }),
    clear: () => call<SitePermission[]>(IPC.permissionsClear),
    resolve: (requestId, decision) => call(IPC.permissionsResolve, { requestId, decision }),
    onPrompt: (cb) => on<PermissionPrompt>(IPC.evtPermissionsPrompt, cb),
  },
  data: {
    // No native save dialog (it renders in the OS's light theme, clashing with
    // Aegis's dark UI). The backend writes the backup to the Downloads dir and
    // returns the path, which the Data tab shows in a toast.
    export: async () => call<{ ok: boolean; path?: string }>(IPC.dataExport, {}),
    // No native open dialog. Import from JSON pasted into the in-app field when
    // given; otherwise restore the last export from the Downloads dir.
    import: async (mode, source) => {
      const text = source?.text?.trim() ?? '';
      const result = text
        ? await call<{ ok: boolean; counts?: unknown }>(IPC.dataImport, { mode, text })
        : await call<{ ok: boolean; counts?: unknown }>(IPC.dataImport, { mode });
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
    start: () => call<{ ok: boolean; rule?: string }>(IPC.pickerStart),
  },
  update: {
    getState: () => call<UpdateState>(IPC.updateGetState),
    checkNow: () => call(IPC.updateCheckNow),
    // Android can't self-install via the Tauri updater; open the releases page so the
    // user can download the new APK. Desktop restarts into the installed update.
    restartToInstall: () => {
      const a = androidBridge();
      if (a) {
        a.openExternal('https://github.com/HappyHobo085/Aegis/releases/latest');
        return Promise.resolve();
      }
      return call(IPC.updateRestartToInstall);
    },
    onState: (cb) => on<UpdateState>(IPC.evtUpdateState, cb),
  },
  safety: {
    getState: () => call<SafetyInterstitialPayload | null>(IPC.safetyGetState),
    proceed: (url) => call(IPC.safetyProceed, { url }),
    listExceptions: () => call<string[]>(IPC.safetyListExceptions),
    removeException: (host) => call(IPC.safetyRemoveException, { host }),
    onInterstitial: (cb) => on<SafetyInterstitialPayload | null>(IPC.evtSafetyInterstitial, cb),
  },
  sync: {
    getState: () => call<SyncState>(IPC.syncGetState),
    enableNew: (opts) => call<{ recoveryPhrase: string }>(IPC.syncEnableNew, { ...(opts ?? {}) }),
    enableFromPhrase: (opts) => call<SyncState>(IPC.syncEnableFromPhrase, { ...opts }),
    disable: (opts) => call<SyncState>(IPC.syncDisable, { ...(opts ?? {}) }),
    syncNow: () => call<SyncState>(IPC.syncNow),
    testConnection: (url: string) =>
      call<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.syncTestConnection, { url }),
    getRecoveryPhrase: (opts) =>
      call<{ recoveryPhrase: string }>(IPC.syncGetRecoveryPhrase, { ...opts }),
    listDevices: () => call<SyncDevice[]>(IPC.syncListDevices),
    removeDevice: (deviceId) => call<SyncDevice[]>(IPC.syncRemoveDevice, { deviceId }),
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
      return call(IPC.findStart, { viewId, query, caseSensitive });
    },
    next: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findNext();
        return Promise.resolve();
      }
      return call(IPC.findNext, { viewId });
    },
    prev: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findPrev();
        return Promise.resolve();
      }
      return call(IPC.findPrev, { viewId });
    },
    close: (viewId) => {
      const a = androidBridge();
      if (a) {
        a.findClose();
        return Promise.resolve();
      }
      return call(IPC.findClose, { viewId });
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
      return call<ZoomState>(IPC.zoomGet, { viewId });
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
      return call<ZoomState>(IPC.zoomSet, { viewId, factor });
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
    getState: () => call<FingerprintState>(IPC.fingerprintGetState),
    toggleAllowlist: (host) => call<FingerprintState>(IPC.fingerprintToggleAllowlist, { host }),
    removeAllowlist: (host) => call<FingerprintState>(IPC.fingerprintRemoveAllowlist, { host }),
    clearAllowlist: () => call<FingerprintState>(IPC.fingerprintClearAllowlist),
  },
  proxy: {
    getState: () => call<ProxyState>(IPC.proxyGetState),
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
      return call<ProxyState>(IPC.proxySetConfig, { config });
    },
    clear: () => {
      androidBridge()?.clearProxy?.();
      return call<ProxyState>(IPC.proxyClear);
    },
    testConnection: (config: ProxyConfig) =>
      call<{ ok: boolean; latencyMs?: number; error?: string }>(IPC.proxyTestConnection, {
        config,
      }),
    onState: (cb: (s: ProxyState) => void) => on<ProxyState>(IPC.evtProxyState, cb),
  },
  vault: {
    getState: () => call<VaultState>(IPC.vaultGetState),
    create: (masterPassword: string) => call<VaultState>(IPC.vaultCreate, { masterPassword }),
    unlock: (masterPassword: string) => call<VaultState>(IPC.vaultUnlock, { masterPassword }),
    lock: () => call<VaultState>(IPC.vaultLock),
    list: () => call<VaultRecord[]>(IPC.vaultList),
    add: (input: VaultRecordInput) => call<VaultRecord[]>(IPC.vaultAdd, { input }),
    update: (uuid: string, partial: Partial<VaultRecordInput>) =>
      call<VaultRecord[]>(IPC.vaultUpdate, { uuid, partial }),
    remove: (uuid: string) => call<VaultRecord[]>(IPC.vaultRemove, { uuid }),
    search: (q: string) => call<VaultRecord[]>(IPC.vaultSearch, { q }),
    onState: (cb: (s: VaultState) => void) => on<VaultState>(IPC.evtVaultState, cb),
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
