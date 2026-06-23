// src/components/mobile/MobileApp.tsx
import { useEffect, useState } from 'react';
import {
  aegis,
  setBackInterceptActive,
  setBottomBarHidden as setNativeBottomBarHidden,
  setFullscreen as setNativeFullscreen,
} from '../../lib/ipcClient';
import { applyTheme } from '../../lib/theme';
import { useTabs } from '../../hooks/useTabs';
import { useNav } from '../../hooks/useNav';
import { useAdblock } from '../../hooks/useAdblock';
import { useFavorites } from '../../hooks/useFavorites';
import { useHistory } from '../../hooks/useHistory';
import { useSaved } from '../../hooks/useSaved';
import { useSettings } from '../../hooks/useSettings';
import { useSync } from '../../hooks/useSync';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useCustomFilters } from '../../hooks/useCustomFilters';
import { useDownloads } from '../../hooks/useDownloads';
import { usePermissions } from '../../hooks/usePermissions';
import { useFind } from '../../hooks/useFind';
import { useMobileTabSync } from '../../hooks/useMobileTabSync';
import { AdblockShield } from '../AdblockShield';
import { FindBar } from '../FindBar';
import { HistoryPanel } from '../HistoryPanel';
import { SavedPanel } from '../SavedPanel';
import { DownloadsModal } from '../DownloadsModal';
import { SettingsModal } from '../SettingsModal';
import { AppearanceTab } from '../AppearanceTab';
import { SearchTab } from '../SearchTab';
import { HomeTab } from '../HomeTab';
import { TabsTab } from '../TabsTab';
import { FilterListsTab } from '../FilterListsTab';
import { MyFiltersTab } from '../MyFiltersTab';
import { AllowlistTab } from '../AllowlistTab';
import { DownloadsTab } from '../DownloadsTab';
import { SitePermissionsTab } from '../SitePermissionsTab';
import { SecurityTab } from '../SecurityTab';
import { SyncSettingsTab } from '../SyncSettingsTab';
import { DataTab } from '../DataTab';
import { PermissionPromptDialog } from '../PermissionPromptDialog';
import { Toaster } from '../Toaster';
import { ConfirmDialog } from '../ConfirmDialog';
import { MobileTopBar } from './MobileTopBar';
import { MobileBottomBar } from './MobileBottomBar';
import { MobileMenuSheet } from './MobileMenuSheet';
import { MobileSheet } from './MobileSheet';
import { MobileTabSwitcher } from './MobileTabSwitcher';

declare global {
  interface Window {
    __aegisMobileBack?: () => void;
    __aegisOpenTab?: (url: string) => void;
  }
}

type Sheet = 'menu' | 'history' | 'saved' | 'downloads' | 'settings' | 'tabs' | null;

function hostOf(url: string): string | null {
  try {
    const h = new URL(url).hostname;
    return h.length > 0 ? h : null;
  } catch {
    return null;
  }
}

export function MobileApp() {
  const tabs = useTabs();
  const nav = useNav(tabs.activeId);
  const find = useFind(tabs.activeId);
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  useMobileTabSync(tabs.tabs, tabs.activeId);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const settings = useSettings();
  const sync = useSync();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const downloads = useDownloads();
  const permissions = usePermissions();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [bottomBarHidden, setBottomBarHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  // Manual bottom-bar toggle (the top-bar button): tell the native side to hide/show the
  // bar so the content webview reclaims (or restores) the bar's bottom-margin gap.
  useEffect(() => {
    setNativeBottomBarHidden(bottomBarHidden);
  }, [bottomBarHidden]);

  // Chrome-hiding fullscreen (the top-bar Maximize button; desktop parity): native drops
  // the top + bottom content margins so the page fills the safe area; React hides the bars.
  useEffect(() => {
    setNativeFullscreen(fullscreen);
  }, [fullscreen]);

  const overlayOpen = sheet !== null || shieldOpen;
  useEffect(() => {
    void aegis.view.setChromeOverlay(tabs.activeId, overlayOpen);
  }, [overlayOpen, tabs.activeId]);
  useEffect(() => {
    setBackInterceptActive(sheet !== null || fullscreen);
    window.__aegisMobileBack = () => {
      if (sheet !== null) setSheet(null);
      else if (fullscreen) setFullscreen(false);
    };
    return () => {
      delete window.__aegisMobileBack;
    };
  }, [sheet, fullscreen]);

  // Allow native Android code to open a URL in a new tab (target=_blank / window.open).
  // Open it in the BACKGROUND so the current page keeps focus (matches desktop's
  // on_new_window). Depend on the stable `tabs.create` callback (a useCallback in
  // useTabs), not the whole `tabs` object — which is re-created every render and would
  // reinstall this each render.
  useEffect(() => {
    window.__aegisOpenTab = (url) => {
      void tabs.create(url, true);
    };
    return () => {
      delete window.__aegisOpenTab;
    };
  }, [tabs.create]);

  // On Android the Rust core can't observe the content WebView's title (there's no
  // WebKit title signal like desktop), so the tab switcher would show host fallbacks.
  // Relay the active tab's title from its nav state into the registry. Guard on the
  // nav state's own viewId so a transient (pre-activate) state from the previous tab
  // isn't recorded against the newly-active tab.
  useEffect(() => {
    if (nav.state.title && nav.state.viewId === tabs.activeId) {
      void aegis.tabs.setTitle(tabs.activeId, nav.state.title);
    }
  }, [nav.state.title, nav.state.viewId, tabs.activeId]);

  const host = hostOf(nav.state.url);
  const shield = (
    <AdblockShield
      state={adblock.state}
      page={adblock.page}
      host={host}
      setEnabled={adblock.setEnabled}
      toggleAllowlist={adblock.toggleAllowlist}
      onOpenChange={setShieldOpen}
    />
  );

  return (
    <div className="app app--mobile">
      {!fullscreen && (
        <MobileTopBar
          url={nav.state.url}
          isLoading={nav.state.isLoading}
          onNavigate={nav.navigate}
          onReloadOrStop={nav.reloadOrStop}
          favorites={favorites.favorites}
          onOpenFavourite={(url) => void nav.navigate(url)}
          bottomBarHidden={bottomBarHidden}
          onToggleBottomBar={() => setBottomBarHidden((v) => !v)}
          onEnterFullscreen={() => setFullscreen(true)}
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
      <div className="content-anchor" />
      {!bottomBarHidden && !fullscreen && (
        <MobileBottomBar
          onSaved={() => setSheet('saved')}
          onHistory={() => setSheet('history')}
          onTabs={() => setSheet('tabs')}
          tabCount={tabs.tabs.length}
          shield={shield}
          onMenu={() => setSheet('menu')}
        />
      )}

      {sheet === 'menu' && (
        <MobileMenuSheet
          onClose={() => setSheet(null)}
          onBack={nav.back}
          onForward={nav.forward}
          canGoBack={nav.state.canGoBack}
          canGoForward={nav.state.canGoForward}
          onHome={nav.home}
          onDownloads={() => setSheet('downloads')}
          onSettings={() => setSheet('settings')}
          isCurrentSaved={saved.isCurrentSaved}
          canBookmark={host !== null}
          onToggleBookmark={() => {
            if (saved.isCurrentSaved) void saved.removeCurrent();
            else void saved.addCurrent(nav.state.title);
          }}
          onFind={() => {
            find.show();
            setSheet(null);
          }}
        />
      )}

      {sheet === 'tabs' && (
        <MobileTabSwitcher
          tabs={tabs.tabs}
          activeId={tabs.activeId}
          onSwitch={(id) => {
            void tabs.activate(id);
            setSheet(null);
          }}
          onCloseTab={(id) => void tabs.close(id)}
          onNewTab={() => {
            void tabs.create('about:blank');
            setSheet(null);
          }}
          onClose={() => setSheet(null)}
        />
      )}

      {sheet === 'history' && (
        <MobileSheet title="History" onClose={() => setSheet(null)}>
          <HistoryPanel
            entries={history.entries}
            query={history.query}
            setQuery={history.setQuery}
            search={history.search}
            remove={history.remove}
            clear={history.clear}
            onOpen={(url) => {
              void nav.navigate(url);
              setSheet(null);
            }}
          />
        </MobileSheet>
      )}

      {sheet === 'saved' && (
        <MobileSheet title="Saved" onClose={() => setSheet(null)}>
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
              void nav.navigate(url);
              setSheet(null);
            }}
          />
        </MobileSheet>
      )}

      {sheet === 'downloads' && (
        <DownloadsModal
          onClose={() => setSheet(null)}
          downloads={downloads.downloads}
          remove={(id) => void downloads.remove(id)}
          clear={() => void downloads.clear()}
          openFile={(id) => void downloads.openFile(id)}
          showInFolder={(id) => void downloads.showInFolder(id)}
          cancel={(id) => void downloads.cancel(id)}
        />
      )}

      {sheet === 'settings' && (
        <SettingsModal
          onClose={() => setSheet(null)}
          appearance={<AppearanceTab settings={settings.settings} update={settings.update} />}
          search={<SearchTab settings={settings.settings} update={settings.update} />}
          home={<HomeTab settings={settings.settings} update={settings.update} />}
          tabs={<TabsTab settings={settings.settings} update={settings.update} />}
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
          sync={
            <SyncSettingsTab
              sync={sync}
              onSetServerUrl={(url) => void settings.update({ syncServerUrl: url })}
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
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
