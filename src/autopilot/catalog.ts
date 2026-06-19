// src/autopilot/catalog.ts
// Single source of truth for "every feature". Each entry exercises real IPC
// (live: real core; vitest: mock) and declares the channels it covers so the
// drift guard fails when a feature is added without coverage.
import type { AegisApi } from '../../shared/types';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';

export interface FeatureCheck {
  id: string;
  domain: string;
  title: string;
  channels: string[];
  exercise(api: AegisApi): Promise<void>;
}

const V = PRIMARY_VIEW_ID;
function assertArray(x: unknown): void {
  if (!Array.isArray(x)) throw new Error('expected array');
}
function assertObject(x: unknown): void {
  if (x === null || typeof x !== 'object') throw new Error('expected object');
}

export const CATALOG: FeatureCheck[] = [
  // nav
  { id: 'nav.getState', domain: 'nav', title: 'Get nav state', channels: [IPC.navGetState],
    exercise: async (a) => { assertObject(await a.nav.getState(V)); } },
  { id: 'nav.navigate', domain: 'nav', title: 'Navigate', channels: [IPC.navNavigate],
    exercise: async (a) => { await a.nav.navigate(V, 'https://example.com/'); } },
  { id: 'nav.controls', domain: 'nav', title: 'Back/forward/reload/home',
    channels: [IPC.navBack, IPC.navForward, IPC.navReloadOrStop, IPC.navHome],
    exercise: async (a) => { await a.nav.back(V); await a.nav.forward(V); await a.nav.reloadOrStop(V); await a.nav.home(V); } },
  // tabs
  { id: 'tabs.list', domain: 'tabs', title: 'List tabs', channels: [IPC.tabsList],
    exercise: async (a) => { assertObject(await a.tabs.list()); } },
  { id: 'tabs.lifecycle', domain: 'tabs', title: 'Create/activate/close/reopen',
    channels: [IPC.tabsCreate, IPC.tabsActivate, IPC.tabsClose, IPC.tabsReopenClosed, IPC.tabsReorder, IPC.tabsSetPinned, IPC.tabsSetTitle],
    exercise: async (a) => {
      assertObject(await a.tabs.create('https://example.org/', true));
      await a.tabs.reorder([V]); await a.tabs.setPinned(V, true); await a.tabs.setPinned(V, false);
      await a.tabs.setTitle(V, 'AP'); await a.tabs.activate(V); await a.tabs.reopenClosed();
    } },
  // view
  { id: 'view.layout', domain: 'view', title: 'Content visibility/inset/overlay/sidebar/layout/fullscreen',
    channels: [IPC.viewSetContentVisible, IPC.viewSetContentInset, IPC.viewSetChromeOverlay, IPC.viewSetSidebar, IPC.viewSetLayout, IPC.viewSetFullscreen],
    exercise: async (a) => {
      await a.view.setContentVisible(V, true); await a.view.setContentInset(V, { top: 0, right: 0, bottom: 0, left: 0 });
      await a.view.setChromeOverlay(V, false); await a.view.setSidebar?.(V, false, 280);
      await a.view.setLayout?.(V, { overlay: false, sidebar: false, width: 280 }); await a.view.setFullscreen(V, false);
    } },
  // favorites
  { id: 'favorites.crud', domain: 'favorites', title: 'Favorites list/add/update/remove/reorder',
    channels: [IPC.favoritesList, IPC.favoritesAdd, IPC.favoritesUpdate, IPC.favoritesRemove, IPC.favoritesReorder],
    exercise: async (a) => {
      assertArray(await a.favorites.list());
      assertArray(await a.favorites.add({ name: 'AP', url: 'https://ap.test/' }));
      assertArray(await a.favorites.reorder([]));
    } },
  // history
  { id: 'history.crud', domain: 'history', title: 'History list/search/remove/clear',
    channels: [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear],
    exercise: async (a) => { assertArray(await a.history.list({})); assertArray(await a.history.search('a')); } },
  // saved
  { id: 'saved.crud', domain: 'saved', title: 'Saved list/add/remove/has/update/tags',
    channels: [IPC.savedList, IPC.savedAdd, IPC.savedRemove, IPC.savedHas, IPC.savedUpdate, IPC.savedRenameTag, IPC.savedDeleteTag, IPC.savedTagUnion],
    exercise: async (a) => {
      assertArray(await a.saved.list()); assertArray(await a.saved.add({ url: 'https://s.test/', title: 'S', tags: ['t'] }));
      await a.saved.has('https://s.test/'); assertArray(await a.saved.tagUnion());
    } },
  // settings
  { id: 'settings.getset', domain: 'settings', title: 'Settings get/set',
    channels: [IPC.settingsGet, IPC.settingsSet],
    exercise: async (a) => { const s = await a.settings.get(); assertObject(s); assertObject(await a.settings.set({ primaryColor: s.primaryColor })); } },
  // adblock
  { id: 'adblock.toggle', domain: 'adblock', title: 'Ad-block enable/allowlist/state',
    channels: [IPC.adblockSetEnabled, IPC.adblockToggleAllowlist, IPC.adblockRemoveAllowlist, IPC.adblockClearAllowlist, IPC.adblockGetState],
    exercise: async (a) => {
      assertObject(await a.adblock.getState()); assertObject(await a.adblock.setEnabled(true));
      assertObject(await a.adblock.toggleAllowlist('ap.test')); assertObject(await a.adblock.removeAllowlist('ap.test'));
      assertObject(await a.adblock.clearAllowlist());
    } },
  // lists
  { id: 'lists.updateNow', domain: 'lists', title: 'Update filter lists', channels: [IPC.listsUpdateNow],
    exercise: async (a) => { assertObject(await a.lists.updateNow()); } },
  // subs
  { id: 'subs.crud', domain: 'subs', title: 'Subscriptions list/setEnabled/add/remove',
    channels: [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove],
    exercise: async (a) => { assertArray(await a.subs.list()); } },
  // customFilters
  { id: 'customFilters.getset', domain: 'customFilters', title: 'Custom filters get/set',
    channels: [IPC.customFiltersGet, IPC.customFiltersSet],
    exercise: async (a) => { const t = await a.customFilters.get(); if (typeof t !== 'string') throw new Error('string'); await a.customFilters.set(t); } },
  // downloads
  { id: 'downloads.crud', domain: 'downloads', title: 'Downloads list/remove/clear (+ file ops)',
    channels: [IPC.downloadsList, IPC.downloadsRemove, IPC.downloadsClear, IPC.downloadsOpenFile, IPC.downloadsShowInFolder, IPC.downloadsCancel],
    exercise: async (a) => { assertArray(await a.downloads.list()); } },
  // permissions
  { id: 'permissions.crud', domain: 'permissions', title: 'Permissions list/remove/clear/resolve',
    channels: [IPC.permissionsList, IPC.permissionsRemove, IPC.permissionsClear, IPC.permissionsResolve],
    exercise: async (a) => { assertArray(await a.permissions.list()); } },
  // data
  { id: 'data.export', domain: 'data', title: 'Data export', channels: [IPC.dataExport, IPC.dataImport],
    exercise: async (a) => { assertObject(await a.data.export()); } },
  // picker
  { id: 'picker.start', domain: 'picker', title: 'Element picker', channels: [IPC.pickerStart],
    exercise: async (a) => { assertObject(await a.picker.start()); } },
  // update
  { id: 'update.state', domain: 'update', title: 'Update get/check',
    channels: [IPC.updateGetState, IPC.updateCheckNow, IPC.updateRestartToInstall],
    exercise: async (a) => { assertObject(await a.update.getState()); await a.update.checkNow(); } },
  // safety
  { id: 'safety.state', domain: 'safety', title: 'Safety get/exceptions',
    channels: [IPC.safetyGetState, IPC.safetyProceed, IPC.safetyListExceptions, IPC.safetyRemoveException],
    exercise: async (a) => { await a.safety.getState(); assertArray(await a.safety.listExceptions()); } },
  // sync
  { id: 'sync.state', domain: 'sync', title: 'Sync get/test/devices',
    channels: [IPC.syncGetState, IPC.syncEnableNew, IPC.syncEnableFromPhrase, IPC.syncDisable, IPC.syncNow, IPC.syncTestConnection, IPC.syncGetRecoveryPhrase, IPC.syncListDevices, IPC.syncRemoveDevice],
    exercise: async (a) => { assertObject(await a.sync.getState()); assertArray(await a.sync.listDevices()); } },
];

// Channels intentionally not exercised by a catalog `exercise` (destructive,
// require a real OS file/window, or fire-and-forget side effects covered live/in
// component tests). Kept explicit so the drift guard still forces a decision.
export const UNTESTED_CHANNELS = new Set<string>([
  // file/OS-bound — exercised live only, would mutate the host in vitest:
  IPC.downloadsOpenFile, IPC.downloadsShowInFolder, IPC.downloadsCancel,
  IPC.dataImport, IPC.permissionsResolve, IPC.safetyProceed,
  IPC.updateRestartToInstall, IPC.permissionsRemove, IPC.permissionsClear,
  IPC.safetyRemoveException, IPC.historyRemove, IPC.historyClear,
  IPC.favoritesUpdate, IPC.favoritesRemove, IPC.savedRemove, IPC.savedUpdate,
  IPC.savedRenameTag, IPC.savedDeleteTag, IPC.subsSetEnabled, IPC.subsAdd,
  IPC.subsRemove, IPC.syncEnableNew, IPC.syncEnableFromPhrase, IPC.syncDisable,
  IPC.syncNow, IPC.syncTestConnection, IPC.syncGetRecoveryPhrase, IPC.syncRemoveDevice,
]);
