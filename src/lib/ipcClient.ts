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
  ListUpdateResult,
  Subscription,
  DownloadEntry,
  SitePermission,
  PermissionPrompt,
  TabsState,
  UpdateState,
  SafetyInterstitialPayload,
} from '../../shared/types';
import { IPC } from '../../shared/types';
import { call, on } from './tauriInvoke';

/** The Kotlin content-webview bridge, injected on Android only (window.AegisAndroid).
 * On mobile there's no separate content webview on the Rust side, so nav goes here. */
interface AndroidBridge {
  navigate(url: string): void;
  back(): void;
  forward(): void;
  reload(): void;
  setContentHidden(hidden: boolean): void;
  openExternal(url: string): void;
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
    create: (url) => call<TabsState>(IPC.tabsCreate, { url }),
    close: (id) => call<TabsState>(IPC.tabsClose, { id }),
    activate: (id) => call<TabsState>(IPC.tabsActivate, { id }),
    reorder: (ids) => call<TabsState>(IPC.tabsReorder, { ids }),
    setPinned: (id, pinned) => call<TabsState>(IPC.tabsSetPinned, { id, pinned }),
    reopenClosed: () => call<TabsState>(IPC.tabsReopenClosed),
    onState: (cb) => on<TabsState>(IPC.evtTabsState, cb),
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
    onBlockedCount: (cb) => on<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
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
    remove: (origin, permission) => call<SitePermission[]>(IPC.permissionsRemove, { origin, permission }),
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
};
