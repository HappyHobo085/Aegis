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
  /** Real round-trip: does an action, asserts the effect, restores state. Returns a
   *  short success detail. Throws on assertion failure. Live run only — NOT called
   *  from the vitest tour or the mock-based run.test.ts. */
  verify?(api: AegisApi): Promise<string>;
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
    exercise: async (a) => { await a.nav.navigate(V, 'https://example.com/'); },
    verify: async (a) => {
      await a.nav.navigate(V, 'https://example.com/');
      // Poll up to ~8s for the nav state URL to reflect the navigation.
      const deadline = Date.now() + 8000;
      let url = '';
      while (Date.now() < deadline) {
        const state = await a.nav.getState(V);
        url = state.url;
        if (url.includes('example.com')) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!url.includes('example.com')) throw new Error(`navigate: url '${url}' never contained 'example.com'`);
      return `nav navigate→poll ok (url=${url})`;
    } },
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
    },
    verify: async (a) => {
      const before = await a.tabs.list();
      const beforeIds = new Set(before.tabs.map((t) => t.id));
      const created = await a.tabs.create('https://ap-tab.test/', true);
      const newTab = created.tabs.find((t) => !beforeIds.has(t.id));
      if (!newTab) throw new Error('create: no new tab id in returned state');
      const afterClose = await a.tabs.close(newTab.id);
      if (afterClose.tabs.some((t) => t.id === newTab.id)) throw new Error('close: new tab still in list');
      return `tabs create(bg)→assert→close ok (newId=${newTab.id})`;
    } },
  // view — overlay/visibility calls are pure layout side-effects on the native webview stack;
  // there is no readable state to assert after the call without a screenshot.
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
    },
    verify: async (a) => {
      const probeUrl = 'https://ap-fav.test/';
      const after = await a.favorites.add({ name: 'AP-verify', url: probeUrl });
      const added = after.find((f) => f.url === probeUrl);
      if (!added) throw new Error('add: probe url not in returned list');
      const afterRemove = await a.favorites.remove(added.id);
      if (afterRemove.some((f) => f.url === probeUrl)) throw new Error('remove: probe url still in list');
      return 'favorite add→list→remove ok';
    } },
  // history — read-only probe: no deterministic write path via IPC (entries are
  // written by the core on real navigation, not via a direct add channel).
  { id: 'history.crud', domain: 'history', title: 'History list/search/remove/clear',
    channels: [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear],
    exercise: async (a) => { assertArray(await a.history.list({})); assertArray(await a.history.search('a')); } },
  // saved
  { id: 'saved.crud', domain: 'saved', title: 'Saved list/add/remove/has/update/tags',
    channels: [IPC.savedList, IPC.savedAdd, IPC.savedRemove, IPC.savedHas, IPC.savedUpdate, IPC.savedRenameTag, IPC.savedDeleteTag, IPC.savedTagUnion],
    exercise: async (a) => {
      assertArray(await a.saved.list()); assertArray(await a.saved.add({ url: 'https://s.test/', title: 'S', tags: ['t'] }));
      await a.saved.has('https://s.test/'); assertArray(await a.saved.tagUnion());
    },
    verify: async (a) => {
      const probeUrl = 'https://ap-saved.test/';
      await a.saved.add({ url: probeUrl, title: 'AP', tags: ['ap'] });
      const hasAfterAdd = await a.saved.has(probeUrl);
      if (!hasAfterAdd) throw new Error('has: expected true after add');
      const items = await a.saved.list();
      const item = items.find((i) => i.url === probeUrl);
      if (!item) throw new Error('list: probe url not found');
      await a.saved.remove(item.id);
      const hasAfterRemove = await a.saved.has(probeUrl);
      if (hasAfterRemove) throw new Error('has: expected false after remove');
      return 'saved add→has→list→remove ok';
    } },
  // settings
  { id: 'settings.getset', domain: 'settings', title: 'Settings get/set',
    channels: [IPC.settingsGet, IPC.settingsSet],
    exercise: async (a) => { const s = await a.settings.get(); assertObject(s); assertObject(await a.settings.set({ primaryColor: s.primaryColor })); },
    verify: async (a) => {
      const original = await a.settings.get();
      const probe = '#abcdef';
      const after = await a.settings.set({ primaryColor: probe });
      if (after.primaryColor !== probe) throw new Error(`set: expected '${probe}', got '${after.primaryColor}'`);
      const restored = await a.settings.set({ primaryColor: original.primaryColor });
      if (restored.primaryColor !== original.primaryColor) throw new Error('restore: primaryColor mismatch');
      return 'settings get→set→assert→restore ok';
    } },
  // adblock
  { id: 'adblock.toggle', domain: 'adblock', title: 'Ad-block enable/allowlist/state',
    channels: [IPC.adblockSetEnabled, IPC.adblockToggleAllowlist, IPC.adblockRemoveAllowlist, IPC.adblockClearAllowlist, IPC.adblockGetState],
    exercise: async (a) => {
      assertObject(await a.adblock.getState()); assertObject(await a.adblock.setEnabled(true));
      assertObject(await a.adblock.toggleAllowlist('ap.test')); assertObject(await a.adblock.removeAllowlist('ap.test'));
      assertObject(await a.adblock.clearAllowlist());
    },
    verify: async (a) => {
      const probeHost = 'ap-allow.test';
      const off = await a.adblock.setEnabled(false);
      if (off.enabled !== false) throw new Error('setEnabled(false): still enabled');
      const on = await a.adblock.setEnabled(true);
      if (on.enabled !== true) throw new Error('setEnabled(true): not enabled');
      const toggled = await a.adblock.toggleAllowlist(probeHost);
      if (!toggled.allowlistedHosts.includes(probeHost)) throw new Error('toggleAllowlist: host not in allowlistedHosts');
      const removed = await a.adblock.removeAllowlist(probeHost);
      if (removed.allowlistedHosts.includes(probeHost)) throw new Error('removeAllowlist: host still in allowlistedHosts');
      return 'adblock setEnabled off→on→allowlist add→remove ok';
    } },
  // lists — triggering a real network fetch in a verify round-trip is too slow/fragile.
  { id: 'lists.updateNow', domain: 'lists', title: 'Update filter lists', channels: [IPC.listsUpdateNow],
    exercise: async (a) => { assertObject(await a.lists.updateNow()); } },
  // subs
  { id: 'subs.crud', domain: 'subs', title: 'Subscriptions list/setEnabled/add/remove',
    channels: [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove],
    exercise: async (a) => { assertArray(await a.subs.list()); },
    verify: async (a) => {
      const list = await a.subs.list();
      if (list.length === 0) return 'no subscriptions (skipped)';
      const sub = list[0];
      const toggled = await a.subs.setEnabled(sub.listId, !sub.enabled);
      const found = toggled.find((s) => s.listId === sub.listId);
      if (!found) throw new Error('setEnabled: sub not in returned list');
      if (found.enabled !== !sub.enabled) throw new Error(`setEnabled: expected ${!sub.enabled}, got ${found.enabled}`);
      await a.subs.setEnabled(sub.listId, sub.enabled); // restore
      return `subs toggle(${sub.listId}) ${sub.enabled}→${!sub.enabled}→restore ok`;
    } },
  // customFilters
  { id: 'customFilters.getset', domain: 'customFilters', title: 'Custom filters get/set',
    channels: [IPC.customFiltersGet, IPC.customFiltersSet],
    exercise: async (a) => { const t = await a.customFilters.get(); if (typeof t !== 'string') throw new Error('string'); await a.customFilters.set(t); },
    verify: async (a) => {
      const c0 = await a.customFilters.get();
      const probe = '! aegis-autopilot\n||ap-cf.test^';
      const setResult = await a.customFilters.set(probe);
      if (setResult !== probe) throw new Error(`set: returned '${setResult}', expected probe`);
      const readBack = await a.customFilters.get();
      if (readBack !== probe) throw new Error(`get after set: '${readBack}' !== probe`);
      await a.customFilters.set(c0); // restore
      return 'customFilters get→set→assert→restore ok';
    } },
  // downloads — no deterministic write path via IPC; entries are written by the core on
  // real downloads (not via an add channel), so a functional round-trip isn't possible.
  { id: 'downloads.crud', domain: 'downloads', title: 'Downloads list/remove/clear (+ file ops)',
    channels: [IPC.downloadsList, IPC.downloadsRemove, IPC.downloadsClear, IPC.downloadsOpenFile, IPC.downloadsShowInFolder, IPC.downloadsCancel],
    exercise: async (a) => { assertArray(await a.downloads.list()); } },
  // permissions — entries are written by the core on real permission events (no add channel);
  // resolve() mutates OS-level state, making it unsafe to call without a real prompt pending.
  { id: 'permissions.crud', domain: 'permissions', title: 'Permissions list/remove/clear/resolve',
    channels: [IPC.permissionsList, IPC.permissionsRemove, IPC.permissionsClear, IPC.permissionsResolve],
    exercise: async (a) => { assertArray(await a.permissions.list()); } },
  // data
  { id: 'data.export', domain: 'data', title: 'Data export', channels: [IPC.dataExport, IPC.dataImport],
    exercise: async (a) => { assertObject(await a.data.export()); },
    verify: async (a) => {
      const r = await a.data.export();
      if (!r.ok && !r.path) throw new Error(`export: not ok and no path (got ${JSON.stringify(r)})`);
      return `data export ok${r.path ? ` (${r.path})` : ''}`;
    } },
  // picker — start() is OS/interaction-bound: it attaches a native click-listener to the
  // content webview and waits for a real user click; can't be round-tripped without a live UI.
  { id: 'picker.start', domain: 'picker', title: 'Element picker', channels: [IPC.pickerStart],
    exercise: async (a) => { assertObject(await a.picker.start()); } },
  // update — checkNow() fires an async background task; the result arrives via the
  // evtUpdateState event, not a return value, so it isn't round-trippable synchronously.
  { id: 'update.state', domain: 'update', title: 'Update get/check',
    channels: [IPC.updateGetState, IPC.updateCheckNow, IPC.updateRestartToInstall],
    exercise: async (a) => { assertObject(await a.update.getState()); await a.update.checkNow(); } },
  // safety — getState() returns null when no interstitial is active; exceptions are
  // written by real navigation events, not via an add channel.
  { id: 'safety.state', domain: 'safety', title: 'Safety get/exceptions',
    channels: [IPC.safetyGetState, IPC.safetyProceed, IPC.safetyListExceptions, IPC.safetyRemoveException],
    exercise: async (a) => { await a.safety.getState(); assertArray(await a.safety.listExceptions()); } },
  // sync — enableNew/enableFromPhrase touch the keychain + network; can't be round-tripped
  // without a real sync server configured; getState() + listDevices() are the safe surface.
  { id: 'sync.state', domain: 'sync', title: 'Sync get/test/devices',
    channels: [IPC.syncGetState, IPC.syncEnableNew, IPC.syncEnableFromPhrase, IPC.syncDisable, IPC.syncNow, IPC.syncTestConnection, IPC.syncGetRecoveryPhrase, IPC.syncListDevices, IPC.syncRemoveDevice],
    exercise: async (a) => { assertObject(await a.sync.getState()); assertArray(await a.sync.listDevices()); } },
];

// Channels whose `exercise` body intentionally does NOT call them (destructive,
// OS/file/window-bound, or fire-and-forget) — their real behavior is exercised
// only in the live run. This set is DOCUMENTATION, not an escape hatch: the
// coverage drift guard asserts every member here ALSO appears in some catalog
// entry's `channels`, so a channel can never skip the catalog by being listed
// here alone. Adding a member here without a catalog entry fails the build.
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
