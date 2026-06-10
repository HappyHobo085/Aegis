// src/App.tsx
import { useEffect, useState } from 'react';
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
import { useContentInset } from './hooks/useContentInset';
import { Toolbar } from './components/Toolbar';
import { BookmarkButton } from './components/BookmarkButton';
import { FavoritesBar } from './components/FavoritesBar';
import { FavoritesManager } from './components/FavoritesManager';
import { Sidebar } from './components/Sidebar';
import { HistoryPanel } from './components/HistoryPanel';
import { SavedPanel } from './components/SavedPanel';
import { ErrorOverlay } from './components/ErrorOverlay';
import { SkipLink } from './components/SkipLink';
import { Toaster } from './components/Toaster';
import { ConfirmDialog } from './components/ConfirmDialog';
import { WelcomeHint } from './components/WelcomeHint';
import { SettingsModal } from './components/SettingsModal';
import { AppearanceTab } from './components/AppearanceTab';
import { SearchTab } from './components/SearchTab';
import { HomeTab } from './components/HomeTab';
import { FilterListsTab } from './components/FilterListsTab';
import { MyFiltersTab } from './components/MyFiltersTab';
import { AllowlistTab } from './components/AllowlistTab';

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
  const [failed, setFailed] = useState<NavFailed | null>(null);
  const [crashed, setCrashed] = useState<NavCrashed | null>(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Favorites bar is always-on in Phase 3; only the sidebar toggles the inset.
  useContentInset(PRIMARY_VIEW_ID, { sidebarOpen });

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
        gear={
          <button
            type="button"
            className="toolbar__gear"
            aria-label="Open settings"
            onClick={() => setSettingsOpen(true)}
          >
            {'⚙'}
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
        onToggle={() => setSidebarOpen((v) => !v)}
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
            remove={(id) => void saved.remove(id)}
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
        />
      )}
      <WelcomeHint />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
