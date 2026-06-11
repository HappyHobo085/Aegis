// electron/preload/chromePreload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../../shared/types';
import type {
  AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings,
  AdblockState, BlockedCount, ListUpdateResult,
  Favorite, HistoryEntry, SavedItem, ContentInset, Subscription,
  DownloadEntry, SitePermission, PermissionPrompt, ImportMode,
} from '../../shared/types';

/** Subscribes cb to an event channel; returns an unsubscriber. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AegisApi = {
  nav: {
    navigate: (viewId: ViewId, url: string) => ipcRenderer.invoke(IPC.navNavigate, viewId, url),
    back: (viewId: ViewId) => ipcRenderer.invoke(IPC.navBack, viewId),
    forward: (viewId: ViewId) => ipcRenderer.invoke(IPC.navForward, viewId),
    reloadOrStop: (viewId: ViewId) => ipcRenderer.invoke(IPC.navReloadOrStop, viewId),
    home: (viewId: ViewId) => ipcRenderer.invoke(IPC.navHome, viewId),
    getState: (viewId: ViewId): Promise<NavState> => ipcRenderer.invoke(IPC.navGetState, viewId),
    onState: (cb: (s: NavState) => void) => subscribe<NavState>(IPC.evtNavState, cb),
    onFailed: (cb: (f: NavFailed) => void) => subscribe<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb: (c: NavCrashed) => void) => subscribe<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId: ViewId, visible: boolean) =>
      ipcRenderer.invoke(IPC.viewSetContentVisible, viewId, visible),
    setContentInset: (viewId: ViewId, inset: ContentInset) =>
      ipcRenderer.invoke(IPC.viewSetContentInset, viewId, inset),
    setChromeOverlay: (viewId: ViewId, active: boolean) =>
      ipcRenderer.invoke(IPC.viewSetChromeOverlay, viewId, active),
    setFullscreen: (viewId: ViewId, on: boolean) =>
      ipcRenderer.invoke(IPC.viewSetFullscreen, viewId, on),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (partial: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, partial),
  },
  adblock: {
    setEnabled: (enabled: boolean): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockSetEnabled, enabled),
    toggleAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockToggleAllowlist, host),
    getState: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockGetState),
    removeAllowlist: (host: string): Promise<AdblockState> =>
      ipcRenderer.invoke(IPC.adblockRemoveAllowlist, host),
    clearAllowlist: (): Promise<AdblockState> => ipcRenderer.invoke(IPC.adblockClearAllowlist),
    onBlockedCount: (cb: (c: BlockedCount) => void) =>
      subscribe<BlockedCount>(IPC.evtAdblockBlockedCount, cb),
  },
  lists: {
    updateNow: (): Promise<ListUpdateResult> => ipcRenderer.invoke(IPC.listsUpdateNow),
  },
  subs: {
    list: (): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsList),
    setEnabled: (listId: string, enabled: boolean): Promise<Subscription[]> =>
      ipcRenderer.invoke(IPC.subsSetEnabled, listId, enabled),
    add: (url: string): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsAdd, url),
    remove: (listId: string): Promise<Subscription[]> => ipcRenderer.invoke(IPC.subsRemove, listId),
  },
  customFilters: {
    get: (): Promise<string> => ipcRenderer.invoke(IPC.customFiltersGet),
    set: (text: string): Promise<string> => ipcRenderer.invoke(IPC.customFiltersSet, text),
  },
  favorites: {
    list: (): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesList),
    add: (input: { name: string; url: string; tags: string[] }): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesAdd, input),
    update: (
      id: number,
      partial: { name?: string; url?: string; tags?: string[] },
    ): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesUpdate, id, partial),
    remove: (id: number): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesRemove, id),
    reorder: (ids: number[]): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesReorder, ids),
    renameTag: (oldT: string, newT: string): Promise<Favorite[]> =>
      ipcRenderer.invoke(IPC.favoritesRenameTag, oldT, newT),
    deleteTag: (tag: string): Promise<Favorite[]> => ipcRenderer.invoke(IPC.favoritesDeleteTag, tag),
    tagUnion: (): Promise<string[]> => ipcRenderer.invoke(IPC.favoritesTagUnion),
  },
  history: {
    list: (opts?: { limit?: number; offset?: number }): Promise<HistoryEntry[]> =>
      ipcRenderer.invoke(IPC.historyList, opts),
    search: (q: string): Promise<HistoryEntry[]> => ipcRenderer.invoke(IPC.historySearch, q),
    remove: (id: number): Promise<void> => ipcRenderer.invoke(IPC.historyRemove, id),
    clear: (): Promise<void> => ipcRenderer.invoke(IPC.historyClear),
    onChanged: (cb: () => void) => subscribe<unknown>(IPC.evtHistoryChanged, () => cb()),
  },
  saved: {
    list: (): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedList),
    add: (input: { url: string; title: string }): Promise<SavedItem[]> =>
      ipcRenderer.invoke(IPC.savedAdd, input),
    remove: (id: number): Promise<SavedItem[]> => ipcRenderer.invoke(IPC.savedRemove, id),
    has: (url: string): Promise<boolean> => ipcRenderer.invoke(IPC.savedHas, url),
  },
  downloads: {
    list: (): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsList),
    remove: (id: number): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsRemove, id),
    clear: (): Promise<DownloadEntry[]> => ipcRenderer.invoke(IPC.downloadsClear),
    openFile: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsOpenFile, id),
    showInFolder: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsShowInFolder, id),
    cancel: (id: number): Promise<void> => ipcRenderer.invoke(IPC.downloadsCancel, id),
    onChanged: (cb: () => void) => subscribe<unknown>(IPC.evtDownloadsChanged, () => cb()),
  },
  permissions: {
    list: (): Promise<SitePermission[]> => ipcRenderer.invoke(IPC.permissionsList),
    remove: (origin: string, permission: string): Promise<SitePermission[]> =>
      ipcRenderer.invoke(IPC.permissionsRemove, origin, permission),
    clear: (): Promise<SitePermission[]> => ipcRenderer.invoke(IPC.permissionsClear),
    resolve: (requestId: number, decision: 'allow' | 'deny'): Promise<void> =>
      ipcRenderer.invoke(IPC.permissionsResolve, requestId, decision),
    onPrompt: (cb: (p: PermissionPrompt) => void) =>
      subscribe<PermissionPrompt>(IPC.evtPermissionsPrompt, cb),
  },
  data: {
    export: (): Promise<{ ok: boolean; path?: string }> => ipcRenderer.invoke(IPC.dataExport),
    import: (mode: ImportMode): Promise<{ ok: boolean; counts?: any }> =>
      ipcRenderer.invoke(IPC.dataImport, mode),
  },
  picker: {
    start: (): Promise<{ ok: boolean; rule?: string }> => ipcRenderer.invoke(IPC.pickerStart),
  },
};

contextBridge.exposeInMainWorld('aegis', api);
