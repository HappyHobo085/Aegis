// src/lib/ipcClient.tauri.ts
//
// The Tauri implementation of the renderer's backend seam. Structurally identical
// to the `window.aegis` object the Electron preload exposes (typed by AegisApi),
// but every method is a Tauri `invoke('ipc', {channel,…})` and every `onX` is a
// Tauri event subscription. Selected for the Tauri build by the alias in
// vite.config.ts; the Electron build never imports this file.
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
  UpdateState,
  SafetyInterstitialPayload,
} from '../../shared/types';
import { IPC } from '../../shared/types';
import { call, on } from './tauriInvoke';

export const aegis: AegisApi = {
  nav: {
    navigate: (viewId, url) => call(IPC.navNavigate, { viewId, url }),
    back: (viewId) => call(IPC.navBack, { viewId }),
    forward: (viewId) => call(IPC.navForward, { viewId }),
    reloadOrStop: (viewId) => call(IPC.navReloadOrStop, { viewId }),
    home: (viewId) => call(IPC.navHome, { viewId }),
    getState: (viewId) => call<NavState>(IPC.navGetState, { viewId }),
    onState: (cb) => on<NavState>(IPC.evtNavState, cb),
    onFailed: (cb) => on<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb) => on<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId, visible) => call(IPC.viewSetContentVisible, { viewId, visible }),
    setContentInset: (viewId, inset) => call(IPC.viewSetContentInset, { viewId, inset }),
    setChromeOverlay: (viewId, active) => call(IPC.viewSetChromeOverlay, { viewId, active }),
    setFullscreen: (viewId, on) => call(IPC.viewSetFullscreen, { viewId, on }),
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
    export: () => call<{ ok: boolean; path?: string }>(IPC.dataExport),
    import: (mode) => call<{ ok: boolean; counts?: unknown }>(IPC.dataImport, { mode }),
  },
  picker: {
    start: () => call<{ ok: boolean; rule?: string }>(IPC.pickerStart),
  },
  update: {
    getState: () => call<UpdateState>(IPC.updateGetState),
    checkNow: () => call(IPC.updateCheckNow),
    restartToInstall: () => call(IPC.updateRestartToInstall),
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
