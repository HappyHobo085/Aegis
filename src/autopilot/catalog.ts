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
  {
    id: 'nav.getState',
    domain: 'nav',
    title: 'Get nav state',
    channels: [IPC.navGetState],
    exercise: async (a) => {
      assertObject(await a.nav.getState(V));
    },
  },
  {
    id: 'nav.navigate',
    domain: 'nav',
    title: 'Navigate',
    channels: [IPC.navNavigate],
    exercise: async (a) => {
      await a.nav.navigate(V, 'https://example.com/');
    },
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
      if (!url.includes('example.com'))
        throw new Error(`navigate: url '${url}' never contained 'example.com'`);
      return `nav navigate→poll ok (url=${url})`;
    },
  },
  {
    id: 'nav.controls',
    domain: 'nav',
    title: 'Back/forward/reload/home',
    channels: [IPC.navBack, IPC.navForward, IPC.navReloadOrStop, IPC.navHome],
    exercise: async (a) => {
      await a.nav.back(V);
      await a.nav.forward(V);
      await a.nav.reloadOrStop(V);
      await a.nav.home(V);
    },
  },
  // tabs
  {
    id: 'tabs.list',
    domain: 'tabs',
    title: 'List tabs',
    channels: [IPC.tabsList],
    exercise: async (a) => {
      assertObject(await a.tabs.list());
    },
  },
  {
    id: 'tabs.lifecycle',
    domain: 'tabs',
    title: 'Create/activate/close/reopen',
    channels: [
      IPC.tabsCreate,
      IPC.tabsActivate,
      IPC.tabsClose,
      IPC.tabsReopenClosed,
      IPC.tabsReorder,
      IPC.tabsSetPinned,
      IPC.tabsSetTitle,
    ],
    exercise: async (a) => {
      assertObject(await a.tabs.create('https://example.org/', true));
      await a.tabs.reorder([V]);
      await a.tabs.setPinned(V, true);
      await a.tabs.setPinned(V, false);
      await a.tabs.setTitle(V, 'AP');
      await a.tabs.activate(V);
      await a.tabs.reopenClosed();
    },
    verify: async (a) => {
      const before = await a.tabs.list();
      const beforeIds = new Set(before.tabs.map((t) => t.id));
      const created = await a.tabs.create('https://ap-tab.test/', true);
      const newTab = created.tabs.find((t) => !beforeIds.has(t.id));
      if (!newTab) throw new Error('create: no new tab id in returned state');
      const afterClose = await a.tabs.close(newTab.id);
      if (afterClose.tabs.some((t) => t.id === newTab.id))
        throw new Error('close: new tab still in list');

      // PRIVATE TAB: browsing in it must leave NO history row.
      const probe = `https://ap-private-${Date.now()}.test/`;
      const privCreated = await a.tabs.create(probe, false, true);
      const pid = privCreated.tabs.find((t) => t.private)?.id;
      if (pid === undefined) throw new Error('private: created tab not marked private in state');
      // Navigate the private tab and give the (skipped) history write a chance to (not) happen.
      await a.nav.navigate(pid, probe);
      await new Promise((r) => setTimeout(r, 1500));
      const hits = (await a.history.search(probe)).length;
      await a.tabs.close(pid);
      if (hits !== 0)
        throw new Error(`private: navigation left ${hits} history row(s) for ${probe}`);

      return `tabs create(bg)→assert→close ok (newId=${newTab.id}); private-leaves-no-history ok (privId=${pid})`;
    },
  },
  // view — overlay/visibility calls are pure layout side-effects on the native webview stack;
  // there is no readable state to assert after the call without a screenshot.
  {
    id: 'view.layout',
    domain: 'view',
    title: 'Content visibility/inset/overlay/sidebar/layout/fullscreen',
    channels: [
      IPC.viewSetContentVisible,
      IPC.viewSetContentInset,
      IPC.viewSetChromeOverlay,
      IPC.viewSetSidebar,
      IPC.viewSetLayout,
      IPC.viewSetFullscreen,
    ],
    exercise: async (a) => {
      await a.view.setContentVisible(V, true);
      await a.view.setContentInset(V, { top: 0, left: 0 });
      await a.view.setChromeOverlay(V, false);
      await a.view.setSidebar?.(V, false, 280);
      await a.view.setLayout?.(V, { overlay: false, sidebar: false, width: 280 });
      await a.view.setFullscreen(V, false);
    },
  },
  // favorites
  {
    id: 'favorites.crud',
    domain: 'favorites',
    title: 'Favorites list/add/update/remove/reorder',
    channels: [
      IPC.favoritesList,
      IPC.favoritesAdd,
      IPC.favoritesUpdate,
      IPC.favoritesRemove,
      IPC.favoritesReorder,
    ],
    exercise: async (a) => {
      assertArray(await a.favorites.list());
      assertArray(await a.favorites.add({ name: 'AP', url: 'https://ap.test/' }));
      assertArray(await a.favorites.reorder([]));
    },
    verify: async (a) => {
      const u1 = 'https://ap-fav1.test/',
        u2 = 'https://ap-fav2.test/';
      await a.favorites.add({ name: 'AP-fav1', url: u1 });
      const added = await a.favorites.add({ name: 'AP-fav2', url: u2 });
      const f1 = added.find((f) => f.url === u1),
        f2 = added.find((f) => f.url === u2);
      if (!f1 || !f2) throw new Error('add: both probe favorites not present');
      // update (rename) f1
      const renamed = await a.favorites.update(f1.id, { name: 'AP-fav1-renamed' });
      if (renamed.find((f) => f.id === f1.id)?.name !== 'AP-fav1-renamed')
        throw new Error('update: name not changed');
      // reorder: put f2 before f1 (reorder assigns position 0,1,2… in requested order)
      const others = renamed.filter((f) => f.id !== f1.id && f.id !== f2.id).map((f) => f.id);
      const reordered = await a.favorites.reorder([f2.id, f1.id, ...others]);
      const pos = (id: number) => reordered.find((f) => f.id === id)?.position;
      const p2 = pos(f2.id),
        p1 = pos(f1.id);
      if (p2 === undefined || p1 === undefined || p2 >= p1)
        throw new Error(`reorder: expected f2 before f1 (positions ${p2}, ${p1})`);
      // remove both probes
      await a.favorites.remove(f1.id);
      const afterRemove = await a.favorites.remove(f2.id);
      if (afterRemove.some((f) => f.url === u1 || f.url === u2))
        throw new Error('remove: a probe favorite survived');
      return 'favorite add×2→update(rename)→reorder→remove×2 ok';
    },
  },
  // history — entries are written by the core on real navigation (no direct add channel),
  // so the live verify navigates for real, then deletes (remove + clear; safe on the
  // disposable profile). exercise stays a read-only probe for the mock-based tour.
  {
    id: 'history.crud',
    domain: 'history',
    title: 'History list/search/remove/clear',
    channels: [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear],
    exercise: async (a) => {
      assertArray(await a.history.list({}));
      assertArray(await a.history.search('a'));
    },
    verify: async (a) => {
      // A real navigation records a history entry (on the title-changed signal). Poll until
      // it appears (proving recording fired), then delete that entry and assert it's gone.
      await a.nav.navigate(V, 'https://example.com/');
      let entry: { id: number; url: string } | undefined;
      const deadline = Date.now() + 8000;
      while (Date.now() < deadline) {
        entry = (await a.history.list({})).find((h) => h.url.includes('example.com'));
        if (entry) break;
        await new Promise((r) => setTimeout(r, 400));
      }
      if (!entry) throw new Error('history: no entry appeared after navigating example.com');
      const id = entry.id;
      await a.history.remove(id); // returns void → re-list to assert
      if ((await a.history.list({})).some((h) => h.id === id))
        throw new Error('remove: entry still present');
      // clear all — the title-changed that created our entry has already fired (it's why the
      // entry appeared), so no late write races this; disposable profile makes it safe.
      await a.history.clear();
      const afterClear = await a.history.list({});
      if (afterClear.length !== 0)
        throw new Error(`clear: expected empty history, got ${afterClear.length}`);
      return 'history navigate→list→remove→clear ok';
    },
  },
  // saved
  {
    id: 'saved.crud',
    domain: 'saved',
    title: 'Saved list/add/remove/has/update/tags',
    channels: [
      IPC.savedList,
      IPC.savedAdd,
      IPC.savedRemove,
      IPC.savedHas,
      IPC.savedUpdate,
      IPC.savedRenameTag,
      IPC.savedDeleteTag,
      IPC.savedTagUnion,
    ],
    exercise: async (a) => {
      assertArray(await a.saved.list());
      assertArray(await a.saved.add({ url: 'https://s.test/', title: 'S', tags: ['t'] }));
      await a.saved.has('https://s.test/');
      assertArray(await a.saved.tagUnion());
    },
    verify: async (a) => {
      const probeUrl = 'https://ap-saved.test/';
      // add with two (uniquely-named, collision-proof) tags
      await a.saved.add({ url: probeUrl, title: 'AP', tags: ['ap-tagA', 'ap-tagB'] });
      if (!(await a.saved.has(probeUrl))) throw new Error('has: expected true after add');
      let item = (await a.saved.list()).find((i) => i.url === probeUrl);
      if (!item) throw new Error('list: probe url not found');
      if (!item.tags.includes('ap-tagA') || !item.tags.includes('ap-tagB'))
        throw new Error('add: tags not stored');
      const id = item.id;
      // update tags: drop ap-tagA, add ap-tagC (update replaces the tags array)
      item = (await a.saved.update(id, { tags: ['ap-tagB', 'ap-tagC'] })).find((i) => i.id === id);
      if (!item || item.tags.includes('ap-tagA') || !item.tags.includes('ap-tagC'))
        throw new Error('update: tags not replaced');
      // rename tag ap-tagB → ap-tagB2 (global across saved items)
      item = (await a.saved.renameTag('ap-tagB', 'ap-tagB2')).find((i) => i.id === id);
      if (!item || item.tags.includes('ap-tagB') || !item.tags.includes('ap-tagB2'))
        throw new Error('renameTag: tag not renamed');
      // tagUnion reflects the renamed + added tags
      const union = await a.saved.tagUnion();
      if (!union.includes('ap-tagB2') || !union.includes('ap-tagC'))
        throw new Error('tagUnion: expected tags missing');
      // delete tag ap-tagC (global)
      item = (await a.saved.deleteTag('ap-tagC')).find((i) => i.id === id);
      if (!item || item.tags.includes('ap-tagC')) throw new Error('deleteTag: tag not removed');
      // remove the item
      await a.saved.remove(id);
      if (await a.saved.has(probeUrl)) throw new Error('has: expected false after remove');
      return 'saved add(tags)→update→renameTag→tagUnion→deleteTag→remove ok';
    },
  },
  // settings
  {
    id: 'settings.getset',
    domain: 'settings',
    title: 'Settings get/set',
    channels: [IPC.settingsGet, IPC.settingsSet],
    exercise: async (a) => {
      const s = await a.settings.get();
      assertObject(s);
      assertObject(await a.settings.set({ primaryColor: s.primaryColor }));
    },
    verify: async (a) => {
      const original = await a.settings.get();
      const probe = '#abcdef';
      const after = await a.settings.set({ primaryColor: probe });
      if (after.primaryColor !== probe)
        throw new Error(`set: expected '${probe}', got '${after.primaryColor}'`);
      const restored = await a.settings.set({ primaryColor: original.primaryColor });
      if (restored.primaryColor !== original.primaryColor)
        throw new Error('restore: primaryColor mismatch');
      return 'settings get→set→assert→restore ok';
    },
  },
  // adblock
  {
    id: 'adblock.toggle',
    domain: 'adblock',
    title: 'Ad-block enable/allowlist/state',
    channels: [
      IPC.adblockSetEnabled,
      IPC.adblockToggleAllowlist,
      IPC.adblockRemoveAllowlist,
      IPC.adblockClearAllowlist,
      IPC.adblockGetState,
    ],
    exercise: async (a) => {
      assertObject(await a.adblock.getState());
      assertObject(await a.adblock.setEnabled(true));
      assertObject(await a.adblock.toggleAllowlist('ap.test'));
      assertObject(await a.adblock.removeAllowlist('ap.test'));
      assertObject(await a.adblock.clearAllowlist());
    },
    verify: async (a) => {
      const h1 = 'ap-allow1.test',
        h2 = 'ap-allow2.test';
      const off = await a.adblock.setEnabled(false);
      if (off.enabled !== false) throw new Error('setEnabled(false): still enabled');
      const on = await a.adblock.setEnabled(true);
      if (on.enabled !== true) throw new Error('setEnabled(true): not enabled');
      await a.adblock.toggleAllowlist(h1);
      const toggled = await a.adblock.toggleAllowlist(h2);
      if (!toggled.allowlistedHosts.includes(h1) || !toggled.allowlistedHosts.includes(h2))
        throw new Error('toggleAllowlist: both hosts not present');
      const removed = await a.adblock.removeAllowlist(h1);
      if (removed.allowlistedHosts.includes(h1))
        throw new Error('removeAllowlist: host still present');
      if (!removed.allowlistedHosts.includes(h2))
        throw new Error('removeAllowlist: removed the wrong host');
      const cleared = await a.adblock.clearAllowlist();
      if (cleared.allowlistedHosts.length !== 0)
        throw new Error(`clearAllowlist: expected empty, got ${cleared.allowlistedHosts.length}`);
      return 'adblock setEnabled off→on→allowlist add×2→remove→clear ok';
    },
  },
  // lists — triggering a real network fetch in a verify round-trip is too slow/fragile.
  {
    id: 'lists.updateNow',
    domain: 'lists',
    title: 'Update filter lists',
    channels: [IPC.listsUpdateNow],
    exercise: async (a) => {
      assertObject(await a.lists.updateNow());
    },
  },
  // subs
  {
    id: 'subs.crud',
    domain: 'subs',
    title: 'Subscriptions list/setEnabled/add/remove',
    channels: [IPC.subsList, IPC.subsSetEnabled, IPC.subsAdd, IPC.subsRemove],
    exercise: async (a) => {
      assertArray(await a.subs.list());
    },
    verify: async (a) => {
      const list = await a.subs.list();
      if (list.length === 0) return 'no subscriptions (skipped)';
      const sub = list[0];
      const toggled = await a.subs.setEnabled(sub.listId, !sub.enabled);
      const found = toggled.find((s) => s.listId === sub.listId);
      if (!found) throw new Error('setEnabled: sub not in returned list');
      if (found.enabled !== !sub.enabled)
        throw new Error(`setEnabled: expected ${!sub.enabled}, got ${found.enabled}`);
      await a.subs.setEnabled(sub.listId, sub.enabled); // restore
      return `subs toggle(${sub.listId}) ${sub.enabled}→${!sub.enabled}→restore ok`;
    },
  },
  // customFilters
  {
    id: 'customFilters.getset',
    domain: 'customFilters',
    title: 'Custom filters get/set',
    channels: [IPC.customFiltersGet, IPC.customFiltersSet],
    exercise: async (a) => {
      const t = await a.customFilters.get();
      if (typeof t !== 'string') throw new Error('string');
      await a.customFilters.set(t);
    },
    verify: async (a) => {
      const c0 = await a.customFilters.get();
      const probe = '! aegis-autopilot\n||ap-cf.test^';
      const setResult = await a.customFilters.set(probe);
      if (setResult !== probe) throw new Error(`set: returned '${setResult}', expected probe`);
      const readBack = await a.customFilters.get();
      if (readBack !== probe) throw new Error(`get after set: '${readBack}' !== probe`);
      await a.customFilters.set(c0); // restore
      return 'customFilters get→set→assert→restore ok';
    },
  },
  // downloads — no deterministic write path via IPC; entries are written by the core on
  // real downloads (not via an add channel), so a functional round-trip isn't possible.
  {
    id: 'downloads.crud',
    domain: 'downloads',
    title: 'Downloads list/remove/clear (+ file ops)',
    channels: [
      IPC.downloadsList,
      IPC.downloadsRemove,
      IPC.downloadsClear,
      IPC.downloadsOpenFile,
      IPC.downloadsShowInFolder,
      IPC.downloadsCancel,
    ],
    exercise: async (a) => {
      assertArray(await a.downloads.list());
    },
  },
  // permissions — entries are written by the core on real permission events (no add channel);
  // resolve() mutates OS-level state, making it unsafe to call without a real prompt pending.
  {
    id: 'permissions.crud',
    domain: 'permissions',
    title: 'Permissions list/remove/clear/resolve',
    channels: [
      IPC.permissionsList,
      IPC.permissionsRemove,
      IPC.permissionsClear,
      IPC.permissionsResolve,
    ],
    exercise: async (a) => {
      assertArray(await a.permissions.list());
    },
  },
  // data
  {
    id: 'data.export',
    domain: 'data',
    title: 'Data export',
    channels: [IPC.dataExport, IPC.dataImport],
    exercise: async (a) => {
      assertObject(await a.data.export());
    },
    verify: async (a) => {
      const r = await a.data.export();
      if (!r.ok && !r.path)
        throw new Error(`export: not ok and no path (got ${JSON.stringify(r)})`);
      return `data export ok${r.path ? ` (${r.path})` : ''}`;
    },
  },
  // picker — start() is OS/interaction-bound: it attaches a native click-listener to the
  // content webview and waits for a real user click; can't be round-tripped without a live UI.
  {
    id: 'picker.start',
    domain: 'picker',
    title: 'Element picker',
    channels: [IPC.pickerStart],
    exercise: async (a) => {
      assertObject(await a.picker.start());
    },
  },
  // update — checkNow() fires an async background task; the result arrives via the
  // evtUpdateState event, not a return value, so it isn't round-trippable synchronously.
  {
    id: 'update.state',
    domain: 'update',
    title: 'Update get/check',
    channels: [IPC.updateGetState, IPC.updateCheckNow, IPC.updateRestartToInstall],
    exercise: async (a) => {
      assertObject(await a.update.getState());
      await a.update.checkNow();
    },
  },
  // safety — getState() returns null when no interstitial is active; exceptions are
  // written by real navigation events, not via an add channel.
  {
    id: 'safety.state',
    domain: 'safety',
    title: 'Safety get/exceptions',
    channels: [
      IPC.safetyGetState,
      IPC.safetyProceed,
      IPC.safetyListExceptions,
      IPC.safetyRemoveException,
    ],
    exercise: async (a) => {
      await a.safety.getState();
      assertArray(await a.safety.listExceptions());
    },
  },
  // sync — enableNew/enableFromPhrase touch the keychain + network; can't be round-tripped
  // without a real sync server configured; getState() + listDevices() are the safe surface.
  {
    id: 'sync.state',
    domain: 'sync',
    title: 'Sync get/test/devices',
    channels: [
      IPC.syncGetState,
      IPC.syncEnableNew,
      IPC.syncEnableFromPhrase,
      IPC.syncDisable,
      IPC.syncNow,
      IPC.syncTestConnection,
      IPC.syncGetRecoveryPhrase,
      IPC.syncListDevices,
      IPC.syncRemoveDevice,
    ],
    exercise: async (a) => {
      assertObject(await a.sync.getState());
      assertArray(await a.sync.listDevices());
    },
  },
  // zoom (page zoom — session-only per tab)
  {
    id: 'zoom',
    domain: 'zoom',
    title: 'Page zoom',
    channels: [IPC.zoomGet, IPC.zoomSet, IPC.zoomReset],
    exercise: async (a) => {
      assertObject(await a.zoom.get(V));
      assertObject(await a.zoom.set(V, 1.25));
      assertObject(await a.zoom.reset(V));
    },
    verify: async (a) => {
      const before = (await a.zoom.get(V)).factor;
      const set = await a.zoom.set(V, 1.5);
      if (Math.abs(set.factor - 1.5) > 1e-6)
        throw new Error(`zoom.set: expected 1.5, got ${set.factor}`);
      const got = await a.zoom.get(V);
      if (Math.abs(got.factor - 1.5) > 1e-6)
        throw new Error(`zoom.get after set: expected 1.5, got ${got.factor}`);
      const clamped = await a.zoom.set(V, 99); // clamp check
      if (clamped.factor !== 3.0)
        throw new Error(`zoom.set clamp: expected 3.0, got ${clamped.factor}`);
      const reset = await a.zoom.reset(V);
      if (reset.factor !== 1.0) throw new Error(`zoom.reset: expected 1.0, got ${reset.factor}`);
      await a.zoom.set(V, before); // restore
      return 'zoom set→get→clamp→reset→restore ok';
    },
  },
  // find-in-page
  {
    id: 'find',
    domain: 'find',
    title: 'Find in page',
    channels: [IPC.findStart, IPC.findNext, IPC.findPrev, IPC.findClose],
    exercise: async (a) => {
      await a.find.start(V, 'test');
      await a.find.next(V);
      await a.find.prev(V);
      await a.find.close(V);
    },
    // find mutates webview search state; the live round-trip navigates to a page with
    // known text, subscribes to find.state, starts a search, waits for the first match
    // event, then closes.  Runs ONLY in the live run (RunDeps.live) — skipped by vitest
    // mock (aegis.find.onState is a vi.fn that never invokes the callback).
    verify: async (a) => {
      await a.nav.navigate(V, 'https://example.com/');
      // example.com contains the word "Example". Subscribe BEFORE searching so we don't
      // race the event.
      let got: { matchCount: number } | null = null;
      const off = a.find.onState((s) => {
        if (s.viewId === V) got = s;
      });
      const deadline = Date.now() + 8000;
      await a.find.start(V, 'Example');
      while (Date.now() < deadline && got === null) await new Promise((r) => setTimeout(r, 300));
      off();
      await a.find.close(V);
      if (got === null) throw new Error('find: no find.state event after start');
      return `find start→state(matchCount=${(got as { matchCount: number }).matchCount})→close ok`;
    },
  },
];

// Channels whose `exercise` body intentionally does NOT call them (destructive,
// OS/file/window-bound, or fire-and-forget). Many of these ARE round-tripped by the
// live `verify()` functions (which run only in the live run, on a disposable profile,
// so deletes are safe): favorites update/remove/reorder, saved update/renameTag/
// deleteTag/remove, history remove/clear, subs setEnabled. The remainder genuinely
// can't be round-tripped without real OS/file/network/interaction state (a real
// download, permission prompt, malware interstitial, sync server, or app restart) and
// stay live-/manual-only. This set is DOCUMENTATION, not an escape hatch: the coverage
// drift guard asserts every member here ALSO appears in some catalog entry's `channels`,
// so a channel can never skip the catalog by being listed here alone.
export const UNTESTED_CHANNELS = new Set<string>([
  // file/OS-bound — exercised live only, would mutate the host in vitest:
  IPC.downloadsOpenFile,
  IPC.downloadsShowInFolder,
  IPC.downloadsCancel,
  IPC.dataImport,
  IPC.permissionsResolve,
  IPC.safetyProceed,
  IPC.updateRestartToInstall,
  IPC.permissionsRemove,
  IPC.permissionsClear,
  IPC.safetyRemoveException,
  IPC.historyRemove,
  IPC.historyClear,
  IPC.favoritesUpdate,
  IPC.favoritesRemove,
  IPC.savedRemove,
  IPC.savedUpdate,
  IPC.savedRenameTag,
  IPC.savedDeleteTag,
  IPC.subsSetEnabled,
  IPC.subsAdd,
  IPC.subsRemove,
  IPC.syncEnableNew,
  IPC.syncEnableFromPhrase,
  IPC.syncDisable,
  IPC.syncNow,
  IPC.syncTestConnection,
  IPC.syncGetRecoveryPhrase,
  IPC.syncRemoveDevice,
]);
