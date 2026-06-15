// src/App.tsx
import { useEffect, useState } from 'react';
import { Settings, PanelRight, Maximize2, Minimize2 } from 'lucide-react';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
import { subscribeConfirmOpen } from './lib/toast';
import { useNav } from './hooks/useNav';
import { useAdblock } from './hooks/useAdblock';
import { useFavorites } from './hooks/useFavorites';
import { useHistory } from './hooks/useHistory';
import { useSaved } from './hooks/useSaved';
import { useSettings } from './hooks/useSettings';
import { useSubscriptions } from './hooks/useSubscriptions';
import { useCustomFilters } from './hooks/useCustomFilters';
import { useDownloads } from './hooks/useDownloads';
import { usePermissions } from './hooks/usePermissions';
import { useContentInset } from './hooks/useContentInset';
import { useUpdate } from './hooks/useUpdate';
import { useSafety } from './hooks/useSafety';
import { useTabs } from './hooks/useTabs';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { DownloadsIndicator } from './components/DownloadsIndicator';
import { PickerButton } from './components/PickerButton';
import { UpdateIndicator } from './components/UpdateIndicator';
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
import { WelcomeHint } from './components/WelcomeHint';
import { SettingsModal } from './components/SettingsModal';
import { AppearanceTab } from './components/AppearanceTab';
import { SearchTab } from './components/SearchTab';
import { HomeTab } from './components/HomeTab';
import { FilterListsTab } from './components/FilterListsTab';
import { MyFiltersTab } from './components/MyFiltersTab';
import { AllowlistTab } from './components/AllowlistTab';
import { DownloadsTab } from './components/DownloadsTab';
import { SitePermissionsTab } from './components/SitePermissionsTab';
import { SecurityTab } from './components/SecurityTab';
import { DataTab } from './components/DataTab';
import { TabStrip } from './components/TabStrip';

const isMobile =
  typeof document !== 'undefined' &&
  document.documentElement.classList.contains('aegis-mobile');

const CONTENT_ANCHOR_ID = 'content-anchor';

/** Returns the hostname of `url`, or null when `url` has no parseable host. */
function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function App() {
  const tabs = useTabs();
  const nav = useNav(tabs.activeId);
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  // The ad-block shield popover is a chrome dropdown; track it so the content webview
  // is lowered while it's open (Tauri's content view is opaque and on top).
  const [shieldOpen, setShieldOpen] = useState(false);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const settings = useSettings();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const downloads = useDownloads();
  const permissions = usePermissions();
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // The sidebar panel is user-resizable; track its width so the content webview's right
  // inset matches it exactly (reported up from the Sidebar via onWidthChange).
  const [sidebarWidth, setSidebarWidth] = useState(280);
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const update = useUpdate();
  const safety = useSafety();

  // A confirm dialog (e.g. "Clear all history") is a full-window overlay; track it
  // so the content webview hides behind it (else it renders behind the page).
  useEffect(() => subscribeConfirmOpen(setConfirmOpen), []);

  // Favorites bar is always-on (constant top inset); tab strip adds to the inset on desktop.
  useContentInset(tabs.activeId, !isMobile);

  // Full-window chrome overlays (settings, favorites manager, permission prompt,
  // error/crash, downloads, safety) must bring the chrome over the content. The
  // sidebar is a partial right panel handled separately (setSidebar) so the page
  // stays visible beside it; on Electron the sidebar still rides the chrome overlay
  // (the union below preserves the original setChromeOverlay calls), and setSidebar
  // is a Tauri-only no-op there.
  const fullOverlayActive =
    downloadsOpen ||
    settingsOpen ||
    managerOpen ||
    confirmOpen ||
    permissions.prompt !== null ||
    failed !== null ||
    crashed !== null ||
    safety.interstitial !== null;
  useEffect(() => {
    void aegis.view.setChromeOverlay(tabs.activeId, fullOverlayActive || sidebarOpen || shieldOpen);
  }, [tabs.activeId, fullOverlayActive, sidebarOpen, shieldOpen]);
  useEffect(() => {
    // Inset the content by the sidebar's actual width when it's open and no full overlay
    // is covering it — so the page stays visible beside the panel without overlapping it.
    void aegis.view.setSidebar?.(tabs.activeId, sidebarOpen && !fullOverlayActive, sidebarWidth);
  }, [tabs.activeId, sidebarOpen, fullOverlayActive, sidebarWidth]);

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
      else if (s === 'close') void tabs.close(tabs.activeId);
      else if (s === 'reopen') void tabs.reopenClosed();
      else if (s === 'next' || s === 'prev') {
        const ids = tabs.tabs.map((t) => t.id);
        const i = ids.indexOf(tabs.activeId);
        if (ids.length > 0) {
          const ni = s === 'next' ? (i + 1) % ids.length : (i - 1 + ids.length) % ids.length;
          void tabs.activate(ids[ni]);
        }
      } else if (s.startsWith('jump')) {
        const ids = tabs.tabs.map((t) => t.id);
        if (ids.length === 0) return;
        const target = s === 'jumpLast' ? ids[ids.length - 1] : ids[Number(s.slice(4)) - 1];
        if (target !== undefined) void tabs.activate(target);
      }
    });
  }, [tabs.tabs, tabs.activeId]);

  // Ctrl+1-9 when the chrome/address bar is focused (and as the Win/macOS path,
  // where content-webview digit keys aren't captured by a menu accelerator).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!e.ctrlKey || e.altKey || e.metaKey || e.shiftKey) return;
      if (e.key >= '1' && e.key <= '9') {
        e.preventDefault();
        const ids = tabs.tabs.map((t) => t.id);
        if (ids.length === 0) return;
        const target = e.key === '9' ? ids[ids.length - 1] : ids[Number(e.key) - 1];
        if (target !== undefined) void tabs.activate(target);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [tabs.tabs]);

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

  const activeDownloads = downloads.downloads.filter(
    (d) => d.state === 'progressing',
  ).length;

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
    <div className="app">
      <SkipLink targetId={CONTENT_ANCHOR_ID} />
      {!isMobile && (
        <TabStrip
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          onActivate={(id) => void tabs.activate(id)}
          onClose={(id) => void tabs.close(id)}
          onCreate={() => void tabs.create()}
          onReorder={(ids) => void tabs.reorder(ids)}
          onSetPinned={(id, pinned) => void tabs.setPinned(id, pinned)}
        />
      )}
      <Toolbar
        state={nav.state}
        navigate={nav.navigate}
        back={nav.back}
        forward={nav.forward}
        reloadOrStop={nav.reloadOrStop}
        home={nav.home}
        adblock={{
          state: adblock.state,
          page: adblock.page,
          host: hostOf(nav.state.url),
          setEnabled: adblock.setEnabled,
          toggleAllowlist: adblock.toggleAllowlist,
          onOpenChange: setShieldOpen,
        }}
        bookmark={
          <BookmarkButton
            saved={saved.isCurrentSaved}
            canSave={hostOf(nav.state.url) !== null}
            onSave={() => void saved.addCurrent(nav.state.title)}
            onUnsave={() => void saved.removeCurrent()}
          />
        }
        downloads={
          <>
            <UpdateIndicator state={update.state} onRestart={() => void update.restartToInstall()} />
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
            onClick={() => setSettingsOpen(true)}
          >
            <Settings size={18} aria-hidden="true" />
          </button>
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
        onOpenFavorite={(url) => void nav.navigate(url)}
        onOpenManager={() => setManagerOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
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
            onOpen={(url) => void nav.navigate(url)}
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
            onOpen={(url) => void nav.navigate(url)}
          />
        }
      />
      <div id={CONTENT_ANCHOR_ID} className="content-anchor" tabIndex={-1} />
      <ErrorOverlay
        failed={failed}
        crashed={crashed}
        onRetry={handleRetry}
        onHome={handleHome}
      />
      <SafetyInterstitial
        interstitial={safety.interstitial}
        onProceed={(u) => void safety.proceed(u)}
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
          appearance={<AppearanceTab settings={settings.settings} update={settings.update} />}
          search={<SearchTab settings={settings.settings} update={settings.update} />}
          home={<HomeTab settings={settings.settings} update={settings.update} />}
          filterLists={
            <FilterListsTab
              subs={subscriptions.subs}
              setEnabled={subscriptions.setEnabled}
              add={subscriptions.add}
              remove={subscriptions.remove}
              updateNow={subscriptions.updateNow}
            />
          }
          myFilters={<MyFiltersTab text={customFilters.text} save={customFilters.save} />}
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
          security={
            <SecurityTab
              settings={settings.settings}
              update={settings.update}
              listExceptions={() => aegis.safety.listExceptions()}
              removeException={(h) => void aegis.safety.removeException(h)}
            />
          }
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
          onResolve={(_requestId, decision) => void permissions.resolve(decision)}
        />
      )}
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
