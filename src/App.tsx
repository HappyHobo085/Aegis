// src/App.tsx
import { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import { Settings, PanelRight, Maximize2, Minimize2 } from 'lucide-react';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { confirm, toast } from './lib/toast';
import { saveErrorText } from './lib/saveError';
import { useChromeHeights } from './hooks/useChromeHeights';
import { hostOf, originOf } from './lib/url';
import { ChromeSurfaceProvider, useChromeSurfaceRegistry } from './hooks/useChromeSurfaces';
import { ChromePopoverProvider, useChromePopoverRegistry } from './hooks/useChromePopover';
import { computeContentLayout } from './lib/contentLayout';
import { protectionSummary } from './lib/protectionSummary';
import { useDownloadToasts } from './hooks/useDownloadToasts';
import { useNav } from './hooks/useNav';
import { useTabTitleSync } from './hooks/useTabTitleSync';
import { useFind } from './hooks/useFind';
import { useZoom } from './hooks/useZoom';
import { useAdblock } from './hooks/useAdblock';
import { useFingerprint } from './hooks/useFingerprint';
import { useWebrtcExempt } from './hooks/useWebrtcExempt';
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
import { useNarrowViewport } from './hooks/useNarrowViewport';
import { useUpdate } from './hooks/useUpdate';
import { useSafety } from './hooks/useSafety';
import { useTabs } from './hooks/useTabs';
import { useWorkspaces } from './hooks/useWorkspaces';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { DownloadsIndicator } from './components/DownloadsIndicator';
import { PickerButton } from './components/PickerButton';
import { UpdateIndicator } from './components/UpdateIndicator';
import { ZoomIndicator } from './components/ZoomIndicator';
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
const CHROME_NAV_REASSERT_MS = 250;

function DesktopApp() {
  // One-time performance measurement: marks when React mount completes. The mark and
  // measure are kept deliberately — a named entry in the browser's own performance
  // timeline is real instrumentation an engineer can read in devtools, and it costs
  // nothing. The `console.log` that consumed it did not: it printed to the console on
  // every launch of a shipped build, which is debug output in production.
  useEffect(() => {
    try {
      performance.mark('aegis-react-end');
      performance.measure('aegis-mount', 'aegis-react-start', 'aegis-react-end');
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
  // A page that renames itself after load (SPA route, unread count) updates its tab's
  // title. See the hook for why this is separate from useNav.
  useTabTitleSync();
  const isNarrow = useNarrowViewport();
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  const zoom = useZoom(tabs.activeId);
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
  // The favorites bar is always-on chrome today; this state exists so the command
  // palette's "Toggle favorites bar" has something to flip. `useChromeHeights`
  // re-measures when the bar's presence changes, so `topInset` stays correct either way.
  const [favBarOpen, setFavBarOpen] = useState(true);
  const [sidebarInitialTab, setSidebarInitialTab] = useState<'history' | 'saved'>('saved');
  // The sidebar panel is user-resizable; track its width so the content webview's right
  // inset matches it exactly (reported up from the Sidebar via onWidthChange).
  const [sidebarWidth, setSidebarWidth] = useState(320);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  // Monotonic counter for chrome-initiated navigations, so a re-assert timer can tell whether
  // it is still the newest one. See `navigateFromChrome`.
  const chromeNavSeqRef = useRef(0);
  const update = useUpdate();
  const safety = useSafety();
  const fingerprint = useFingerprint();
  // WebRTC exemptions live in their OWN never-synced store (7(2)), so this is a separate hook
  // from useFingerprint rather than a second slice of the ad-block allowlist.
  const webrtcExempt = useWebrtcExempt();
  const proxy = useProxy();
  const find = useFind(tabs.activeId);
  const navUrlRef = useRef(nav.state.url);
  navUrlRef.current = nav.state.url;

  // Ref to the `.app` container so useChromeHeights can query chrome elements by CSS class.
  const appRef = useRef<HTMLDivElement>(null);
  const chrome = useChromeHeights(appRef);

  const navigateFromChrome = (raw: string): void => {
    const fromOrigin = originOf(nav.state.url);
    // BUG(F7): the guard below only checked that the ORIGIN was unchanged, never that this
    // was still the newest pending navigation. Click favourite example.com/a and then navigate
    // to example.com/b within 250 ms and the first timer saw an unchanged origin and
    // re-navigated to /a, undoing the newer navigation. Each nav takes a ticket; a timer whose
    // ticket has been superseded does nothing.
    const ticket = ++chromeNavSeqRef.current;
    nav.navigate(raw);
    window.setTimeout(() => {
      if (ticket !== chromeNavSeqRef.current) return;
      if (fromOrigin !== null && originOf(navUrlRef.current) === fromOrigin) {
        nav.navigate(raw);
      }
    }, CHROME_NAV_REASSERT_MS);
  };

  // `useCallback` is load-bearing, not decoration: this is the SOLE dep of the effect
  // below that registers the four `aegis:*` shell CustomEvents. As a plain function it
  // was a new identity on every render, so that effect tore down and re-registered all
  // four listeners every render — and App re-renders on every nav state, tab state, zoom,
  // adblock count and settings change. Both setters are stable, so `[]` is the real dep
  // list and the effect now mounts exactly once.
  const openSettings = useCallback((tab: SettingsTab = 'appearance'): void => {
    setSettingsInitialTab(tab);
    setSettingsOpen(true);
  }, []);

  // Command-palette actions that have no direct React owner.
  //
  // `commandPaletteData.ts` is deliberately PURE (it builds a static list of results
  // and cannot import App), so a window CustomEvent is the honest seam between it and
  // the shell. The bug this fixes is that nothing ever LISTENED: `aegis:toggleSidebar`,
  // `aegis:toggleFavoritesBar` and `aegis:openSettings` were dispatched and dropped on
  // the floor, which silently no-op'd both toggles and ALL FIFTEEN "open settings…"
  // palette entries. Registering the listeners here is what makes them work.
  useEffect(() => {
    const onToggleSidebar = () => setSidebarOpen((v) => !v);
    const onToggleFavoritesBar = () => setFavBarOpen((v) => !v);
    // BUG(F27): `setSidebarInitialTab` had ZERO call sites, so the sidebar could only ever
    // open on "Saved" — there was no way to reach History from it at all, and the state was
    // invisible to `no-unused-vars`. The palette's "Open history" / "Open saved pages"
    // actions dispatch this, which is what makes the state reachable.
    const onOpenSidebar = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: 'history' | 'saved' }>).detail?.tab;
      if (tab !== 'history' && tab !== 'saved') return;
      setSidebarInitialTab(tab);
      setSidebarOpen(true);
    };
    const onOpenSettings = (e: Event) => {
      const tab = (e as CustomEvent<{ tab?: SettingsTab }>).detail?.tab;
      // `openSettings` is the one place that sets both the initial tab and the open
      // flag, so routing through it keeps "open settings" from every other surface
      // (gear icon, settings rows, sidebar) behaving identically.
      openSettings(tab ?? 'appearance');
    };
    window.addEventListener('aegis:toggleSidebar', onToggleSidebar);
    window.addEventListener('aegis:toggleFavoritesBar', onToggleFavoritesBar);
    window.addEventListener('aegis:openSidebar', onOpenSidebar);
    window.addEventListener('aegis:openSettings', onOpenSettings);
    return () => {
      window.removeEventListener('aegis:toggleSidebar', onToggleSidebar);
      window.removeEventListener('aegis:toggleFavoritesBar', onToggleFavoritesBar);
      window.removeEventListener('aegis:openSidebar', onOpenSidebar);
      window.removeEventListener('aegis:openSettings', onOpenSettings);
    };
  }, [openSettings]);

  // The tallest open chrome popover (omnibox / site info / shield / zoom). Each
  // registers its own measured height; the compositor turns the tallest into the
  // extra content-top inset below.
  const { inset: popoverInset } = useChromePopoverRegistry();

  // Report measured chrome inset to Rust so the content webview sits below it.
  // The FindBar is the one dynamic chrome ELEMENT — it appears/disappears after
  // mount — but `useChromeHeights` now re-measures whenever a chrome element's
  // PRESENCE changes, so `.find-bar` is already in `chrome.topInset`. Adding
  // FIND_BAR_H here as well used to be the only way to make it work (the hook
  // measured exactly once), and would now double-count it to 80px.
  // Chrome popovers (omnibox, site info, shield, zoom) are different: they hang
  // BELOW the chrome and are taller than nothing, so each registers its own
  // measured height and the tallest one is added here. That insets the opaque
  // content webview just far enough to reveal the popover while the page stays
  // visible behind it — see useChromePopover.
  const contentTop = chrome.topInset + popoverInset;
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
        sidebarWidth,
      }),
    );
  }, [tabs.activeId, fullOverlayActive, sidebarOpen, sidebarWidth]);

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
    webrtc: webrtcExempt.state,
    proxy: proxy.state,
    host: activeHost,
  });
  useDownloadToasts(downloads.downloads, {
    openFile: downloads.openFile,
    showInFolder: downloads.showInFolder,
  });

  // Resolves `true` when every revoke landed, `false` when at least one was refused.
  //
  // The refusal is REPORTED HERE rather than left to the caller, because `AddressBar`'s prop
  // type is `onForgetSitePermissions(origin): void` and its click handler discards the return
  // value — a rejection handed back to it would be a silent unhandled rejection. So the
  // handler swallows it, toasts the reason, and returns the boolean the OTHER caller needs
  // to know not to print its success wording. Same reason the mobile shell shapes its copy of
  // this the same way (it has the identical `void` prop).
  const forgetSitePermissions = (origin: string): Promise<boolean> =>
    Promise.all(
      permissions.permissions
        .filter((p) => p.origin === origin)
        .map((permission) => permissions.remove(permission.origin, permission.permission)),
    ).then(
      () => true,
      (e: unknown) => {
        toast.error(saveErrorText(e));
        return false;
      },
    );

  const clearRememberedSiteData = (origin: string): void => {
    // Core-side, over the WHOLE store: `history.entries` is only the last `list()` page
    // (200 of up to 5000 rows), so looping over it claimed to clear a site while most of
    // its history stayed on disk — and `history.search` filters the full snapshot, so the
    // user could search the "erased" rows straight back up.
    void history.removeForOrigin(origin);
    // `permissions.remove` REFUSES a revoke whose save did not land, and this handler used
    // to fire-and-forget it, so the toast below claimed the permissions were cleared while
    // the core had reported that it could not. `forgetSitePermissions` reports the refusal
    // itself and answers `false`, so the success wording is printed ONLY when nothing was
    // refused — one refusal must not be papered over by the other revoke having landed.
    void forgetSitePermissions(origin).then((allLanded) => {
      if (allLanded) {
        toast.info('Cleared Aegis history and remembered permissions for this site.');
      }
    });
  };

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
          onReload: nav.reloadOrStop,
          protection: activeProtection,
        }}
        isPrivate={activeProtection.privateMode}
        omnibox={{
          favorites: favorites.favorites,
          saved: saved.items,
          searchTemplate: nav.searchTemplate,
        }}
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
          />
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
      {favBarOpen && (
        <FavoritesBar
          favorites={favorites.favorites}
          onOpenFavorite={(url) => navigateFromChrome(url)}
          onOpenManager={() => setManagerOpen(true)}
        />
      )}
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
              <button
                type="button"
                onClick={() => {
                  void permissions.clear().catch((e: unknown) => toast.error(saveErrorText(e)));
                }}
              >
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
            webrtcExempt: webrtcExempt.state,
            toggleWebrtcExempt: webrtcExempt.toggleExempt,
            removeWebrtcExempt: webrtcExempt.removeExempt,
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
            settings: settings.settings,
            update: settings.update,
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
      <CommandPalette
        open={commandOpen}
        viewId={tabs.activeId}
        onClose={() => setCommandOpen(false)}
      />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}

export function App() {
  if (getIsMobile()) return <MobileApp />;
  return (
    <ChromeSurfaceProvider>
      <ChromePopoverProvider>
        <DesktopApp />
      </ChromePopoverProvider>
    </ChromeSurfaceProvider>
  );
}
