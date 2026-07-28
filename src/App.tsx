// src/App.tsx
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Settings, PanelRight, Maximize2, Minimize2 } from 'lucide-react';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { confirm, toast } from './lib/toast';
import { useChromeHeights } from './hooks/useChromeHeights';
import { hostOf, originOf } from './lib/url';
import { ChromeSurfaceProvider, useChromeSurfaceRegistry } from './hooks/useChromeSurfaces';
import { computeContentLayout, computeSplitLayout, clampResizeDelta } from './lib/contentLayout';
import type { PaneRect } from './lib/contentLayout';
import { protectionSummary } from './lib/protectionSummary';
import { useDownloadToasts } from './hooks/useDownloadToasts';
import { useNav } from './hooks/useNav';
import { useFind } from './hooks/useFind';
import { useZoom } from './hooks/useZoom';
import { useAdblock } from './hooks/useAdblock';
import { useFingerprint } from './hooks/useFingerprint';
import { useFavorites } from './hooks/useFavorites';
import { useHistory } from './hooks/useHistory';
import { useSaved } from './hooks/useSaved';
import { useSettings } from './hooks/useSettings';
import { useSync } from './hooks/useSync';
import { useVault } from './hooks/useVault';
import { useProxy } from './hooks/useProxy';
import { useSubscriptions } from './hooks/useSubscriptions';
import { useCustomFilters } from './hooks/useCustomFilters';
import { useDownloads } from './hooks/useDownloads';
import { usePermissions } from './hooks/usePermissions';
import { useContentInset } from './hooks/useContentInset';
import { FIND_BAR_H } from './lib/layout';
import { useNarrowViewport } from './hooks/useNarrowViewport';
import { useUpdate } from './hooks/useUpdate';
import { useSafety } from './hooks/useSafety';
import { useTabs } from './hooks/useTabs';
import { useWorkspaces } from './hooks/useWorkspaces';
import { useSplit } from './hooks/useSplit';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { DownloadsIndicator } from './components/DownloadsIndicator';
import { PickerButton } from './components/PickerButton';
import { UpdateIndicator } from './components/UpdateIndicator';
import { ZoomIndicator } from './components/ZoomIndicator';
import { SplitIndicator } from './components/SplitIndicator';
import { SplitResizeHandle } from './components/SplitResizeHandle';
import { SafetyInterstitial } from './components/SafetyInterstitial';
import { FavoritesBar } from './components/FavoritesBar';
import { FavoritesManager } from './components/FavoritesManager';
import { Sidebar } from './components/Sidebar';
import { HistoryPanel } from './components/HistoryPanel';
import { SavedPanel } from './components/SavedPanel';
import { DownloadsModal } from './components/DownloadsModal';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SkipLink } from './components/SkipLink';
import { Toaster } from './components/Toaster';
import { ConfirmDialog } from './components/ConfirmDialog';
import { PermissionPromptDialog } from './components/PermissionPromptDialog';
import { Onboarding } from './components/Onboarding';
import { SettingsModal } from './components/SettingsModal';
import type { SettingsTab } from './components/SettingsModal';
import { CommandPalette } from './components/CommandPalette';
import { AppearanceTab } from './components/AppearanceTab';
import { SearchTab } from './components/SearchTab';
import { HomeTab } from './components/HomeTab';
import { AllowlistTab } from './components/AllowlistTab';
import { DownloadsTab } from './components/DownloadsTab';
import { SitePermissionsTab } from './components/SitePermissionsTab';
import { DataTab } from './components/DataTab';
import { TabsTab } from './components/TabsTab';
import { TabStrip } from './components/TabStrip';
import { WorkspaceSwitcher } from './components/WorkspaceSwitcher';
import { FindBar } from './components/FindBar';
import { MobileApp } from './components/mobile/MobileApp';
import { installAutopilotControl } from './autopilot/control';

/** Runtime check for mobile shell — safe against import reordering. */
function getIsMobile(): boolean {
  return (
    typeof document !== 'undefined' && document.documentElement.classList.contains('aegis-mobile')
  );
}

// Windows hides the native "Tabs" menu bar (redundant with the tab strip), which drops
// its keyboard accelerators — so the chrome handles the tab shortcuts itself there. macOS
// keeps the menu (in the system menu bar), so it handles them natively, to avoid double-firing.
const isWindows = typeof navigator !== 'undefined' && navigator.userAgent.includes('Windows');

const CONTENT_ANCHOR_ID = 'content-anchor';
const CHROME_NAV_REDIRECT_GRACE_MS = 1500;
const CHROME_NAV_REASSERT_MS = 250;

function DesktopApp() {
  // One-time performance measurement: marks when React mount completes.
  useEffect(() => {
    try {
      performance.mark('aegis-react-end');
      performance.measure('aegis-mount', 'aegis-react-start', 'aegis-react-end');
      const entries = performance.getEntriesByName('aegis-mount');
      if (entries.length > 0) {
        console.log(`[aegis-perf] React mount: ${Math.round(entries[0].duration)}ms`);
      }
    } catch {
      // In test environments or when the start mark wasn't set, silently ignore.
    }
  }, []);

  const tabs = useTabs();
  const workspaces = useWorkspaces();
  // Stable refs for keyboard shortcut effects — tabs.tabs is a new array on every
  // state update; using refs avoids re-registering listeners each render.
  const tabsRef = useRef(tabs.tabs);
  tabsRef.current = tabs.tabs;
  const activeIdRef = useRef(tabs.activeId);
  activeIdRef.current = tabs.activeId;
  const nav = useNav(tabs.activeId);
  const isNarrow = useNarrowViewport();
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  // The ad-block shield popover is a chrome dropdown; track it so the content webview
  // is lowered while it's open (Tauri's content view is opaque and on top).
  const [shieldOpen, setShieldOpen] = useState(false);
  const zoom = useZoom(tabs.activeId);
  // The zoom indicator popover is a chrome dropdown; like the shield popover, track it so the
  // content webview is lowered while it's open (Tauri's content view is opaque and on top).
  const [zoomOpen, setZoomOpen] = useState(false);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const settings = useSettings();
  const sync = useSync();
  const vault = useVault();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const downloads = useDownloads();
  const permissions = usePermissions();
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');
  const [commandOpen, setCommandOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [sidebarInitialTab, setSidebarInitialTab] = useState<'history' | 'saved'>('saved');
  // The sidebar panel is user-resizable; track its width so the content webview's right
  // inset matches it exactly (reported up from the Sidebar via onWidthChange).
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // When the user explicitly navigates from chrome (address bar, saved/history/favorites),
  // the page being left can still fire a resize/timer redirect before the new navigation
  // commits. Streamex-style pages do this during sidebar/sheet changes. Suppress only those
  // old-page redirect events briefly; redirects from the destination page still surface.
  const pendingChromeNavRef = useRef<{ fromOrigin: string | null; startedAt: number } | null>(null);
  const update = useUpdate();
  const safety = useSafety();
  const fingerprint = useFingerprint();
  const proxy = useProxy();
  const split = useSplit();
  const find = useFind(tabs.activeId);
  const navUrlRef = useRef(nav.state.url);
  navUrlRef.current = nav.state.url;

  // Ref to the `.app` container so useChromeHeights can query chrome elements by CSS class.
  const appRef = useRef<HTMLDivElement>(null);
  const chrome = useChromeHeights(appRef);

  const navigateFromChrome = (raw: string): void => {
    const fromOrigin = originOf(nav.state.url);
    pendingChromeNavRef.current = {
      fromOrigin,
      startedAt: Date.now(),
    };
    nav.navigate(raw);
    window.setTimeout(() => {
      if (fromOrigin !== null && originOf(navUrlRef.current) === fromOrigin) {
        nav.navigate(raw);
      }
    }, CHROME_NAV_REASSERT_MS);
  };

  const openSettings = (tab: SettingsTab = 'appearance'): void => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  };

  // Dev-only: expose an imperative control surface so the autopilot can reach every
  // overlay/state deterministically. Gated so it can NEVER run in a production build.
  useEffect(() => {
    if (!import.meta.env.DEV || !import.meta.env.VITE_AEGIS_AUTOPILOT) return;
    return installAutopilotControl({
      openSettings: () => setSettingsOpen(true),
      closeSettings: () => setSettingsOpen(false),
      openDownloads: () => setDownloadsOpen(true),
      closeDownloads: () => setDownloadsOpen(false),
      openManager: () => setManagerOpen(true),
      closeManager: () => setManagerOpen(false),
      setSidebar: (open) => setSidebarOpen(open),
      setShield: (open) => setShieldOpen(open),
      enterFullscreen: () => setFullscreen(true),
      exitFullscreen: () => setFullscreen(false),
      showError: (f) => {
        setCrashed(null);
        setFailed(f as NavFailed);
      },
      clearError: () => setFailed(null),
      showCrash: (c) => {
        setFailed(null);
        setCrashed(c as NavCrashed);
      },
      clearCrash: () => setCrashed(null),
      openConfirm: (message) => {
        void confirm(message);
      },
      openFind: () => find.show(),
      closeFind: () => find.close(),
      setDownloadEntries: (entries) => downloads._setDownloads(entries),
      setHistoryEntries: (entries) => history._setEntries(entries),
      setSavedItems: (items, tagUnion) => saved._setSavedItems(items, tagUnion),
      setSitePermissions: (perms) => permissions._setPermissions(perms),
      setAllowlistedHosts: (hosts) => adblock._setAllowlistedHosts(hosts),
      setVaultRecords: (records) => vault._setRecordsRef.current?.(records),
      setFingerprintState: (s) => fingerprint._setState(s),
    });
  }, []);

  // Report measured chrome inset to Rust so the content webview sits below it.
  // The find bar is the only dynamic chrome element — it appears/disappears after
  // mount, so useChromeHeights (one-shot) can't measure it. Add FIND_BAR_H when open.
  const contentTop = chrome.topInset + (find.open ? FIND_BAR_H : 0);
  useContentInset(tabs.activeId, contentTop);

  // Sync the content-top CSS variable so fixed-position chrome surfaces (sidebar, scrim)
  // track the dynamic inset without a hardcoded pixel constant.
  useEffect(() => {
    document.documentElement.style.setProperty('--aegis-content-top', `${contentTop}px`);
  }, [contentTop]);

  // Derived, never hand-maintained: any registered full-window surface means a full
  // overlay is up. New overlays self-register (see useChromeSurface) — there is no
  // central list to forget to update.
  const { openSurfaces } = useChromeSurfaceRegistry();
  // Effect-driven: the content layout is applied one render cycle after an overlay opens
  // (via the registry's useEffect in useChromeSurface) — observably equivalent to the
  // old synchronous union, as proven by the unchanged autopilot tour.
  const fullOverlayActive = openSurfaces.size > 0;
  useEffect(() => {
    // ONE atomic update from a single derived state. computeContentLayout is the sole
    // place the overlay/sidebar/shield → content-layout mapping lives (mirrored on the
    // Rust side by view::content_visible).
    void aegis.view.setLayout?.(
      tabs.activeId,
      computeContentLayout({
        fullOverlay: fullOverlayActive,
        sidebar: sidebarOpen,
        shield: shieldOpen,
        zoom: zoomOpen,
        sidebarWidth,
      }),
    );
  }, [tabs.activeId, fullOverlayActive, sidebarOpen, shieldOpen, zoomOpen, sidebarWidth]);

  // Fullscreen: main shrinks chrome to a top-right corner and fills the window
  // with content. Renderer reflects the toggle below (after all hooks).
  useEffect(() => {
    void aegis.view.setFullscreen(tabs.activeId, fullscreen);
  }, [tabs.activeId, fullscreen]);

  // In fullscreen the chrome shrinks to just the exit-button box; give the body a solid
  // background so that tiny webview actually paints — a transparent body can render
  // nothing (button present but invisible) with compositing disabled on some GPUs.
  useEffect(() => {
    document.body.classList.toggle('aegis-fullscreen', fullscreen);
    return () => document.body.classList.remove('aegis-fullscreen');
  }, [fullscreen]);

  // The backend may exit fullscreen itself (Tauri: Esc in the content webview,
  // which covers the chrome's exit button); sync the React state when it does.
  useEffect(() => {
    return aegis.view.onFullscreen?.((s) => setFullscreen(s.on));
  }, []);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  // Native-captured tab keyboard shortcuts (Ctrl+T/W/Tab etc.) arrive via the
  // tabs.shortcut event and are mapped to tab actions here in the chrome.
  useEffect(() => {
    return aegis.tabs.onShortcut((s) => {
      if (s === 'new') void tabs.create();
      else if (s === 'close') void tabs.close(activeIdRef.current);
      else if (s === 'reopen') void tabs.reopenClosed();
      else if (s === 'next' || s === 'prev') {
        const ids = tabsRef.current.map((t) => t.id);
        const i = ids.indexOf(activeIdRef.current);
        if (ids.length > 0) {
          const ni = s === 'next' ? (i + 1) % ids.length : (i - 1 + ids.length) % ids.length;
          void tabs.activate(ids[ni]);
        }
      } else if (s.startsWith('jump')) {
        const ids = tabsRef.current.map((t) => t.id);
        if (ids.length === 0) return;
        const target = s === 'jumpLast' ? ids[ids.length - 1] : ids[Number(s.slice(4)) - 1];
        if (target !== undefined) void tabs.activate(target);
      }
    });
  }, []);

  // Ctrl+Shift+N — open a new private tab (incognito).
  // Collision check: the Ctrl+digit handler below guards !e.shiftKey; the Windows handler
  // checks Ctrl+Shift+Tab (key === 'Tab') and Ctrl+Shift+T — 'n' is not handled there.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || !e.shiftKey) return;
      if (e.key.toLowerCase() === 'n') {
        e.preventDefault();
        void tabs.create(undefined, false, true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs.create]);

  // Ctrl+Shift+S — toggle split view. If not in split, split the active tab with
  // the next tab in the list. If already in split, exit split.
  // Collision check: Ctrl+Shift+N is handled above; Ctrl+Shift+Tab/T are Windows-only
  // and use key === 'Tab'/'t'. 's' is not handled by any other effect.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || !e.shiftKey) return;
      if (e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (split.layout) {
          void split.exitSplit();
        } else {
          const ids = tabsRef.current.map((t) => t.id);
          const i = ids.indexOf(activeIdRef.current);
          if (ids.length >= 2) {
            const nextIdx = (i + 1) % ids.length;
            void split.enterSplit([activeIdRef.current, ids[nextIdx]]);
          }
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [split.layout, split.enterSplit, split.exitSplit]);

  // Ctrl+1-9 when the chrome/address bar is focused (and as the Win/macOS path,
  // where content-webview digit keys aren't captured by a menu accelerator).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const ids = tabsRef.current.map((t) => t.id);
        if (ids.length === 0) return;
        const target = e.key === '9' ? ids[ids.length - 1] : ids[Number(e.key) - 1];
        if (target !== undefined) void tabs.activate(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Windows: the native "Tabs" menu (which carried Ctrl+T/W/Shift+T/Ctrl+Tab) is hidden,
  // so handle those tab shortcuts here when the chrome has focus. No-op on macOS, where the
  // menu fires them natively (see `isWindows`), to avoid double-firing.
  useEffect(() => {
    if (!isWindows) return;
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === 'Tab') {
        e.preventDefault();
        const ids = tabsRef.current.map((t) => t.id);
        if (ids.length === 0) return;
        const i = ids.indexOf(activeIdRef.current);
        const ni = e.shiftKey ? (i - 1 + ids.length) % ids.length : (i + 1) % ids.length;
        void tabs.activate(ids[ni]);
        return;
      }
      const k = e.key.toLowerCase();
      if (k === 't' && e.shiftKey) {
        e.preventDefault();
        void tabs.reopenClosed();
      } else if (k === 't') {
        e.preventDefault();
        void tabs.create();
      } else if (k === 'w') {
        e.preventDefault();
        void tabs.close(activeIdRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setCommandOpen(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Ctrl+F / Cmd+F opens the find bar (auto-focuses the input via FindBar's useEffect).
  // Esc closes it from within the FindBar input (handleKeyDown → onClose).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        find.show();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [find.show]);

  // Ctrl+= / Ctrl++ / Ctrl+- / Ctrl+0 — page zoom.
  // Collision check: the Ctrl+1–9 handler above guards `e.key >= '1' && e.key <= '9'`, so
  // '0' is NOT handled there — Ctrl+0 is free. '+'/'-'/'=' are also untouched by every
  // existing handler (Tab/T/W/F/digits are the only ones). NumpadAdd/NumpadSubtract/Numpad0
  // are accepted for full-keyboard coverage. No Shift guard needed: '+' on most layouts IS
  // Shift+=, but `e.key` gives '+' directly so we don't need to inspect Shift.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey) return;
      if (e.key === '+' || e.key === '=' || e.code === 'NumpadAdd') {
        e.preventDefault();
        zoom.zoomIn();
      } else if (e.key === '-' || e.code === 'NumpadSubtract') {
        e.preventDefault();
        zoom.zoomOut();
      } else if (e.key === '0' || e.code === 'Numpad0') {
        e.preventDefault();
        zoom.reset();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [zoom.zoomIn, zoom.zoomOut, zoom.reset]);

  // Ctrl-wheel over the chrome zooms in/out. Must be a non-passive listener to allow
  // preventDefault (React's synthetic onWheel is always passive in React 17+).
  //
  // LIMITATION: the content webview is a separate native webview; wheel events over the
  // page go directly to that webview and never reach this chrome-level handler. So
  // Ctrl-wheel zoom only works reliably when the pointer is over chrome (toolbar, bars,
  // etc.). The keyboard shortcuts (Ctrl+=/−/0) are the guaranteed cross-platform path.
  // On Linux/Windows/macOS the content webview's own Ctrl-wheel may apply native engine
  // zoom independently — do not rely on that; it is not wired through useZoom.
  useEffect(() => {
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      if (e.deltaY < 0) zoom.zoomIn();
      else if (e.deltaY > 0) zoom.zoomOut();
    };
    window.addEventListener('wheel', onWheel, { passive: false });
    return () => window.removeEventListener('wheel', onWheel);
  }, [zoom.zoomIn, zoom.zoomOut]);

  useEffect(() => {
    const offFailed = aegis.nav.onFailed((f) => {
      if (f.viewId !== tabs.activeId) return;
      setCrashed(null);
      setFailed(f);
    });
    const offCrashed = aegis.nav.onCrashed((c) => {
      if (c.viewId !== tabs.activeId) return;
      setFailed(null);
      setCrashed(c);
    });
    return () => {
      offFailed();
      offCrashed();
    };
  }, [tabs.activeId]);

  // A scripted cross-origin top-frame redirect was cancelled by the native guard;
  // automatically open the destination in a new background tab. The grace period
  // suppresses spurious bg tabs from old-page timer redirects during chrome-initiated
  // navigations.
  useEffect(() => {
    return aegis.redirect.onBlocked((r) => {
      if (r.viewId !== tabs.activeId) return;
      const pending = pendingChromeNavRef.current;
      if (pending) {
        const fresh = Date.now() - pending.startedAt <= CHROME_NAV_REDIRECT_GRACE_MS;
        const fromOldPage = pending.fromOrigin !== null && originOf(r.from) === pending.fromOrigin;
        if (fresh && fromOldPage) return;
        if (!fresh) pendingChromeNavRef.current = null;
      }
      void tabs.create(r.to, true);
    });
  }, [tabs.activeId]);

  // Main owns content hide/show for failures and crashes. When a fresh
  // navigation reports loading state, clear any error/crash overlay. We do NOT
  // call aegis.view.setContentVisible here — main re-shows the content view.
  useEffect(() => {
    if (nav.state.isLoading && !nav.state.crashed) {
      setFailed(null);
      setCrashed(null);
    }
  }, [nav.state.isLoading, nav.state.crashed]);

  const handleRetry = (): void => {
    void aegis.nav.reloadOrStop(tabs.activeId);
  };

  const handleHome = (): void => {
    nav.home();
  };

  const activeDownloads = downloads.downloads.filter((d) => d.state === 'progressing').length;
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const activeHost = hostOf(nav.state.url);
  const activeOrigin = originOf(nav.state.url);
  const activeProtection = protectionSummary({
    activeTab,
    settings: settings.settings,
    fingerprint: fingerprint.state,
    proxy: proxy.state,
    host: activeHost,
  });
  useDownloadToasts(downloads.downloads, {
    openFile: downloads.openFile,
    showInFolder: downloads.showInFolder,
  });

  const forgetSitePermissions = (origin: string): void => {
    for (const permission of permissions.permissions.filter((p) => p.origin === origin)) {
      void permissions.remove(permission.origin, permission.permission);
    }
  };

  const clearRememberedSiteData = (origin: string): void => {
    forgetSitePermissions(origin);
    for (const entry of history.entries.filter((entry) => originOf(entry.url) === origin)) {
      void history.remove(entry.id);
    }
    toast.info('Cleared Aegis history and remembered permissions for this site.');
  };

  // Split-view resize handles: compute pixel rects from the fractional layout
  // and expose drag handlers that convert pixel deltas into fractional IPC calls.
  const splitPaneRects = useMemo<PaneRect[]>(() => {
    if (!split.layout) return [];
    // Content area starts below the chrome and fills the remaining width.
    // Use measured chrome heights (from useChromeHeights) instead of constants.
    const contentArea = {
      x: 0,
      y: chrome.topInset,
      width: window.innerWidth || 1200,
      height: Math.max(1, (window.innerHeight || 800) - chrome.topInset),
    };
    return computeSplitLayout(split.layout, contentArea).panes;
  }, [split.layout, chrome.topInset]);

  const splitHandles = useMemo(() => {
    if (!split.layout) return [];
    const contentArea = {
      x: 0,
      y: chrome.topInset,
      width: window.innerWidth || 1200,
      height: Math.max(1, (window.innerHeight || 800) - chrome.topInset),
    };
    return computeSplitLayout(split.layout, contentArea).handles;
  }, [split.layout, chrome.topInset]);

  const handleSplitDrag = useCallback(
    (
      handleOrientation: 'vertical' | 'horizontal',
      leftPaneId: number,
      rightPaneId: number,
      delta: number,
    ) => {
      if (!split.layout) return;
      const contentSize = handleOrientation === 'vertical' ? window.innerWidth : window.innerHeight;
      const leftPane = split.layout.panes.find((p) => p.tabId === leftPaneId);
      const rightPane = split.layout.panes.find((p) => p.tabId === rightPaneId);
      if (!leftPane || !rightPane) return;

      const fractionDelta = delta / contentSize;
      const clamped = clampResizeDelta(
        fractionDelta,
        handleOrientation,
        splitPaneRects,
        leftPaneId,
        rightPaneId,
        contentSize,
      );
      if (clamped === 0) return;

      const newLeftWidth =
        handleOrientation === 'vertical'
          ? Math.max(0.05, Math.min(0.95, leftPane.width + clamped))
          : leftPane.width;
      const newRightWidth =
        handleOrientation === 'vertical'
          ? Math.max(0.05, Math.min(0.95, rightPane.width - clamped))
          : rightPane.width;
      const newLeftHeight =
        handleOrientation === 'horizontal'
          ? Math.max(0.05, Math.min(1.0, leftPane.height + clamped))
          : leftPane.height;
      const newRightHeight =
        handleOrientation === 'horizontal'
          ? Math.max(0.05, Math.min(1.0, rightPane.height - clamped))
          : rightPane.height;

      void split.resizePane(leftPaneId, newLeftWidth, newLeftHeight);
      void split.resizePane(rightPaneId, newRightWidth, newRightHeight);
    },
    [split.layout, split.resizePane, splitPaneRects],
  );

  const handleSplitDragEnd = useCallback(() => {
    // No-op for now; layout is already applied via resizePane calls.
  }, []);

  // Fullscreen render: ALL hooks above must run on every render (rule of hooks).
  // In fullscreen the chrome is shrunk to a top-right corner by main; render only
  // the exit affordance there. The component stays mounted, so state persists.
  if (fullscreen) {
    return (
      <button
        type="button"
        className="fullscreen-exit"
        aria-label="Exit fullscreen"
        title="Exit fullscreen"
        onClick={() => setFullscreen(false)}
      >
        <Minimize2 size={18} aria-hidden="true" />
      </button>
    );
  }

  return (
    <div ref={appRef} className={`app${activeProtection.privateMode ? ' app--private' : ''}`}>
      <SkipLink targetId={CONTENT_ANCHOR_ID} />
      <WorkspaceSwitcher
        workspaces={workspaces.workspaces}
        activeWorkspaceId={workspaces.activeWorkspaceId}
        onSwitch={(id) => void workspaces.switch(id)}
        onCreate={(name, color) => void workspaces.create(name, color)}
        onRename={(id, name) => void workspaces.rename(id, name)}
        onSetColor={(id, color) => void workspaces.setColor(id, color)}
        onRemove={(id) => void workspaces.remove(id)}
        onReorder={(ids) => void workspaces.reorder(ids)}
      />
      <TabStrip
        tabs={tabs.tabs}
        activeId={tabs.activeId}
        onActivate={(id) => void tabs.activate(id)}
        onClose={(id) => void tabs.close(id)}
        onCreate={() => void tabs.create()}
        onCreatePrivate={() => void tabs.create(undefined, false, true)}
        onReorder={(ids) => void tabs.reorder(ids)}
        onSetPinned={(id, pinned) => void tabs.setPinned(id, pinned)}
        splitLayout={split.layout}
        onEnterSplit={(ids) => void split.enterSplit(ids)}
      />
      <Toolbar
        state={nav.state}
        navigate={navigateFromChrome}
        back={nav.back}
        forward={nav.forward}
        reloadOrStop={nav.reloadOrStop}
        home={nav.home}
        isNarrow={isNarrow}
        adblock={{
          state: adblock.state,
          page: adblock.page,
          host: activeHost,
          setEnabled: adblock.setEnabled,
          toggleAllowlist: adblock.toggleAllowlist,
          onOpenChange: setShieldOpen,
          onReload: nav.reloadOrStop,
          protection: activeProtection,
        }}
        isPrivate={activeProtection.privateMode}
        siteInfo={{
          origin: activeOrigin,
          host: activeHost,
          permissions: permissions.permissions,
          protection: activeProtection,
          onForgetSitePermissions: forgetSitePermissions,
          onClearRememberedSiteData: clearRememberedSiteData,
          onOpenPrivacySettings: () => openSettings('security'),
        }}
        bookmark={
          <BookmarkButton
            saved={saved.isCurrentSaved}
            canSave={activeHost !== null}
            onSave={() => void saved.addCurrent(nav.state.title)}
            onUnsave={() => void saved.removeCurrent()}
          />
        }
        downloads={
          <>
            <UpdateIndicator
              state={update.state}
              onRestart={() => void update.restartToInstall()}
            />
            <PickerButton />
            <DownloadsIndicator
              activeCount={activeDownloads}
              onOpen={() => setDownloadsOpen(true)}
            />
          </>
        }
        gear={
          <button
            type="button"
            className="toolbar__gear"
            aria-label="Open settings"
            title="Settings"
            onClick={() => openSettings()}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
        }
        zoom={
          <ZoomIndicator
            factor={zoom.factor}
            zoomIn={zoom.zoomIn}
            zoomOut={zoom.zoomOut}
            reset={zoom.reset}
            onOpenChange={setZoomOpen}
          />
        }
        splitIndicator={
          split.layout ? (
            <SplitIndicator layout={split.layout} onExit={() => void split.exitSplit()} />
          ) : undefined
        }
        fullscreen={
          <button
            type="button"
            className="toolbar__fullscreen"
            aria-label="Enter fullscreen"
            title="Fullscreen"
            onClick={() => setFullscreen(true)}
          >
            <Maximize2 size={18} aria-hidden="true" />
          </button>
        }
        menu={
          <button
            type="button"
            className="toolbar__sidebar-toggle"
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            aria-expanded={sidebarOpen}
            onClick={() => setSidebarOpen((v) => !v)}
          >
            <PanelRight size={18} aria-hidden="true" />
          </button>
        }
      />
      <FavoritesBar
        favorites={favorites.favorites}
        onOpenFavorite={(url) => navigateFromChrome(url)}
        onOpenManager={() => setManagerOpen(true)}
      />
      {find.open && (
        <FindBar
          state={find.state}
          onQueryChange={find.setQuery}
          onNext={find.next}
          onPrev={find.prev}
          onClose={find.close}
        />
      )}
      <Sidebar
        open={sidebarOpen}
        initialTab={sidebarInitialTab}
        onClose={() => setSidebarOpen(false)}
        onWidthChange={setSidebarWidth}
        history={
          <HistoryPanel
            entries={history.entries}
            query={history.query}
            setQuery={history.setQuery}
            search={history.search}
            remove={history.remove}
            clear={history.clear}
            onOpen={(url) => {
              navigateFromChrome(url);
              setSidebarOpen(false);
            }}
          />
        }
        saved={
          <SavedPanel
            items={saved.items}
            tagUnion={saved.tagUnion}
            activeTags={saved.activeTags}
            setActiveTags={saved.setActiveTags}
            add={(input) => void saved.add(input)}
            remove={(id) => void saved.remove(id)}
            update={(id, partial) => void saved.update(id, partial)}
            renameTag={(oldT, newT) => void saved.renameTag(oldT, newT)}
            deleteTag={(tag) => void saved.deleteTag(tag)}
            onOpen={(url) => {
              navigateFromChrome(url);
              setSidebarOpen(false);
            }}
          />
        }
      />
      <div id={CONTENT_ANCHOR_ID} className="content-anchor" tabIndex={-1} />
      <ErrorOverlay failed={failed} crashed={crashed} onRetry={handleRetry} onHome={handleHome} />
      <SafetyInterstitial
        interstitial={safety.interstitial}
        onProceed={(u) => void safety.proceed(u)}
        onBack={() => nav.back()}
      />
      {downloadsOpen && (
        <DownloadsModal
          onClose={() => setDownloadsOpen(false)}
          downloads={downloads.downloads}
          remove={(id) => void downloads.remove(id)}
          clear={() => void downloads.clear()}
          openFile={(id) => void downloads.openFile(id)}
          showInFolder={(id) => void downloads.showInFolder(id)}
          cancel={(id) => void downloads.cancel(id)}
        />
      )}
      {managerOpen && (
        <FavoritesManager
          favorites={favorites.favorites}
          onClose={() => setManagerOpen(false)}
          add={favorites.add}
          update={favorites.update}
          remove={favorites.remove}
        />
      )}
      {settingsOpen && (
        <SettingsModal
          onClose={() => setSettingsOpen(false)}
          initialTab={settingsInitialTab}
          quickActions={
            <>
              <button type="button" onClick={() => void tabs.create(undefined, false, true)}>
                New private tab
              </button>
              <button type="button" onClick={() => void permissions.clear()}>
                Clear permissions
              </button>
              <button type="button" onClick={() => void subscriptions.updateNow()}>
                Update filter lists
              </button>
              <button type="button" onClick={() => setDownloadsOpen(true)}>
                Downloads
              </button>
            </>
          }
          appearance={<AppearanceTab settings={settings.settings} update={settings.update} />}
          search={<SearchTab settings={settings.settings} update={settings.update} />}
          home={<HomeTab settings={settings.settings} update={settings.update} />}
          tabs={<TabsTab settings={settings.settings} update={settings.update} />}
          filterLists={{
            subs: subscriptions.subs,
            setEnabled: subscriptions.setEnabled,
            add: subscriptions.add,
            remove: subscriptions.remove,
            updateNow: subscriptions.updateNow,
          }}
          myFilters={{ text: customFilters.text, save: customFilters.save }}
          allowlist={
            <AllowlistTab
              hosts={adblock.state.allowlistedHosts}
              removeAllowlist={adblock.removeAllowlist}
              clearAllowlist={adblock.clearAllowlist}
            />
          }
          downloads={<DownloadsTab settings={settings.settings} update={settings.update} />}
          sitePermissions={
            <SitePermissionsTab
              permissions={permissions.permissions}
              remove={permissions.remove}
              clear={permissions.clear}
            />
          }
          security={{
            protection: activeProtection,
            adblockState: adblock.state,
            blockedHere: adblock.page,
            onHarden: () =>
              void settings.update({
                httpsOnly: true,
                webrtcPolicy: 'disable',
                antiFingerprint: 'strict',
              }),
            onOpenProxy: () => openSettings('proxy'),
            settings: settings.settings,
            update: settings.update,
            listExceptions: aegis.safety.listExceptions,
            removeException: (h: string) => void aegis.safety.removeException(h),
            fingerprintState: fingerprint.state,
            toggleFingerprintAllowlist: fingerprint.toggleAllowlist,
            removeFingerprintAllowlist: fingerprint.removeAllowlist,
          }}
          proxy={{
            state: proxy.state,
            setConfig: proxy.setConfig,
            test: proxy.test,
            onReloadActiveTab: nav.reloadOrStop,
          }}
          vault={vault}
          sync={{
            sync,
            onSetServerUrl: (url: string) => settings.update({ syncServerUrl: url }),
          }}
          data={
            <DataTab
              onExport={() => aegis.data.export()}
              onImport={(mode, source) => aegis.data.import(mode, source)}
            />
          }
        />
      )}
      {permissions.prompt && (
        <PermissionPromptDialog
          prompt={permissions.prompt}
          isPrivate={activeProtection.privateMode}
          onOpenSitePermissions={() => openSettings('sitePermissions')}
          onResolve={(_requestId, decision) => void permissions.resolve(decision)}
        />
      )}
      <Onboarding
        searchEngines={settings.settings.searchEngines}
        defaultSearchTemplate={settings.settings.defaultSearchTemplate}
        onChooseSearch={(template) => void settings.update({ defaultSearchTemplate: template })}
        onChoosePrivacyPreset={(preset) =>
          void settings.update(
            preset === 'strict'
              ? { httpsOnly: true, webrtcPolicy: 'disable', antiFingerprint: 'strict' }
              : { httpsOnly: true, webrtcPolicy: 'public-only', antiFingerprint: 'standard' },
          )
        }
        onOpenSettings={() => openSettings()}
        onImportData={() => openSettings('data')}
      />
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <Toaster />
      <ConfirmDialog />
      {splitHandles.length > 0 && (
        <div className="split-handles-overlay">
          {splitHandles.map((h) => (
            <SplitResizeHandle
              key={`${h.leftPaneId}-${h.rightPaneId}`}
              orientation={h.orientation}
              x={h.x}
              y={h.y}
              width={h.width}
              height={h.height}
              onDrag={(delta) => handleSplitDrag(h.orientation, h.leftPaneId, h.rightPaneId, delta)}
              onDragEnd={handleSplitDragEnd}
            />
          ))}
        </div>
      )}
    </div>
  );
}

export function App() {
  if (getIsMobile()) return <MobileApp />;
  return (
    <ChromeSurfaceProvider>
      <DesktopApp />
    </ChromeSurfaceProvider>
  );
}
