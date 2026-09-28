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
  ListUpdateResult,
  Subscription,
  DownloadEntry,
  SitePermission,
  PermissionPrompt,
  DataImportResult,
  TabsState,
  TabShortcut,
  UpdateState,
  SafetyInterstitialPayload,
  SyncState,
  SyncDevice,
  SyncChanged,
  SyncVaultQuarantined,
  FindState,
  ZoomState,
  VaultState,
  VaultRecord,
  VaultRecordInput,
  FingerprintState,
  WebrtcExemptState,
  ProxyConfig,
  ProxyState,
  FormLoginDetectedResult,
  FormState,
  FormWillSubmit,
  Workspace,
  WorkspaceState,
} from '../../shared/types';
import { IPC } from '../../shared/types';
import { call as rawCall, on } from './tauriInvoke';
import { clampZoom } from './zoom';

/**
 * A renderer→core call that the Rust side rejected.
 *
 * The core returns `Err(String)` for a lot of *ordinary* conditions — the vault being
 * locked, an unreachable proxy. Those rejections used
 * to reach call sites as bare strings from the ~58 `void aegis.*` fire-and-forget
 * invocations with nothing catching them, so the only thing that ever handled a rejected
 * IPC was the `ErrorBoundary` in `main.tsx` — which replaces the ENTIRE chrome with
 * "Something went wrong". A locked vault could therefore blank the whole window.
 *
 * Wrapping the single `call` chokepoint (all 120 channels route through `dedupedCall`, and
 * every non-dedupable mutation routes straight to `call`) means the rejection is now a
 * *typed* value, so `main.tsx`'s `unhandledrejection` handler can show a toast for it
 * instead of letting it become a full-window crash card. Call sites that DO catch can
 * still `instanceof`-check it to distinguish an expected condition from a real fault.
 */
export class AegisIpcError extends Error {
  /** The IPC channel that rejected, e.g. `'vault.list'`. */
  readonly channel: string;

  constructor(channel: string, message: string) {
    super(message);
    this.name = 'AegisIpcError';
    this.channel = channel;
  }
}

/**
 * Best-effort human-readable text for whatever the IPC layer threw.
 *
 * Tauri 2 rejects with the bare `String` a Rust `Err(String)` carried, but `invoke` can
 * also reject with an `Error` (a missing command, a deserialization failure) or, in tests,
 * anything at all — so this must not assume a shape.
 */
function ipcErrorText(e: unknown): string {
  if (typeof e === 'string') return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === 'object' && 'message' in e && typeof e.message === 'string') {
    return e.message;
  }
  return String(e);
}

/**
 * The one place a renderer→core rejection becomes an `AegisIpcError`.
 *
 * Deliberately wraps rather than swallows: callers that await still get a rejection (so
 * their existing `try`/`catch` keeps working), it is just now identifiable.
 */
function call<T>(channel: string, payload?: Record<string, unknown>): Promise<T> {
  return rawCall<T>(channel, payload).catch((e: unknown) => {
    throw new AegisIpcError(channel, ipcErrorText(e));
  });
}

type IPCChannel = (typeof IPC)[keyof typeof IPC];

// Enhanced deduplication cache with adaptive windows and telemetry
interface DedupEntry<T> {
  timestamp: number;
  promise: Promise<T>;
}

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

// The set of channels that MAY be collapsed, derived from DEDUP_WINDOWS' own keys (minus the
// `default` sentinel) so the two can never drift apart.
//
// This is deliberately an ALLOWLIST. The previous design denylisted mutations in
// `NON_DEDUP_CHANNELS`, which fails open: any mutating channel nobody remembered to add — or
// any added later — silently fell into the 300ms default window and had its second identical
// call answered from cache instead of reaching the backend. Because the payload hash ignores
// absent keys, `tabs.create()` with no args hashed to `{}`, so holding Ctrl+T (the webview
// emits `tabs.shortcut="new"` on every key-repeat) opened one tab per ~300ms, and
// `fingerprintToggleAllowlist` — a *toggle* — lost off-then-on within the window while the UI
// showed the wrong state. With an allowlist, a new mutation is safe by construction: it simply
// is not in this set. Adding a read-only channel here is the explicit, reviewed act.
const DEDUPABLE_CHANNELS: ReadonlySet<string> = new Set(
  Object.keys(DEDUP_WINDOWS).filter((ch) => ch !== 'default'),
);

const dedupeCache = new Map<string, DedupEntry<any>>();

// Deterministic cleanup every 10 seconds, started LAZILY on the first deduped call rather than
// at module load: a module-load `setInterval` wakes the renderer forever (and in every vitest
// worker that imports this file) even when no deduplicated call is ever made, and it can never
// be torn down. Once the cache drains there is nothing left to sweep, so the timer self-cancels
// and is re-armed by the next call that actually adds an entry.
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

function ensureCleanupTimer(): void {
  if (cleanupTimer !== null || typeof setInterval === 'undefined') return;
  cleanupTimer = setInterval(() => {
    cleanupCache();
    if (dedupeCache.size === 0 && cleanupTimer !== null) {
      clearInterval(cleanupTimer);
      cleanupTimer = null;
    }
  }, 10_000);
}

function getDedupWindow(channel: string): number {
  return DEDUP_WINDOWS[channel] ?? DEDUP_WINDOWS.default;
}

// Hash function for payloads to create dedup cache keys
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
  // Only explicitly-allowlisted read-only queries may be collapsed. Everything else — every
  // mutation, and any channel added without updating DEDUP_WINDOWS — is issued unconditionally.
  if (!DEDUPABLE_CHANNELS.has(channel)) {
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
    return cached.promise as Promise<T>;
  }

  // Make the actual call and cache the promise
  const promise = call<T>(channel, payload);
  dedupeCache.set(key, { timestamp: now, promise });
  ensureCleanupTimer();

  // A REJECTED promise must not stay memoized. `cleanupCache` only evicts on age, so
  // without this a single transient failure (a vault that was locked at that instant, a
  // proxy that was briefly down) is replayed to every caller for the next `window * 2` —
  // turning one flaky response into a burst of unrelated-looking errors. Evicting here
  // means the next caller retries for real, which is what a read-only query wants.
  // Guarded on identity so a newer entry for the same key is not removed.
  void promise.catch(() => {
    if (dedupeCache.get(key)?.promise === promise) {
      dedupeCache.delete(key);
    }
  });

  return promise;
}

function cleanupCache(now: number = Date.now()): void {
  for (const [key, entry] of dedupeCache.entries()) {
    // Extract channel from key to get appropriate window
    const channelPart = key.split(':')[0];

    // Only allowlisted channels are ever inserted (see `dedupedCall`), so this is normally
    // unreachable — kept as a cheap invariant guard so a future write path can't let a
    // non-dedupable channel pin an entry forever.
    if (!DEDUPABLE_CHANNELS.has(channelPart)) {
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
      // BlockedCount via window.__aegisBlockedCount (set up here), mirroring nav state.
      // The desktop path uses the Tauri event.
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
  // There is deliberately no `redirect.*` namespace. A blocked cross-origin redirect is NOT
  // reported to the chrome: the native guard opens the destination itself —
  // `redirect_guard::on_blocked_redirect_to_new_tab` → `tabs::open_redirect_background` on
  // desktop, a Snackbar on Android — so there is no event, no `window` bridge, and nothing to
  // subscribe to. Do not add one. A second open path would open TWO background tabs per
  // blocked redirect, and an event with no consumer is the drift this repo now tests for
  // (`shared/ipcCatalog.drift.test.ts`).
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
    onChanged: (cb) => on(IPC.evtSubsChanged, cb),
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
        ? await dedupedCall<DataImportResult>(IPC.dataImport, { mode, text })
        : await dedupedCall<DataImportResult>(IPC.dataImport, { mode });
      // Make the import live immediately — favorites/saved/settings hooks only fetch
      // on mount, so reload the chrome to re-read everything (no app restart). Delay
      // briefly so the success toast is visible first.
      //
      // Only a COMPLETE import reloads. A partial one (`ok: false` with a non-empty
      // `failed`) did change the stores that landed, but reloading would destroy the
      // toast naming the ones that did not, which is the only thing telling the user
      // their backup is still waiting for them. They can retry from the draft.
      if (result && result.ok) {
        setTimeout(() => window.location.reload(), 700);
      }
      return result;
    },
  },
  picker: {
    start: () => dedupedCall<{ ok: boolean }>(IPC.pickerStart, undefined),
    onPicked: (cb) => on<{ rule: string }>(IPC.evtPickerPicked, cb),
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
    onVaultQuarantined: (cb) => on<SyncVaultQuarantined>(IPC.evtSyncVaultQuarantined, cb),
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
  // The WebRTC exemption is a LOCAL-ONLY list, so unlike `fingerprint` there is no
  // `onSyncChange` subscription for it: a peer merge cannot change it, by construction.
  webrtc: {
    getExemptHosts: () => dedupedCall<WebrtcExemptState>(IPC.webrtcGetExemptHosts, undefined),
    toggleExempt: (host) => dedupedCall<WebrtcExemptState>(IPC.webrtcToggleExempt, { host }),
    removeExempt: (host) => dedupedCall<WebrtcExemptState>(IPC.webrtcRemoveExempt, { host }),
    clearExempt: () => dedupedCall<WebrtcExemptState>(IPC.webrtcClearExempt, undefined),
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
    // Phase B — the Rust handlers exist (`vault.rs`), but NO UI surface calls these yet: the
    // chrome-side autofill hook chain (`AutofillBadge` → `useVaultDomainSuggestions` →
    // `useVaultAutofill`) was deleted as dead, unmounted code. The channels stay declared and
    // stay covered by the Rust `vault.rs` unit tests, which exercise the seal/unlock and
    // suggestion paths directly; deleting them here would break that coverage, not the build.
    autofill: (options: { domain: string; username?: string }) =>
      dedupedCall<VaultRecord[]>(IPC.vaultAutofill, options),
    autofillSuggestions: (domain: string) =>
      dedupedCall<VaultRecord[]>(IPC.vaultAutofillSuggestions, { domain }),
    onState: (cb: (s: VaultState) => void) => on<VaultState>(IPC.evtVaultState, cb),
    onChanged: (cb: () => void) => on<void>(IPC.evtVaultChanged, cb),
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
    onState: (cb: (s: FormState) => void) => on<FormState>(IPC.evtFormState, cb),
    onWillSubmit: (cb: (s: FormWillSubmit) => void) =>
      on<FormWillSubmit>(IPC.evtFormWillSubmit, cb),
  },
  workspace: {
    list: () => dedupedCall<WorkspaceState>(IPC.workspaceList, {}),
    create: (name: string, color?: string) =>
      dedupedCall<Workspace>(IPC.workspaceCreate, { name, color }),
    switch: (id: string) => dedupedCall<WorkspaceState>(IPC.workspaceSwitch, { id }),
    rename: (id: string, name: string) => dedupedCall<Workspace>(IPC.workspaceRename, { id, name }),
    setColor: (id: string, color: string) =>
      dedupedCall<Workspace>(IPC.workspaceSetColor, { id, color }),
    remove: (id: string) => dedupedCall<WorkspaceState>(IPC.workspaceRemove, { id }),
    reorder: (ids: string[]) => dedupedCall<WorkspaceState>(IPC.workspaceReorder, { ids }),
    onState: (cb: (workspaces: WorkspaceState) => void) =>
      on<WorkspaceState>(IPC.evtWorkspaceState, cb),
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
