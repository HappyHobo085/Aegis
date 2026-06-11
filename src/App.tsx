// src/App.tsx
import { useEffect, useState } from 'react';
import { Settings, PanelRight, Maximize2, Minimize2 } from 'lucide-react';
import { PRIMARY_VIEW_ID } from '../shared/types';
import type { NavCrashed, NavFailed } from '../shared/types';
import { aegis } from './lib/ipcClient';
import { applyTheme } from './lib/theme';
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
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { DownloadsIndicator } from './components/DownloadsIndicator';
import { PickerButton } from './components/PickerButton';
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
import { DataTab } from './components/DataTab';

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
  const nav = useNav(PRIMARY_VIEW_ID);
  const adblock = useAdblock(PRIMARY_VIEW_ID, nav.state.url);
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
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  // Favorites bar is always-on (constant top inset); overlays never inset content.
  useContentInset(PRIMARY_VIEW_ID);

  // Any full-window chrome overlay (sidebar, settings, favorites manager,
  // permission prompt, error/crash screen) must bring the transparent chrome
  // view on top of the content view so it paints over the page.
  const chromeOverlayActive =
    sidebarOpen ||
    downloadsOpen ||
    settingsOpen ||
    managerOpen ||
    permissions.prompt !== null ||
    failed !== null ||
    crashed !== null;
  useEffect(() => {
    void aegis.view.setChromeOverlay(PRIMARY_VIEW_ID, chromeOverlayActive);
  }, [chromeOverlayActive]);

  // Fullscreen: main shrinks chrome to a top-right corner and fills the window
  // with content. Renderer reflects the toggle below (after all hooks).
  useEffect(() => {
    void aegis.view.setFullscreen(PRIMARY_VIEW_ID, fullscreen);
  }, [fullscreen]);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  // Make `siteName` functional: reflect it as the document title. `useSettings`
  // also sets it on every update; this effect covers the initial load + edits.
  useEffect(() => {
    document.title = settings.settings.siteName;
  }, [settings.settings.siteName]);

  useEffect(() => {
    const offFailed = aegis.nav.onFailed((f) => {
      if (f.viewId !== PRIMARY_VIEW_ID) return;
      setCrashed(null);
      setFailed(f);
    });
    const offCrashed = aegis.nav.onCrashed((c) => {
      if (c.viewId !== PRIMARY_VIEW_ID) return;
      setFailed(null);
      setCrashed(c);
    });
    return () => {
      offFailed();
      offCrashed();
    };
  }, []);

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
    void aegis.nav.reloadOrStop(PRIMARY_VIEW_ID);
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
        tagUnion={favorites.tagUnion}
        activeTags={favorites.activeTags}
        setActiveTags={favorites.setActiveTags}
        onOpenFavorite={(url) => void nav.navigate(url)}
        onOpenManager={() => setManagerOpen(true)}
      />
      <Sidebar
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
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
            add={(input) => void saved.add(input)}
            remove={(id) => void saved.remove(id)}
            update={(id, title) => void saved.update(id, title)}
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
          tagUnion={favorites.tagUnion}
          onClose={() => setManagerOpen(false)}
          add={favorites.add}
          update={favorites.update}
          remove={favorites.remove}
          renameTag={favorites.renameTag}
          deleteTag={favorites.deleteTag}
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
          data={
            <DataTab
              onExport={() => aegis.data.export()}
              onImport={(mode) => aegis.data.import(mode)}
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
