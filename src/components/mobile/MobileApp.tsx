// src/components/mobile/MobileApp.tsx
import { useEffect, useState } from 'react';
import {
  aegis,
  setBackInterceptActive,
  setBottomBarHidden as setNativeBottomBarHidden,
  setFullscreen as setNativeFullscreen,
} from '../../lib/ipcClient';
import { applyTheme } from '../../lib/theme';
import { protectionSummary } from '../../lib/protectionSummary';
import { useDownloadToasts } from '../../hooks/useDownloadToasts';
import { useTabs } from '../../hooks/useTabs';
import { useNav } from '../../hooks/useNav';
import { useTabTitleSync } from '../../hooks/useTabTitleSync';
import { useAdblock } from '../../hooks/useAdblock';
import { useFingerprint } from '../../hooks/useFingerprint';
import { useWebrtcExempt } from '../../hooks/useWebrtcExempt';
import { useFavorites } from '../../hooks/useFavorites';
import { useHistory } from '../../hooks/useHistory';
import { useSaved } from '../../hooks/useSaved';
import { useSettings } from '../../hooks/useSettings';
import { useSync } from '../../hooks/useSync';
import { hostOf, originOf } from '../../lib/url';
import { useVault } from '../../hooks/useVault';
import { useProxy } from '../../hooks/useProxy';
import { useSubscriptions } from '../../hooks/useSubscriptions';
import { useCustomFilters } from '../../hooks/useCustomFilters';
import { useDownloads } from '../../hooks/useDownloads';
import { usePermissions } from '../../hooks/usePermissions';
import { useFind } from '../../hooks/useFind';
import { useZoom } from '../../hooks/useZoom';
import { ChromeSurfaceProvider, useChromeSurfaceCount } from '../../hooks/useChromeSurfaces';
import { useMobileTabSync } from '../../hooks/useMobileTabSync';
import { AdblockShield } from '../AdblockShield';
import { FindBar } from '../FindBar';
import { HistoryPanel } from '../HistoryPanel';
import { SavedPanel } from '../SavedPanel';
import { DownloadsModal } from '../DownloadsModal';
import { SettingsModal } from '../SettingsModal';
import type { SettingsTab } from '../SettingsModal';
import { CommandPalette } from '../CommandPalette';
import { AppearanceTab } from '../AppearanceTab';
import { SearchTab } from '../SearchTab';
import { HomeTab } from '../HomeTab';
import { TabsTab } from '../TabsTab';
import { AllowlistTab } from '../AllowlistTab';
import { DownloadsTab } from '../DownloadsTab';
import { SitePermissionsTab } from '../SitePermissionsTab';
import { DataTab } from '../DataTab';
import { PermissionPromptDialog } from '../PermissionPromptDialog';
import { Toaster } from '../Toaster';
import { ConfirmDialog } from '../ConfirmDialog';
import { Onboarding } from '../Onboarding';
import { toast } from '../../lib/toast';
import { MobileTopBar } from './MobileTopBar';
import { MobileBottomBar } from './MobileBottomBar';
import { MobileMenuSheet } from './MobileMenuSheet';
import { MobileSheet } from './MobileSheet';
import { MobileTabSwitcher } from './MobileTabSwitcher';
import { MobileFavourites } from './MobileFavourites';

declare global {
  interface Window {
    __aegisMobileBack?: () => void;
    __aegisOpenTab?: (url: string) => void;
  }
}

type Sheet = 'menu' | 'history' | 'saved' | 'downloads' | 'settings' | 'tabs' | null;

/** The mobile shell, wrapped in the surface registry.
 *
 *  `ChromeSurfaceProvider` has to be an ANCESTOR of everything that calls
 *  `useChromeSurface`, which means it cannot be a wrapper around just the returned
 *  JSX — `useChromeSurfaceCount` below runs during `MobileShell`'s own render. So
 *  the exported component is the provider and the body is the inner one. The
 *  desktop shell makes the same split via `ChromeSurfaceProvider` in `App.tsx`. */
export function MobileApp() {
  return (
    <ChromeSurfaceProvider>
      <MobileShell />
    </ChromeSurfaceProvider>
  );
}

function MobileShell() {
  const tabs = useTabs();
  const nav = useNav(tabs.activeId);
  // Same reason as the desktop chrome: keep a tab's title current when the page
  // renames itself after load.
  useTabTitleSync();
  const find = useFind(tabs.activeId);
  const zoom = useZoom(tabs.activeId);
  const adblock = useAdblock(tabs.activeId, nav.state.url);
  const fingerprint = useFingerprint();
  const webrtcExempt = useWebrtcExempt();
  useMobileTabSync(tabs.tabs, tabs.activeId);
  const favorites = useFavorites(nav.state.url);
  const history = useHistory();
  const saved = useSaved(nav.state.url);
  const settings = useSettings();
  const sync = useSync();
  const vault = useVault();
  const proxy = useProxy();
  const subscriptions = useSubscriptions();
  const customFilters = useCustomFilters();
  const downloads = useDownloads();
  const permissions = usePermissions();
  const [sheet, setSheet] = useState<Sheet>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<SettingsTab>('appearance');
  const [commandOpen, setCommandOpen] = useState(false);
  const [shieldOpen, setShieldOpen] = useState(false);
  // True while the address-bar suggestion list (or site-info popover) is up.
  const [addressOpen, setAddressOpen] = useState(false);
  const [bottomBarHidden, setBottomBarHidden] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    void aegis.settings.get().then((s) => applyTheme(s));
  }, []);

  const openSettings = (tab: SettingsTab = 'appearance'): void => {
    setSettingsInitialTab(tab);
    setSheet('settings');
  };

  // Manual bottom-bar toggle (the top-bar button): tell the native side to hide/show the
  // bar so the content webview reclaims (or restores) the bar's bottom-margin gap.
  useEffect(() => {
    setNativeBottomBarHidden(bottomBarHidden);
  }, [bottomBarHidden]);

  // Chrome-hiding fullscreen (bottom-bar Maximize button; desktop parity): native drops
  // the top + bottom content margins so the page fills the safe area; React hides the bars.
  useEffect(() => {
    setNativeFullscreen(fullscreen);
  }, [fullscreen]);

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

  // The address-bar suggestion list is a chrome overlay too: the native content
  // WebView sits on top of the chrome WebView, so it must be lowered for the
  // dropdown to be visible (the desktop shell insets by the measured height
  // instead — see useChromePopover; a single WebView has nothing to inset).
  //
  // `surfaceCount` covers everything that registers through `useChromeSurface`
  // rather than through one of the three states above. Without the
  // `ChromeSurfaceProvider` mounted below, that registration is a silent no-op and
  // the surface renders INSIDE the chrome WebView, underneath the native content
  // WebView: first-run onboarding (a full-screen card whose only button writes the
  // "don't show this again" key), the permission prompt, and the command palette
  // were all invisible and untappable on Android.
  const surfaceCount = useChromeSurfaceCount();
  const overlayOpen = sheet !== null || shieldOpen || addressOpen || surfaceCount > 0;
  useEffect(() => {
    void aegis.view.setChromeOverlay(tabs.activeId, overlayOpen);
  }, [overlayOpen, tabs.activeId]);

  useEffect(() => {
    setBackInterceptActive(sheet !== null || fullscreen || find.open);
    window.__aegisMobileBack = () => {
      if (sheet !== null) setSheet(null);
      else if (fullscreen) setFullscreen(false);
      // The find bar is a full-window surface over the content, so BACK has to close
      // it too — otherwise intercepting BACK here would swallow the gesture without
      // dismissing anything, which is worse than not intercepting at all.
      else if (find.open) find.close();
    };
    return () => {
      delete window.__aegisMobileBack;
    };
    // `find.open` and `find.close` are BOTH required. Without `find.open` in the deps
    // the effect does not re-run when the bar opens or closes, so BACK is armed and
    // disarmed at the wrong times; `find.close` is a useCallback on `activeViewId`, so
    // listing it does not re-run this every render.
  }, [sheet, fullscreen, find.open, find.close]);

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

  // On Android the Rust core can't observe the native content WebView's navigations
  // (nav.navigate goes through the bridge, not the Rust child-webview path). Relay the
  // active tab's URL/title back into the registry so tabs.json restores real pages
  // after the app process closes.
  useEffect(() => {
    if (nav.state.url && nav.state.viewId === tabs.activeId) {
      void aegis.tabs.recordNav(tabs.activeId, nav.state.url, nav.state.title);
    }
  }, [nav.state.url, nav.state.title, nav.state.viewId, tabs.activeId]);

  const host = hostOf(nav.state.url);
  const origin = originOf(nav.state.url);
  const activeTab = tabs.tabs.find((t) => t.id === tabs.activeId);
  const activeProtection = protectionSummary({
    activeTab,
    settings: settings.settings,
    fingerprint: fingerprint.state,
    webrtc: webrtcExempt.state,
    proxy: proxy.state,
    host,
  });
  useDownloadToasts(downloads.downloads, {
    openFile: downloads.openFile,
    showInFolder: downloads.showInFolder,
  });

  const forgetSitePermissions = (siteOrigin: string): void => {
    for (const permission of permissions.permissions.filter((p) => p.origin === siteOrigin)) {
      void permissions.remove(permission.origin, permission.permission);
    }
  };

  const clearRememberedSiteData = (siteOrigin: string): void => {
    forgetSitePermissions(siteOrigin);
    // Core-side, over the WHOLE store: `history.entries` is only the last `list()` page
    // (200 of up to 5000 rows), so looping over it claimed to clear a site while most of
    // its history stayed on disk — and `history.search` filters the full snapshot, so the
    // user could search the "erased" rows straight back up.
    void history.removeForOrigin(siteOrigin);
    toast.info('Cleared Aegis history and remembered permissions for this site.');
  };

  const shield = (
    <AdblockShield
      state={adblock.state}
      page={adblock.page}
      host={host}
      setEnabled={adblock.setEnabled}
      toggleAllowlist={adblock.toggleAllowlist}
      onOpenChange={setShieldOpen}
      onReload={nav.reloadOrStop}
      protection={activeProtection}
    />
  );

  return (
    <div className={`app app--mobile${activeProtection.privateMode ? ' app--private' : ''}`}>
      {!fullscreen && (
        <MobileTopBar
          url={nav.state.url}
          isLoading={nav.state.isLoading}
          isPrivate={activeProtection.privateMode}
          siteInfo={{
            origin,
            host,
            permissions: permissions.permissions,
            protection: activeProtection,
            onForgetSitePermissions: forgetSitePermissions,
            onClearRememberedSiteData: clearRememberedSiteData,
            onOpenPrivacySettings: () => openSettings('security'),
          }}
          inlineShield={shield}
          omnibox={{
            favorites: favorites.favorites,
            saved: saved.items,
            searchTemplate: nav.searchTemplate,
          }}
          onDropdownOpenChange={setAddressOpen}
          onNavigate={nav.navigate}
          onReloadOrStop={nav.reloadOrStop}
          bottomBarHidden={bottomBarHidden}
          onToggleBottomBar={() => setBottomBarHidden((v) => !v)}
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
      {!fullscreen && (favorites.favorites.length > 0 || host !== null) && (
        <MobileFavourites
          favorites={favorites.favorites}
          onOpen={(url: string) => void nav.navigate(url)}
          onAdd={
            host !== null
              ? () => void favorites.add({ name: nav.state.title || host, url: nav.state.url })
              : undefined
          }
        />
      )}
      <div className="content-anchor" />
      {!bottomBarHidden && !fullscreen && (
        <MobileBottomBar
          onSaved={() => setSheet('saved')}
          onHistory={() => setSheet('history')}
          onTabs={() => setSheet('tabs')}
          tabCount={tabs.tabs.length}
          onFullscreen={() => setFullscreen(true)}
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
          onSettings={() => openSettings()}
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
          zoomPercent={zoom.percent}
          onZoomIn={zoom.zoomIn}
          onZoomOut={zoom.zoomOut}
          onZoomReset={zoom.reset}
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
          onNewPrivateTab={() => {
            void tabs.create(undefined, false, true);
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
              <button type="button" onClick={() => setSheet('downloads')}>
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
            // Pass the module function itself. A fresh arrow here is a new identity on every
            // MobileApp render, and SecurityTab lists this in its effect deps — so every nav
            // state / tabs.state / blockedCount update re-fetched and re-rendered the tab.
            // Desktop already passes the stable function (App.tsx).
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
      <CommandPalette open={commandOpen} onClose={() => setCommandOpen(false)} />
      <Toaster />
      <ConfirmDialog />
    </div>
  );
}
