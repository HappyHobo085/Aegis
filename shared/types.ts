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
  viewSetSidebar: 'view.setSidebar',
  viewSetLayout: 'view.setLayout',
  viewSetFullscreen: 'view.setFullscreen',
  settingsGet: 'settings.get',
  settingsSet: 'settings.set',
  // adblock + lists (chrome -> main)
  adblockSetEnabled: 'adblock.setEnabled',
  adblockToggleAllowlist: 'adblock.toggleAllowlist',
  adblockGetState: 'adblock.getState',
  listsUpdateNow: 'lists.updateNow',
  evtListsUpdateResult: 'lists.updateResult',
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
  evtViewFullscreen: 'view.fullscreen',
  evtNavFailed: 'nav.failed',
  evtNavCrashed: 'nav.crashed',
  evtAdblockBlockedCount: 'adblock.blockedCount',
  evtRedirectBlocked: 'redirect.blocked',
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
  // safety interstitial (Phase 3a, chrome <-> main)
  safetyGetState: 'safety.getState',
  safetyProceed: 'safety.proceed',
  safetyListExceptions: 'safety.listExceptions',
  safetyRemoveException: 'safety.removeException',
  evtSafetyInterstitial: 'safety.interstitial',
  // tabs (chrome -> main)
  tabsCreate: 'tabs.create',
  tabsClose: 'tabs.close',
  tabsActivate: 'tabs.activate',
  tabsReorder: 'tabs.reorder',
  tabsSetPinned: 'tabs.setPinned',
  tabsReopenClosed: 'tabs.reopenClosed',
  tabsList: 'tabs.list',
  tabsSetTitle: 'tabs.setTitle',
  tabsRecordNav: 'tabs.recordNav',
  // events (main -> chrome): the tab list + which is active
  evtTabsState: 'tabs.state',
  evtTabsShortcut: 'tabs.shortcut',
  // sync (E2E-encrypted cross-platform sync)
  syncGetState: 'sync.getState',
  syncEnableNew: 'sync.enableNew',
  syncEnableFromPhrase: 'sync.enableFromPhrase',
  syncUnlock: 'sync.unlock',
  syncDisable: 'sync.disable',
  syncNow: 'sync.syncNow',
  syncTestConnection: 'sync.testConnection',
  syncGetRecoveryPhrase: 'sync.getRecoveryPhrase',
  syncListDevices: 'sync.listDevices',
  syncRemoveDevice: 'sync.removeDevice',
  // events (main -> chrome): engine state + a targeted post-merge change notice
  evtSyncState: 'sync.state',
  evtSyncChanged: 'sync.changed',
  // find-in-page (chrome -> main; Task 9+ wires the Rust/Kotlin back-ends)
  findStart: 'find.start',
  findNext: 'find.next',
  findPrev: 'find.prev',
  findClose: 'find.close',
  // event (main -> chrome): live match count / active index
  evtFindState: 'find.state',
  // page zoom (chrome <-> main)
  zoomGet: 'zoom.get',
  zoomSet: 'zoom.set',
  zoomReset: 'zoom.reset',
  // event (main -> chrome): a tab's zoom factor changed
  evtZoomChanged: 'zoom.changed',
  // password vault (Phase A — manage only, NO autofill)
  vaultGetState: 'vault.getState',
  vaultCreate: 'vault.create',
  vaultUnlock: 'vault.unlock',
  vaultLock: 'vault.lock',
  vaultList: 'vault.list',
  vaultAdd: 'vault.add',
  vaultUpdate: 'vault.update',
  vaultRemove: 'vault.remove',
  vaultSearch: 'vault.search',
  evtVaultState: 'vault.state',
  // fingerprint per-site allowlist (chrome -> main)
  fingerprintGetState: 'fingerprint.getState',
  fingerprintToggleAllowlist: 'fingerprint.toggleAllowlist',
  fingerprintRemoveAllowlist: 'fingerprint.removeAllowlist',
  fingerprintClearAllowlist: 'fingerprint.clearAllowlist',
  // proxy (content-webview proxy: mode/scheme/host/port/bypass)
  proxyGetState: 'proxy.getState',
  proxySetConfig: 'proxy.setConfig',
  proxyClear: 'proxy.clear',
  proxyTestConnection: 'proxy.testConnection',
  evtProxyState: 'proxy.state',
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

// ---- tabs data model ----
/** One row in the tab strip. `live` is false for a discarded ("asleep") tab. */
export interface TabMeta {
  id: ViewId;
  pinned: boolean;
  live: boolean;
  /** Latest page title (empty until the page reports one). */
  title: string;
  /** Latest URL — label fallback (hostname) when there's no title. */
  url: string;
  /** A private (incognito) tab: ephemeral data partition, excluded from history/sync/downloads. */
  private: boolean;
}
/** The whole tab list + which tab is active. Order === strip order. */
export interface TabsState {
  tabs: TabMeta[];
  activeId: ViewId;
}

export type TabShortcut =
  | 'new'
  | 'close'
  | 'next'
  | 'prev'
  | 'reopen'
  | 'jump1'
  | 'jump2'
  | 'jump3'
  | 'jump4'
  | 'jump5'
  | 'jump6'
  | 'jump7'
  | 'jump8'
  | 'jumpLast';

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

/** A content tab's current page-zoom factor (1.0 == 100%). Session-only in v1
 * (in-memory, per live tab, not persisted, not per-origin). v2 (per-origin) can layer a
 * disk store + a main-frame-origin re-apply hook WITHOUT changing this IPC surface. */
export interface ZoomState {
  viewId: ViewId;
  factor: number; // clamped to [0.5, 3.0]
}

export interface FingerprintState {
  level: string; // 'off' | 'standard' | 'strict'
  allowlistedHosts: string[];
}

/** Proxy configuration sent to `proxy.setConfig`. */
export interface ProxyConfig {
  mode: 'off' | 'proxy';
  scheme: 'http' | 'socks5';
  host: string;
  port: number;
  bypassHosts: string[];
}

/** Full proxy state returned by `proxy.getState` and emitted as `proxy.state`. */
export interface ProxyState extends ProxyConfig {
  active: boolean;
  uri: string | null;
}

export interface VaultState {
  exists: boolean;
  unlocked: boolean;
  count: number;
  /**
   * Count of on-disk records that could not be decrypted on unlock (corrupt/truncated).
   * They are PRESERVED on disk (not dropped), so the UI warns rather than silently losing
   * credentials. 0 in the normal case.
   */
  undecryptable: number;
}
export interface VaultRecord {
  uuid: string;
  updatedAt: number;
  site: string;
  username: string;
  password: string;
  notes: string;
}
export interface VaultRecordInput {
  site: string;
  username: string;
  password: string;
  notes?: string;
}

// ---- adblock data model ----
export interface AdblockState {
  enabled: boolean; // global on/off
  allowlistedHosts: string[]; // hosts where blocking is suppressed
  sessionBlocked: number; // monotonic session total
  pageBlocked?: number; // active tab's current-page count (recovers it on mount/tab-switch when live events were missed)
}
export interface BlockedCount {
  viewId: ViewId;
  page: number; // resets each top-frame, non-same-document navigation
  session: number; // monotonic
}
/** A scripted (non-user-gesture) cross-origin top-frame navigation that the
 * redirect guard cancelled. Drives the "Open anyway" toast. */
export interface RedirectBlocked {
  viewId: ViewId;
  from: string;
  to: string;
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
  status:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  version: string | null; // available/downloaded version, else null
  percent: number; // download progress 0..100
  error: string | null; // last error message, else null
}

/**
 * A full-window safety interstitial shown over the content view. `reason` is
 * extensible — Phase 3a uses only 'https-failed'; Phase 3b adds 'malware'.
 */
export interface SafetyInterstitialPayload {
  /** The http URL the user may choose to continue to. */
  url: string;
  reason: 'https-failed' | 'malware';
}

/** One filter-list subscription row — the shape of the `subs.*` IPC surface. */
export interface Subscription {
  listId: string;
  url: string;
  enabled: boolean;
  lastUpdated: number | null;
  etag: string | null;
  hash: string | null;
  /**
   * True for the seeded default lists (EasyList, EasyPrivacy, Peter Lowe's). These are
   * toggleable but not removable from the UI — disabling, not deleting, is the control
   * (re-seeding respects a removal, but the UI hides Remove to keep the defaults present).
   * Absent/false for user-added lists.
   */
  builtin?: boolean;
}

export interface SearchEngine {
  id: string;
  name: string;
  template: string; // contains %s
}

export interface Settings {
  homeUrl: string;
  primaryColor: string;
  defaultSearchTemplate: string; // e.g. https://duckduckgo.com/?q=%s
  searchEngines: SearchEngine[]; // seeded; not editable until Phase 4
  hideChromeByDefault: boolean;
  downloadDir: string; // '' → main resolves to app.getPath('downloads')
  httpsOnly: boolean;
  /** Minutes a background tab may sit idle before it is discarded (reloaded on
   * return). 0 disables time-based discard. */
  tabIdleTimeout: number;
  /** WebRTC IP-leak policy. `'public-only'` (default) filters local/private ICE
   * candidates so a page can't read your LAN/loopback IP, while keeping TURN/relay
   * candidates so calls still work; `'disable'` blocks WebRTC construction entirely
   * (breaks video calls); `'default'` applies no filtering. */
  webrtcPolicy: 'default' | 'public-only' | 'disable';
  /** Chrome theme: `'system'` (default) follows the OS via `prefers-color-scheme`,
   * `'dark'` / `'light'` force a palette. Renderer-only — the resolved palette is a
   * `data-theme` attribute on <html> (see src/lib/theme.ts). */
  themeMode: 'system' | 'dark' | 'light';
  /** Anti-fingerprinting (farbling) level. Default `'off'` (opt-in) — standard and
   * strict add per-session CSPRNG noise to canvas/audio/WebGL read surfaces so a
   * site sees a stable-but-unique fingerprint within a session rather than the real
   * value. Honest limit: a same-world JS shim is detectable; see src-tauri/CLAUDE.md. */
  antiFingerprint: 'off' | 'standard' | 'strict';
  /** The E2E-encrypted sync server endpoint. Empty = sync not configured (data stays
   * local). Self-hosted: paste your reference-server URL. The server only ever sees
   * opaque ciphertext. */
  syncServerUrl?: string;
}

/** Engine status for the Sync settings UI. The server only stores ciphertext. */
export interface SyncState {
  enabled: boolean;
  status: 'disabled' | 'idle' | 'syncing' | 'error';
  serverUrl: string;
  lastSyncMs: number;
  lastError: string;
  deviceId: string;
  accountId: string;
  vaultBacking: 'keychain' | 'passphrase' | 'none';
  hasStoredRoot: boolean;
}

export interface SyncDevice {
  deviceId: string;
  label: string;
  lastSeenMs?: number;
  isThisDevice: boolean;
}

/** Targeted post-merge change notice — drives a per-store refetch, never a full reload. */
export interface SyncChanged {
  namespace: string;
  changedUuids: string[];
}

/** Live match state pushed by the Rust/Kotlin back-end during a find-in-page session.
 * `activeMatchIndex` is 1-based; 0 means unknown (WebKitGTK / macOS don't report it). */
export interface FindState {
  viewId: ViewId;
  query: string;
  matchCount: number;
  activeMatchIndex: number;
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
  tabs: {
    list(): Promise<TabsState>;
    create(url?: string, background?: boolean, isPrivate?: boolean): Promise<TabsState>;
    close(id: ViewId): Promise<TabsState>;
    activate(id: ViewId): Promise<TabsState>;
    reorder(ids: ViewId[]): Promise<TabsState>;
    setPinned(id: ViewId, pinned: boolean): Promise<TabsState>;
    reopenClosed(): Promise<TabsState>;
    /** Record a tab's page title in the registry. On Android the content WebView's
     * title isn't observed by the Rust core (no WebKit title signal), so the chrome
     * relays it from the nav state to keep the tab switcher labels accurate. */
    setTitle(id: ViewId, title: string): Promise<TabsState>;
    /** Record a tab's current URL/title in the registry. Android navigation happens in
     * the native WebView bridge, so the chrome relays nav state back for session restore. */
    recordNav(id: ViewId, url: string, title?: string): Promise<TabsState>;
    onState(cb: (s: TabsState) => void): () => void;
    onShortcut(cb: (s: TabShortcut) => void): () => void;
  };
  view: {
    setContentVisible(viewId: ViewId, visible: boolean): Promise<void>;
    setContentInset(viewId: ViewId, inset: ContentInset): Promise<void>;
    setChromeOverlay(viewId: ViewId, active: boolean): Promise<void>;
    /** The sidebar is a right panel: inset the content from the right (page stays
     * visible) rather than hiding it. Optional — Electron composes its sidebar via
     * the chrome overlay, so it may not implement this. */
    setSidebar?(viewId: ViewId, active: boolean, width?: number): Promise<void>;
    /** Atomic overlay+sidebar update in ONE call, so the content layout is applied from
     * consistent state — avoids the two-call race (setChromeOverlay + setSidebar) where a
     * full overlay like Settings could land behind the content. Optional — Tauri desktop. */
    setLayout?(
      viewId: ViewId,
      opts: { overlay: boolean; sidebar: boolean; width?: number },
    ): Promise<void>;
    setFullscreen(viewId: ViewId, on: boolean): Promise<void>;
    /** Backend-driven fullscreen change (e.g. Esc exits on Tauri). Optional:
     * Electron's chrome owns its own fullscreen exit, so it may not emit this. */
    onFullscreen?(cb: (state: { on: boolean }) => void): () => void;
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
  redirect: {
    onBlocked(cb: (r: RedirectBlocked) => void): () => void;
  };
  lists: {
    /**
     * Start a background refresh of every enabled subscription. Resolves immediately —
     * the (synchronous, main-thread) core command must not block on the up-to-25s fetch.
     * The per-source result arrives later via `onUpdateResult`.
     */
    updateNow(): Promise<void>;
    /** Fires when a background `updateNow` finishes, carrying its per-source result. */
    onUpdateResult(cb: (result: ListUpdateResult) => void): () => void;
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
    import(
      mode: ImportMode,
      source?: { text?: string },
    ): Promise<{ ok: boolean; counts?: unknown }>;
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
  safety: {
    getState(): Promise<SafetyInterstitialPayload | null>;
    proceed(url: string): Promise<void>;
    listExceptions(): Promise<string[]>;
    removeException(host: string): Promise<void>;
    onInterstitial(cb: (p: SafetyInterstitialPayload | null) => void): () => void;
  };
  sync: {
    getState(): Promise<SyncState>;
    /** Start fresh — returns the 24-word recovery phrase ONCE (show, then discard). */
    enableNew(opts?: { passphrase?: string }): Promise<{ recoveryPhrase: string }>;
    enableFromPhrase(opts: { phrase: string; passphrase?: string }): Promise<SyncState>;
    unlock(opts: { passphrase: string }): Promise<SyncState>;
    disable(opts?: { forget?: boolean }): Promise<SyncState>;
    syncNow(): Promise<SyncState>;
    testConnection(url: string): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
    /** Highest-sensitivity: gated on an explicit confirm. */
    getRecoveryPhrase(opts: { confirm: boolean }): Promise<{ recoveryPhrase: string }>;
    listDevices(): Promise<SyncDevice[]>;
    removeDevice(deviceId: string): Promise<SyncDevice[]>;
    onState(cb: (s: SyncState) => void): () => void;
    onChanged(cb: (c: SyncChanged) => void): () => void;
  };
  find: {
    /** Begin (or refine) a search for `query` on the view. */
    start(viewId: ViewId, query: string, caseSensitive?: boolean): Promise<void>;
    /** Advance to the next match. */
    next(viewId: ViewId): Promise<void>;
    /** Go back to the previous match. */
    prev(viewId: ViewId): Promise<void>;
    /** End the search and clear highlights. */
    close(viewId: ViewId): Promise<void>;
    /** Subscribe to live match-count / active-index updates. Returns unsubscribe fn. */
    onState(cb: (s: FindState) => void): () => void;
  };
  zoom: {
    get(viewId: ViewId): Promise<ZoomState>;
    /** Set an absolute factor (clamped server-side). Returns the applied state. */
    set(viewId: ViewId, factor: number): Promise<ZoomState>;
    /** Reset to 1.0. Returns the applied state. */
    reset(viewId: ViewId): Promise<ZoomState>;
    onChanged(cb: (s: ZoomState) => void): () => void;
  };
  vault: {
    getState(): Promise<VaultState>;
    create(masterPassword: string): Promise<VaultState>;
    unlock(masterPassword: string): Promise<VaultState>;
    lock(): Promise<VaultState>;
    list(): Promise<VaultRecord[]>;
    add(input: VaultRecordInput): Promise<VaultRecord[]>;
    update(uuid: string, partial: Partial<VaultRecordInput>): Promise<VaultRecord[]>;
    remove(uuid: string): Promise<VaultRecord[]>;
    search(q: string): Promise<VaultRecord[]>;
    onState(cb: (s: VaultState) => void): () => void;
  };
  fingerprint: {
    getState(): Promise<FingerprintState>;
    toggleAllowlist(host: string): Promise<FingerprintState>;
    removeAllowlist(host: string): Promise<FingerprintState>;
    clearAllowlist(): Promise<FingerprintState>;
  };
  proxy: {
    getState(): Promise<ProxyState>;
    setConfig(config: ProxyConfig): Promise<ProxyState>;
    clear(): Promise<ProxyState>;
    testConnection(
      config: ProxyConfig,
    ): Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
    onState(cb: (s: ProxyState) => void): () => void;
  };
}

declare global {
  interface Window {
    aegis: AegisApi;
  }
}
