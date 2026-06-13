export type ViewId = number;
export const PRIMARY_VIEW_ID: ViewId = 1;

/** https/http are full-navigation schemes; about:blank handled explicitly. */
export const ALLOWED_NAV_SCHEMES = ['https:', 'http:'] as const;

export const IPC = {
  navNavigate: 'nav.navigate',
  navBack: 'nav.back',
  navForward: 'nav.forward',
  navReloadOrStop: 'nav.reloadOrStop',
  navHome: 'nav.home',
  navGetState: 'nav.getState',
  viewSetContentVisible: 'view.setContentVisible',
  viewSetContentInset: 'view.setContentInset',
  viewSetChromeOverlay: 'view.setChromeOverlay',
  viewSetFullscreen: 'view.setFullscreen',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  // adblock + lists (chrome -> main)
  adblockSetEnabled: 'adblock.setEnabled',
  adblockToggleAllowlist: 'adblock.toggleAllowlist',
  adblockGetState: 'adblock.getState',
  listsUpdateNow: 'lists.updateNow',
  // favorites (chrome -> main)
  favoritesList: 'favorites.list',
  favoritesAdd: 'favorites.add',
  favoritesUpdate: 'favorites.update',
  favoritesRemove: 'favorites.remove',
  favoritesReorder: 'favorites.reorder',
  // history (chrome -> main)
  historyList: 'history.list',
  historySearch: 'history.search',
  historyRemove: 'history.remove',
  historyClear: 'history.clear',
  // saved list + tags (chrome -> main)
  savedList: 'saved.list',
  savedAdd: 'saved.add',
  savedRemove: 'saved.remove',
  savedHas: 'saved.has',
  savedUpdate: 'saved.update',
  savedRenameTag: 'saved.renameTag',
  savedDeleteTag: 'saved.deleteTag',
  savedTagUnion: 'saved.tagUnion',
  // subscriptions (chrome -> main, Phase 4)
  subsList: 'subs.list',
  subsSetEnabled: 'subs.setEnabled',
  subsAdd: 'subs.add',
  subsRemove: 'subs.remove',
  // custom filters (chrome -> main, Phase 4)
  customFiltersGet: 'customFilters.get',
  customFiltersSet: 'customFilters.set',
  // allowlist management (chrome -> main, Phase 4)
  adblockRemoveAllowlist: 'adblock.removeAllowlist',
  adblockClearAllowlist: 'adblock.clearAllowlist',
  // events (main -> chrome renderer)
  evtNavState: 'nav.state',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
  evtHistoryChanged: 'history.changed',
  // downloads (Phase 5, chrome -> main)
  downloadsList: 'downloads.list',
  downloadsRemove: 'downloads.remove',
  downloadsClear: 'downloads.clear',
  downloadsOpenFile: 'downloads.openFile',
  downloadsShowInFolder: 'downloads.showInFolder',
  downloadsCancel: 'downloads.cancel',
  // permissions (Phase 5, chrome <-> main)
  permissionsList: 'permissions.list',
  permissionsRemove: 'permissions.remove',
  permissionsClear: 'permissions.clear',
  permissionsResolve: 'permissions.resolve',
  // data export/import (Phase 5, chrome -> main)
  dataExport: 'data.export',
  dataImport: 'data.import',
  // element picker (Phase 5, chrome -> main)
  pickerStart: 'picker.start',
  // events (Phase 5, main -> chrome renderer)
  evtDownloadsChanged: 'downloads.changed',
  evtPermissionsPrompt: 'permissions.prompt',
  // auto-update (Phase S1, chrome <-> main)
  updateGetState: 'update.getState',
  updateCheckNow: 'update.checkNow',
  updateRestartToInstall: 'update.restartToInstall',
  evtUpdateState: 'update.state',
} as const;

export interface NavState {
  viewId: ViewId;
  url: string;
  title: string;
  canGoBack: boolean;
  canGoForward: boolean;
  isLoading: boolean;
  crashed: boolean;
}

export interface NavFailed {
  viewId: ViewId;
  errorCode: number;
  errorDescription: string;
  validatedURL: string;
  kind: 'load' | 'cert';
}

export interface NavCrashed {
  viewId: ViewId;
  reason: string;
}

// ---- places data model (Phase 3) ----
export interface Favorite {
  id: number;
  name: string;
  url: string;
  position: number;
}
export interface HistoryEntry {
  id: number;
  url: string;
  title: string;
  visitedAt: number;
}
export interface SavedItem {
  id: number;
  url: string;
  title: string;
  tags: string[];
  savedAt: number;
}
// ---- downloads / permissions data model (Phase 5) ----
export interface DownloadEntry {
  id: number;
  url: string;
  filename: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  totalBytes: number; // 0 when unknown
  startedAt: number;
}
export interface SitePermission {
  origin: string;
  permission: string;
  decision: 'allow' | 'deny';
}
export interface PermissionPrompt {
  requestId: number;
  origin: string;
  permission: string;
}
export type ImportMode = 'merge' | 'replace';
export interface ContentInset {
  top: number;
  left: number;
}

// ---- adblock data model ----
export interface AdblockState {
  enabled: boolean; // global on/off
  allowlistedHosts: string[]; // hosts where blocking is suppressed
  sessionBlocked: number; // monotonic session total
}
export interface BlockedCount {
  viewId: ViewId;
  page: number; // resets each top-frame, non-same-document navigation
  session: number; // monotonic
}
export interface ListSourceResult {
  listId: string;
  ok: boolean;
  error?: string;
}
export interface ListUpdateResult {
  perSource: ListSourceResult[];
  lastUpdated: number; // epoch ms of this refresh attempt
}

export interface UpdateState {
  status: 'idle' | 'checking' | 'available' | 'not-available' | 'downloading' | 'downloaded' | 'error';
  version: string | null; // available/downloaded version, else null
  percent: number; // download progress 0..100
  error: string | null; // last error message, else null
}

/**
 * One filter-list subscription row. Canonical shape lives in
 * `electron/main/db/subsRepo.ts`; re-declared here so the preload + renderer can
 * type the `subs.*` IPC surface without importing main-process modules.
 */
export interface Subscription {
  listId: string;
  url: string;
  enabled: boolean;
  lastUpdated: number | null;
  etag: string | null;
  hash: string | null;
}

export interface SearchEngine {
  id: string;
  name: string;
  template: string; // contains %s
}

export interface Settings {
  siteName: string;
  homeUrl: string;
  primaryColor: string;
  defaultSearchTemplate: string; // e.g. https://duckduckgo.com/?q=%s
  searchEngines: SearchEngine[]; // seeded; not editable until Phase 4
  hideChromeByDefault: boolean;
  downloadDir: string; // '' → main resolves to app.getPath('downloads')
  httpsOnly: boolean;
}

/** Exposed on window.aegis by chromePreload via contextBridge. */
export interface AegisApi {
  nav: {
    navigate(viewId: ViewId, url: string): Promise<void>;
    back(viewId: ViewId): Promise<void>;
    forward(viewId: ViewId): Promise<void>;
    reloadOrStop(viewId: ViewId): Promise<void>;
    home(viewId: ViewId): Promise<void>;
    getState(viewId: ViewId): Promise<NavState>;
    onState(cb: (s: NavState) => void): () => void;
    onFailed(cb: (f: NavFailed) => void): () => void;
    onCrashed(cb: (c: NavCrashed) => void): () => void;
  };
  view: {
    setContentVisible(viewId: ViewId, visible: boolean): Promise<void>;
    setContentInset(viewId: ViewId, inset: ContentInset): Promise<void>;
    setChromeOverlay(viewId: ViewId, active: boolean): Promise<void>;
    setFullscreen(viewId: ViewId, on: boolean): Promise<void>;
  };
  favorites: {
    list(): Promise<Favorite[]>;
    add(input: { name: string; url: string }): Promise<Favorite[]>;
    update(id: number, partial: { name?: string; url?: string }): Promise<Favorite[]>;
    remove(id: number): Promise<Favorite[]>;
    reorder(ids: number[]): Promise<Favorite[]>;
  };
  history: {
    list(opts?: { limit?: number; offset?: number }): Promise<HistoryEntry[]>;
    search(q: string): Promise<HistoryEntry[]>;
    remove(id: number): Promise<void>;
    clear(): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  saved: {
    list(): Promise<SavedItem[]>;
    add(input: { url: string; title: string; tags?: string[] }): Promise<SavedItem[]>;
    remove(id: number): Promise<SavedItem[]>;
    has(url: string): Promise<boolean>;
    update(id: number, partial: { title?: string; tags?: string[] }): Promise<SavedItem[]>;
    renameTag(oldT: string, newT: string): Promise<SavedItem[]>;
    deleteTag(tag: string): Promise<SavedItem[]>;
    tagUnion(): Promise<string[]>;
  };
  settings: {
    get(): Promise<Settings>;
    set(partial: Partial<Settings>): Promise<Settings>;
  };
  adblock: {
    setEnabled(enabled: boolean): Promise<AdblockState>;
    toggleAllowlist(host: string): Promise<AdblockState>;
    removeAllowlist(host: string): Promise<AdblockState>;
    clearAllowlist(): Promise<AdblockState>;
    getState(): Promise<AdblockState>;
    onBlockedCount(cb: (c: BlockedCount) => void): () => void;
  };
  lists: {
    updateNow(): Promise<ListUpdateResult>;
  };
  subs: {
    list(): Promise<Subscription[]>;
    setEnabled(listId: string, enabled: boolean): Promise<Subscription[]>;
    add(url: string): Promise<Subscription[]>;
    remove(listId: string): Promise<Subscription[]>;
  };
  customFilters: {
    get(): Promise<string>;
    set(text: string): Promise<string>;
  };
  downloads: {
    list(): Promise<DownloadEntry[]>;
    remove(id: number): Promise<DownloadEntry[]>;
    clear(): Promise<DownloadEntry[]>;
    openFile(id: number): Promise<void>;
    showInFolder(id: number): Promise<void>;
    cancel(id: number): Promise<void>;
    onChanged(cb: () => void): () => void;
  };
  permissions: {
    list(): Promise<SitePermission[]>;
    remove(origin: string, permission: string): Promise<SitePermission[]>;
    clear(): Promise<SitePermission[]>;
    resolve(requestId: number, decision: 'allow' | 'deny'): Promise<void>;
    onPrompt(cb: (p: PermissionPrompt) => void): () => void;
  };
  data: {
    export(): Promise<{ ok: boolean; path?: string }>;
    import(mode: ImportMode): Promise<{ ok: boolean; counts?: unknown }>;
  };
  picker: {
    start(): Promise<{ ok: boolean; rule?: string }>;
  };
  update: {
    getState(): Promise<UpdateState>;
    checkNow(): Promise<void>;
    restartToInstall(): Promise<void>;
    onState(cb: (s: UpdateState) => void): () => void;
  };
}

declare global {
  interface Window {
    aegis: AegisApi;
  }
}
