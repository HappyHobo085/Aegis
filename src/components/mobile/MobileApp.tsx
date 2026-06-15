// src/components/mobile/MobileApp.tsx
import { useEffect, useState } from 'react';
import { PRIMARY_VIEW_ID } from '../../../shared/types';
import { aegis, setBackInterceptActive, setBottomBarHidden as setNativeBottomBarHidden } from '../../lib/ipcClient';
import { applyTheme } from '../../lib/theme';
import { useNav } from '../../hooks/useNav';
import { useAdblock } from '../../hooks/useAdblock';
import { useFavorites } from '../../hooks/useFavorites';
import { useHistory } from '../../hooks/useHistory';
import { useSaved } from '../../hooks/useSaved';
import { useSettings } from '../../hooks/useSettings';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useCustomFilters } from '../../hooks/useCustomFilters';
import { useDownloads } from '../../hooks/useDownloads';
import { usePermissions } from '../../hooks/usePermissions';
import { AdblockShield } from '../AdblockShield';
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
import { DataTab } from '../DataTab';
import { PermissionPromptDialog } from '../PermissionPromptDialog';
import { Toaster } from '../Toaster';
import { ConfirmDialog } from '../ConfirmDialog';
import { MobileTopBar } from './MobileTopBar';
import { MobileBottomBar } from './MobileBottomBar';
import { MobileMenuSheet } from './MobileMenuSheet';
import { MobileSheet } from './MobileSheet';

declare global {
  interface Window { __aegisMobileBack?: () => void }
}

type Sheet = 'menu' | 'history' | 'saved' | 'downloads' | 'settings' | null;

function hostOf(url: string): string | null {
  try { const h = new URL(url).hostname; return h.length > 0 ? h : null; } catch { return null; }
}

export function MobileApp() {
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
  const [sheet, setSheet] = useState<Sheet>(null);
  const [shieldOpen, setShieldOpen] = useState(false);
  const [bottomBarHidden, setBottomBarHidden] = useState(false);

  useEffect(() => { void aegis.settings.get().then((s) => applyTheme(s)); }, []);

  // Manual bottom-bar toggle (the top-bar button): tell the native side to hide/show the
  // bar so the content webview reclaims (or restores) the bar's bottom-margin gap.
  useEffect(() => { setNativeBottomBarHidden(bottomBarHidden); }, [bottomBarHidden]);

  const overlayOpen = sheet !== null || shieldOpen;
  useEffect(() => {
    void aegis.view.setChromeOverlay(PRIMARY_VIEW_ID, overlayOpen);
  }, [overlayOpen]);
  useEffect(() => {
    setBackInterceptActive(sheet !== null);
    window.__aegisMobileBack = () => setSheet(null);
    return () => { delete window.__aegisMobileBack; };
  }, [sheet]);

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
      <MobileTopBar
        url={nav.state.url}
        isLoading={nav.state.isLoading}
        onNavigate={nav.navigate}
        onReloadOrStop={nav.reloadOrStop}
        favorites={favorites.favorites}
        onOpenFavourite={(url) => void nav.navigate(url)}
        bottomBarHidden={bottomBarHidden}
        onToggleBottomBar={() => setBottomBarHidden((v) => !v)}
      />
      <div className="content-anchor" />
      {!bottomBarHidden && (
        <MobileBottomBar
          canGoBack={nav.state.canGoBack}
          canGoForward={nav.state.canGoForward}
          onBack={nav.back}
          onForward={nav.forward}
          onHome={nav.home}
          onMenu={() => setSheet('menu')}
          shield={shield}
        />
      )}

      {sheet === 'menu' && (
        <MobileMenuSheet
          onClose={() => setSheet(null)}
          onSettings={() => setSheet('settings')}
          onHistory={() => setSheet('history')}
          onSaved={() => setSheet('saved')}
          onDownloads={() => setSheet('downloads')}
          isCurrentSaved={saved.isCurrentSaved}
          canBookmark={host !== null}
          onToggleBookmark={() => {
            if (saved.isCurrentSaved) void saved.removeCurrent();
            else void saved.addCurrent(nav.state.title);
          }}
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
            onOpen={(url) => { void nav.navigate(url); setSheet(null); }}
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
            onOpen={(url) => { void nav.navigate(url); setSheet(null); }}
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
