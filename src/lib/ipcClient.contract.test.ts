// src/lib/ipcClient.contract.test.ts
//
// THE LAST HOP, which nothing else in this repo asserts.
//
// Every other test file swaps the whole `aegis` object out for
// `src/testFixtures/aegisMock.ts`, so 100% of the component suite exercises the
// REACT half of the seam and none of it exercises the half that decides what the Rust
// core actually receives: `aegis.<ns>.<method>(…)` -> `invoke('ipc', { channel, payload })`.
// A component test can therefore assert "the Back button called `nav.back`" while the
// module sends `nav.forward` (a copy-paste slip), wraps the id under the wrong key, or
// drops an argument — and the whole suite stays green, because the mock is the thing
// under assertion.
//
// `shared/ipcCatalog.drift.test.ts` guards the OUTER two hops (catalog <-> Rust, and
// that every `evt*` is subscribed somewhere in `src/`). This file guards the INNER one,
// and it does so by driving the real module: `@tauri-apps/api/core` and
// `@tauri-apps/api/event` are the only things mocked, so the real `aegis` object, the
// real `call()`/`dedupedCall()` dedup, the real `on()` dot->colon translation and the
// real Android bridge switch all run.
//
// Assertions use `toStrictEqual` on the captured invoke arguments, NOT
// `toHaveBeenCalledWith`. The latter has `toEqual` semantics, under which
// `{ opts: undefined }` and `{}` compare EQUAL — and `history.list()` genuinely sends
// `{ opts: undefined }` and `aegis.zoom.set` genuinely sends a 5-key object. Those exact
// wire shapes are the contract; a loose comparison would let them drift silently.
// (A BARE ARRAY payload used to be the third case, `split.enter`; that channel is gone, so
// no request channel sends a non-object payload any more.)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn().mockResolvedValue({ ok: false }),
}));
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  IPC,
  type ContentInset,
  type ProxyConfig,
  type VaultRecordInput,
} from '../../shared/types';
import { aegis, setBackInterceptActive, setFullscreen, setBottomBarHidden } from './ipcClient';

const mockInvoke = invoke as ReturnType<typeof vi.fn>;
const mockListen = listen as ReturnType<typeof vi.fn>;

const win = window as unknown as Record<string, unknown>;

/** Representative non-empty values, so a dropped argument cannot hide behind a default. */
const INSET: ContentInset = { top: 12, left: 4 };
const CFG: ProxyConfig = {
  mode: 'proxy',
  scheme: 'http',
  host: 'proxy.test',
  port: 8080,
  bypassHosts: ['localhost', 'tauri.localhost'],
};
const REC: VaultRecordInput = { site: 'https://site.test', username: 'u', password: 'p' };

// ---------------------------------------------------------------------------
// 1. Requests: aegis method -> invoke('ipc', { channel, payload })
// ---------------------------------------------------------------------------

interface ContractRow {
  /** `namespace.method`, for the test name. */
  name: string;
  run: () => Promise<unknown>;
  channel: string;
  payload: unknown;
}

const REQUESTS: ContractRow[] = [
  // ---- nav (5 requests + getState) ----
  {
    name: 'nav.navigate',
    run: () => aegis.nav.navigate(1, 'https://a.test/'),
    channel: IPC.navNavigate,
    payload: { viewId: 1, url: 'https://a.test/' },
  },
  { name: 'nav.back', run: () => aegis.nav.back(1), channel: IPC.navBack, payload: { viewId: 1 } },
  {
    name: 'nav.forward',
    run: () => aegis.nav.forward(1),
    channel: IPC.navForward,
    payload: { viewId: 1 },
  },
  {
    name: 'nav.reloadOrStop',
    run: () => aegis.nav.reloadOrStop(1),
    channel: IPC.navReloadOrStop,
    payload: { viewId: 1 },
  },
  { name: 'nav.home', run: () => aegis.nav.home(1), channel: IPC.navHome, payload: { viewId: 1 } },
  {
    name: 'nav.getState',
    run: () => aegis.nav.getState(1),
    channel: IPC.navGetState,
    payload: { viewId: 1 },
  },

  // ---- tabs (9) ----
  { name: 'tabs.list', run: () => aegis.tabs.list(), channel: IPC.tabsList, payload: {} },
  // `private` is the RENAMED key: the method arg is `isPrivate`. Pin it.
  {
    name: 'tabs.create',
    run: () => aegis.tabs.create('https://b.test/', true, true),
    channel: IPC.tabsCreate,
    payload: { url: 'https://b.test/', background: true, private: true },
  },
  {
    name: 'tabs.create (bare)',
    run: () => aegis.tabs.create(),
    channel: IPC.tabsCreate,
    payload: { url: undefined, background: undefined, private: undefined },
  },
  {
    name: 'tabs.close',
    run: () => aegis.tabs.close(2),
    channel: IPC.tabsClose,
    payload: { id: 2 },
  },
  {
    name: 'tabs.activate',
    run: () => aegis.tabs.activate(2),
    channel: IPC.tabsActivate,
    payload: { id: 2 },
  },
  {
    name: 'tabs.reorder',
    run: () => aegis.tabs.reorder([3, 1, 2]),
    channel: IPC.tabsReorder,
    payload: { ids: [3, 1, 2] },
  },
  {
    name: 'tabs.setPinned',
    run: () => aegis.tabs.setPinned(2, true),
    channel: IPC.tabsSetPinned,
    payload: { id: 2, pinned: true },
  },
  {
    name: 'tabs.reopenClosed',
    run: () => aegis.tabs.reopenClosed(),
    channel: IPC.tabsReopenClosed,
    payload: {},
  },
  {
    name: 'tabs.setTitle',
    run: () => aegis.tabs.setTitle(2, 'Title'),
    channel: IPC.tabsSetTitle,
    payload: { id: 2, title: 'Title' },
  },
  {
    name: 'tabs.recordNav',
    run: () => aegis.tabs.recordNav(2, 'https://b.test/', 'T'),
    channel: IPC.tabsRecordNav,
    payload: { id: 2, url: 'https://b.test/', title: 'T' },
  },

  // ---- view (6) ----
  {
    name: 'view.setContentVisible',
    run: () => aegis.view.setContentVisible(1, true),
    channel: IPC.viewSetContentVisible,
    payload: { viewId: 1, visible: true },
  },
  {
    name: 'view.setContentInset',
    run: () => aegis.view.setContentInset(1, INSET),
    channel: IPC.viewSetContentInset,
    payload: { viewId: 1, inset: INSET },
  },
  {
    name: 'view.setChromeOverlay',
    run: () => aegis.view.setChromeOverlay(1, false),
    channel: IPC.viewSetChromeOverlay,
    payload: { viewId: 1, active: false },
  },
  {
    name: 'view.setSidebar',
    run: async () => void (await aegis.view.setSidebar?.(1, true, 320)),
    channel: IPC.viewSetSidebar,
    payload: { viewId: 1, active: true, width: 320 },
  },
  {
    name: 'view.setLayout',
    run: async () =>
      void (await aegis.view.setLayout?.(1, { overlay: true, sidebar: false, width: 200 })),
    channel: IPC.viewSetLayout,
    payload: { viewId: 1, overlay: true, sidebar: false, width: 200 },
  },
  {
    name: 'view.setFullscreen',
    run: () => aegis.view.setFullscreen(1, true),
    channel: IPC.viewSetFullscreen,
    payload: { viewId: 1, on: true },
  },

  // ---- favorites (5) ----
  {
    name: 'favorites.list',
    run: () => aegis.favorites.list(),
    channel: IPC.favoritesList,
    payload: {},
  },
  {
    name: 'favorites.add',
    run: () => aegis.favorites.add({ name: 'n', url: 'https://f.test/' }),
    channel: IPC.favoritesAdd,
    payload: { input: { name: 'n', url: 'https://f.test/' } },
  },
  {
    name: 'favorites.update',
    run: () => aegis.favorites.update(7, { name: 'n2' }),
    channel: IPC.favoritesUpdate,
    payload: { id: 7, partial: { name: 'n2' } },
  },
  {
    name: 'favorites.remove',
    run: () => aegis.favorites.remove(7),
    channel: IPC.favoritesRemove,
    payload: { id: 7 },
  },
  {
    name: 'favorites.reorder',
    run: () => aegis.favorites.reorder([3, 1]),
    channel: IPC.favoritesReorder,
    payload: { ids: [3, 1] },
  },

  // ---- history (4) ----
  // `history.list()` with no args really does put an explicit `opts: undefined` in the
  // payload object; only a strict comparison pins that.
  {
    name: 'history.list (bare)',
    run: () => aegis.history.list(),
    channel: IPC.historyList,
    payload: { opts: undefined },
  },
  {
    name: 'history.list (windowed)',
    run: () => aegis.history.list({ limit: 20, offset: 0 }),
    channel: IPC.historyList,
    payload: { opts: { limit: 20, offset: 0 } },
  },
  {
    name: 'history.search',
    run: () => aegis.history.search('needle'),
    channel: IPC.historySearch,
    payload: { q: 'needle' },
  },
  {
    name: 'history.remove',
    run: () => aegis.history.remove(5),
    channel: IPC.historyRemove,
    payload: { id: 5 },
  },
  {
    name: 'history.clear',
    run: () => aegis.history.clear(),
    channel: IPC.historyClear,
    payload: {},
  },

  // ---- saved (8) ----
  { name: 'saved.list', run: () => aegis.saved.list(), channel: IPC.savedList, payload: {} },
  {
    name: 'saved.add',
    run: () => aegis.saved.add({ url: 'https://s.test/', title: 'S', tags: ['t'] }),
    channel: IPC.savedAdd,
    payload: { input: { url: 'https://s.test/', title: 'S', tags: ['t'] } },
  },
  {
    name: 'saved.remove',
    run: () => aegis.saved.remove(9),
    channel: IPC.savedRemove,
    payload: { id: 9 },
  },
  {
    name: 'saved.has',
    run: () => aegis.saved.has('https://s.test/'),
    channel: IPC.savedHas,
    payload: { url: 'https://s.test/' },
  },
  {
    name: 'saved.update',
    run: () => aegis.saved.update(9, { title: 'S2' }),
    channel: IPC.savedUpdate,
    payload: { id: 9, partial: { title: 'S2' } },
  },
  {
    name: 'saved.renameTag',
    run: () => aegis.saved.renameTag('old', 'new'),
    channel: IPC.savedRenameTag,
    payload: { oldT: 'old', newT: 'new' },
  },
  {
    name: 'saved.deleteTag',
    run: () => aegis.saved.deleteTag('old'),
    channel: IPC.savedDeleteTag,
    payload: { tag: 'old' },
  },
  {
    name: 'saved.tagUnion',
    run: () => aegis.saved.tagUnion(),
    channel: IPC.savedTagUnion,
    payload: {},
  },

  // ---- settings (2) ----
  { name: 'settings.get', run: () => aegis.settings.get(), channel: IPC.settingsGet, payload: {} },
  {
    name: 'settings.set',
    run: () => aegis.settings.set({ homeUrl: 'https://home.test/' }),
    channel: IPC.settingsSet,
    payload: { partial: { homeUrl: 'https://home.test/' } },
  },

  // ---- adblock (5) ----
  {
    name: 'adblock.setEnabled',
    run: () => aegis.adblock.setEnabled(false),
    channel: IPC.adblockSetEnabled,
    payload: { enabled: false },
  },
  {
    name: 'adblock.toggleAllowlist',
    run: () => aegis.adblock.toggleAllowlist('ads.test'),
    channel: IPC.adblockToggleAllowlist,
    payload: { host: 'ads.test' },
  },
  {
    name: 'adblock.removeAllowlist',
    run: () => aegis.adblock.removeAllowlist('ads.test'),
    channel: IPC.adblockRemoveAllowlist,
    payload: { host: 'ads.test' },
  },
  {
    name: 'adblock.clearAllowlist',
    run: () => aegis.adblock.clearAllowlist(),
    channel: IPC.adblockClearAllowlist,
    payload: {},
  },
  {
    name: 'adblock.getState',
    run: () => aegis.adblock.getState(),
    channel: IPC.adblockGetState,
    payload: {},
  },

  // ---- lists (1) ----
  {
    name: 'lists.updateNow',
    run: () => aegis.lists.updateNow(),
    channel: IPC.listsUpdateNow,
    payload: {},
  },

  // ---- subs (4) ----
  { name: 'subs.list', run: () => aegis.subs.list(), channel: IPC.subsList, payload: {} },
  {
    name: 'subs.setEnabled',
    run: () => aegis.subs.setEnabled('easylist', false),
    channel: IPC.subsSetEnabled,
    payload: { listId: 'easylist', enabled: false },
  },
  {
    name: 'subs.add',
    run: () => aegis.subs.add('https://list.test/sub.txt'),
    channel: IPC.subsAdd,
    payload: { url: 'https://list.test/sub.txt' },
  },
  {
    name: 'subs.remove',
    run: () => aegis.subs.remove('easylist'),
    channel: IPC.subsRemove,
    payload: { listId: 'easylist' },
  },

  // ---- customFilters (2) ----
  {
    name: 'customFilters.get',
    run: () => aegis.customFilters.get(),
    channel: IPC.customFiltersGet,
    payload: {},
  },
  {
    name: 'customFilters.set',
    run: () => aegis.customFilters.set('||ads.test^'),
    channel: IPC.customFiltersSet,
    payload: { text: '||ads.test^' },
  },

  // ---- downloads (6) ----
  {
    name: 'downloads.list',
    run: () => aegis.downloads.list(),
    channel: IPC.downloadsList,
    payload: {},
  },
  {
    name: 'downloads.remove',
    run: () => aegis.downloads.remove(3),
    channel: IPC.downloadsRemove,
    payload: { id: 3 },
  },
  {
    name: 'downloads.clear',
    run: () => aegis.downloads.clear(),
    channel: IPC.downloadsClear,
    payload: {},
  },
  {
    name: 'downloads.openFile',
    run: () => aegis.downloads.openFile(3),
    channel: IPC.downloadsOpenFile,
    payload: { id: 3 },
  },
  {
    name: 'downloads.showInFolder',
    run: () => aegis.downloads.showInFolder(3),
    channel: IPC.downloadsShowInFolder,
    payload: { id: 3 },
  },
  {
    name: 'downloads.cancel',
    run: () => aegis.downloads.cancel(3),
    channel: IPC.downloadsCancel,
    payload: { id: 3 },
  },

  // ---- permissions (4) ----
  {
    name: 'permissions.list',
    run: () => aegis.permissions.list(),
    channel: IPC.permissionsList,
    payload: {},
  },
  {
    name: 'permissions.remove',
    run: () => aegis.permissions.remove('https://p.test', 'geolocation'),
    channel: IPC.permissionsRemove,
    payload: { origin: 'https://p.test', permission: 'geolocation' },
  },
  {
    name: 'permissions.clear',
    run: () => aegis.permissions.clear(),
    channel: IPC.permissionsClear,
    payload: {},
  },
  {
    name: 'permissions.resolve',
    run: () => aegis.permissions.resolve(11, 'allow-once'),
    channel: IPC.permissionsResolve,
    payload: { requestId: 11, decision: 'allow-once' },
  },

  // ---- data (2) ----
  { name: 'data.export', run: () => aegis.data.export(), channel: IPC.dataExport, payload: {} },
  // The no-text branch and the text branch genuinely differ on the wire.
  {
    name: 'data.import (pasted text)',
    run: () => aegis.data.import('merge', { text: '{"saved":[]}' }),
    channel: IPC.dataImport,
    payload: { mode: 'merge', text: '{"saved":[]}' },
  },
  {
    name: 'data.import (restore from disk)',
    run: () => aegis.data.import('replace'),
    channel: IPC.dataImport,
    payload: { mode: 'replace' },
  },

  // ---- picker (1) ----
  { name: 'picker.start', run: () => aegis.picker.start(), channel: IPC.pickerStart, payload: {} },

  // ---- update (3) ----
  {
    name: 'update.getState',
    run: () => aegis.update.getState(),
    channel: IPC.updateGetState,
    payload: {},
  },
  {
    name: 'update.checkNow',
    run: () => aegis.update.checkNow(),
    channel: IPC.updateCheckNow,
    payload: {},
  },
  {
    name: 'update.restartToInstall',
    run: () => aegis.update.restartToInstall(),
    channel: IPC.updateRestartToInstall,
    payload: {},
  },

  // ---- safety (4) ----
  {
    name: 'safety.getState',
    run: () => aegis.safety.getState(),
    channel: IPC.safetyGetState,
    payload: {},
  },
  {
    name: 'safety.proceed',
    run: () => aegis.safety.proceed('https://s.test/'),
    channel: IPC.safetyProceed,
    payload: { url: 'https://s.test/' },
  },
  {
    name: 'safety.listExceptions',
    run: () => aegis.safety.listExceptions(),
    channel: IPC.safetyListExceptions,
    payload: {},
  },
  {
    name: 'safety.removeException',
    run: () => aegis.safety.removeException('s.test'),
    channel: IPC.safetyRemoveException,
    payload: { host: 's.test' },
  },

  // ---- sync (10) ----
  {
    name: 'sync.getState',
    run: () => aegis.sync.getState(),
    channel: IPC.syncGetState,
    payload: {},
  },
  {
    name: 'sync.enableNew',
    run: () => aegis.sync.enableNew({ passphrase: 'pp' }),
    channel: IPC.syncEnableNew,
    payload: { passphrase: 'pp' },
  },
  {
    name: 'sync.enableNew (core-generated passphrase)',
    run: () => aegis.sync.enableNew(),
    channel: IPC.syncEnableNew,
    payload: {},
  },
  {
    name: 'sync.enableFromPhrase',
    run: () => aegis.sync.enableFromPhrase({ phrase: 'a b c', passphrase: 'pp' }),
    channel: IPC.syncEnableFromPhrase,
    payload: { phrase: 'a b c', passphrase: 'pp' },
  },
  {
    name: 'sync.unlock',
    run: () => aegis.sync.unlock({ passphrase: 'pp' }),
    channel: IPC.syncUnlock,
    payload: { passphrase: 'pp' },
  },
  {
    name: 'sync.disable (forget)',
    run: () => aegis.sync.disable({ forget: true }),
    channel: IPC.syncDisable,
    payload: { forget: true },
  },
  {
    name: 'sync.disable (keep the account)',
    run: () => aegis.sync.disable(),
    channel: IPC.syncDisable,
    payload: {},
  },
  { name: 'sync.syncNow', run: () => aegis.sync.syncNow(), channel: IPC.syncNow, payload: {} },
  {
    name: 'sync.testConnection',
    run: () => aegis.sync.testConnection('https://sync.test/'),
    channel: IPC.syncTestConnection,
    payload: { url: 'https://sync.test/' },
  },
  {
    name: 'sync.getRecoveryPhrase',
    run: () => aegis.sync.getRecoveryPhrase({ confirm: true }),
    channel: IPC.syncGetRecoveryPhrase,
    payload: { confirm: true },
  },
  {
    name: 'sync.listDevices',
    run: () => aegis.sync.listDevices(),
    channel: IPC.syncListDevices,
    payload: {},
  },
  {
    name: 'sync.removeDevice',
    run: () => aegis.sync.removeDevice('dev-1'),
    channel: IPC.syncRemoveDevice,
    payload: { deviceId: 'dev-1' },
  },

  // ---- find (4) ----
  {
    name: 'find.start',
    run: () => aegis.find.start(1, 'needle', true),
    channel: IPC.findStart,
    payload: { viewId: 1, query: 'needle', caseSensitive: true },
  },
  // `caseSensitive` defaults to false and is ALWAYS sent, so pin the default too.
  {
    name: 'find.start (default caseSensitive)',
    run: () => aegis.find.start(1, 'needle2'),
    channel: IPC.findStart,
    payload: { viewId: 1, query: 'needle2', caseSensitive: false },
  },
  {
    name: 'find.next',
    run: () => aegis.find.next(1),
    channel: IPC.findNext,
    payload: { viewId: 1 },
  },
  {
    name: 'find.prev',
    run: () => aegis.find.prev(1),
    channel: IPC.findPrev,
    payload: { viewId: 1 },
  },
  {
    name: 'find.close',
    run: () => aegis.find.close(1),
    channel: IPC.findClose,
    payload: { viewId: 1 },
  },

  // ---- zoom (2) ----
  { name: 'zoom.get', run: () => aegis.zoom.get(1), channel: IPC.zoomGet, payload: { viewId: 1 } },
  {
    name: 'zoom.set',
    run: () => aegis.zoom.set(1, 1.75),
    channel: IPC.zoomSet,
    payload: { viewId: 1, factor: 1.75 },
  },
  // `reset` deliberately has NO channel of its own on the renderer side: it delegates to
  // `set` so the clamp lives in exactly one place. The `zoom.reset` Rust arm still exists.
  {
    name: 'zoom.reset (delegates to zoom.set)',
    run: () => aegis.zoom.reset(1),
    channel: IPC.zoomSet,
    payload: { viewId: 1, factor: 1.0 },
  },

  // ---- vault (11) ----
  {
    name: 'vault.getState',
    run: () => aegis.vault.getState(),
    channel: IPC.vaultGetState,
    payload: {},
  },
  {
    name: 'vault.create',
    run: () => aegis.vault.create('master'),
    channel: IPC.vaultCreate,
    payload: { masterPassword: 'master' },
  },
  {
    name: 'vault.unlock',
    run: () => aegis.vault.unlock('master'),
    channel: IPC.vaultUnlock,
    payload: { masterPassword: 'master' },
  },
  { name: 'vault.lock', run: () => aegis.vault.lock(), channel: IPC.vaultLock, payload: {} },
  { name: 'vault.list', run: () => aegis.vault.list(), channel: IPC.vaultList, payload: {} },
  {
    name: 'vault.add',
    run: () => aegis.vault.add(REC),
    channel: IPC.vaultAdd,
    payload: { input: REC },
  },
  {
    name: 'vault.update',
    run: () => aegis.vault.update('uuid-1', { password: 'p2' }),
    channel: IPC.vaultUpdate,
    payload: { uuid: 'uuid-1', partial: { password: 'p2' } },
  },
  {
    name: 'vault.remove',
    run: () => aegis.vault.remove('uuid-1'),
    channel: IPC.vaultRemove,
    payload: { uuid: 'uuid-1' },
  },
  {
    name: 'vault.search',
    run: () => aegis.vault.search('site'),
    channel: IPC.vaultSearch,
    payload: { q: 'site' },
  },
  // `autofill` passes its options object as the payload DIRECTLY — no `input`/`options`
  // wrapper, unlike every other vault method. That asymmetry is the contract.
  {
    name: 'vault.autofill',
    run: () => aegis.vault.autofill({ domain: 'site.test', username: 'u' }),
    channel: IPC.vaultAutofill,
    payload: { domain: 'site.test', username: 'u' },
  },
  {
    name: 'vault.autofillSuggestions',
    run: () => aegis.vault.autofillSuggestions('site.test'),
    channel: IPC.vaultAutofillSuggestions,
    payload: { domain: 'site.test' },
  },

  // ---- fingerprint (4) ----
  {
    name: 'fingerprint.getState',
    run: () => aegis.fingerprint.getState(),
    channel: IPC.fingerprintGetState,
    payload: {},
  },
  {
    name: 'fingerprint.toggleAllowlist',
    run: () => aegis.fingerprint.toggleAllowlist('fp.test'),
    channel: IPC.fingerprintToggleAllowlist,
    payload: { host: 'fp.test' },
  },
  {
    name: 'fingerprint.removeAllowlist',
    run: () => aegis.fingerprint.removeAllowlist('fp.test'),
    channel: IPC.fingerprintRemoveAllowlist,
    payload: { host: 'fp.test' },
  },
  {
    name: 'fingerprint.clearAllowlist',
    run: () => aegis.fingerprint.clearAllowlist(),
    channel: IPC.fingerprintClearAllowlist,
    payload: {},
  },

  // ---- webrtc exemption (4) ----
  {
    name: 'webrtc.getExemptHosts',
    run: () => aegis.webrtc.getExemptHosts(),
    channel: IPC.webrtcGetExemptHosts,
    payload: {},
  },
  {
    name: 'webrtc.toggleExempt',
    run: () => aegis.webrtc.toggleExempt('wr.test'),
    channel: IPC.webrtcToggleExempt,
    payload: { host: 'wr.test' },
  },
  {
    name: 'webrtc.removeExempt',
    run: () => aegis.webrtc.removeExempt('wr.test'),
    channel: IPC.webrtcRemoveExempt,
    payload: { host: 'wr.test' },
  },
  {
    name: 'webrtc.clearExempt',
    run: () => aegis.webrtc.clearExempt(),
    channel: IPC.webrtcClearExempt,
    payload: {},
  },

  // ---- proxy (4) ----
  {
    name: 'proxy.getState',
    run: () => aegis.proxy.getState(),
    channel: IPC.proxyGetState,
    payload: {},
  },
  {
    name: 'proxy.setConfig',
    run: () => aegis.proxy.setConfig(CFG),
    channel: IPC.proxySetConfig,
    payload: { config: CFG },
  },
  { name: 'proxy.clear', run: () => aegis.proxy.clear(), channel: IPC.proxyClear, payload: {} },
  {
    name: 'proxy.testConnection',
    run: () => aegis.proxy.testConnection(CFG),
    channel: IPC.proxyTestConnection,
    payload: { config: CFG },
  },

  // ---- form (1) ----
  {
    name: 'form.detectLoginForm',
    run: () => aegis.form.detectLoginForm(),
    channel: IPC.formDetectLoginForm,
    payload: {},
  },

  // ---- workspace (7) ----
  {
    name: 'workspace.list',
    run: () => aegis.workspace.list(),
    channel: IPC.workspaceList,
    payload: {},
  },
  {
    name: 'workspace.create',
    run: () => aegis.workspace.create('Work', '#ff0000'),
    channel: IPC.workspaceCreate,
    payload: { name: 'Work', color: '#ff0000' },
  },
  {
    name: 'workspace.create (no color)',
    run: () => aegis.workspace.create('Work2'),
    channel: IPC.workspaceCreate,
    payload: { name: 'Work2', color: undefined },
  },
  {
    name: 'workspace.switch',
    run: () => aegis.workspace.switch('ws-1'),
    channel: IPC.workspaceSwitch,
    payload: { id: 'ws-1' },
  },
  {
    name: 'workspace.rename',
    run: () => aegis.workspace.rename('ws-1', 'Renamed'),
    channel: IPC.workspaceRename,
    payload: { id: 'ws-1', name: 'Renamed' },
  },
  {
    name: 'workspace.setColor',
    run: () => aegis.workspace.setColor('ws-1', '#00ff00'),
    channel: IPC.workspaceSetColor,
    payload: { id: 'ws-1', color: '#00ff00' },
  },
  {
    name: 'workspace.remove',
    run: () => aegis.workspace.remove('ws-1'),
    channel: IPC.workspaceRemove,
    payload: { id: 'ws-1' },
  },
  {
    name: 'workspace.reorder',
    run: () => aegis.workspace.reorder(['ws-2', 'ws-1']),
    channel: IPC.workspaceReorder,
    payload: { ids: ['ws-2', 'ws-1'] },
  },
];

/**
 * Request channels the catalog declares that this file deliberately does NOT pin, each
 * with the reason. A channel landing here needs a human decision, not a silent gap.
 */
const UNPINNED_REQUEST: Record<string, string> = {
  [IPC.zoomReset]:
    '`aegis.zoom.reset` deliberately delegates to `zoom.set(1.0)` so the clamp lives in one ' +
    'place (pinned above); the renderer never emits this channel. The Rust arm at ' +
    "src-tauri/src/zoom.rs:110 is exercised by that module's own unit tests.",
};

describe('the renderer→core channel contract (desktop path)', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockListen.mockClear();
    // The Android bridge must be absent for these rows: half of it would short-circuit.
    delete win.AegisAndroid;
  });

  describe.each(REQUESTS)('$name', (row) => {
    it(`sends ${row.channel}`, async () => {
      await row.run();
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      const [command, args] = mockInvoke.mock.calls[0] as [string, unknown];
      expect(command).toBe('ipc');
      expect(args).toStrictEqual({ channel: row.channel, payload: row.payload });
    });
  });

  it('pins every request channel in the catalog, or lists it in UNPINNED_REQUEST', () => {
    const pinned = new Set(REQUESTS.map((r) => r.channel));
    const requests: string[] = Object.entries(IPC)
      .filter(([key]) => !key.startsWith('evt'))
      .map(([, value]) => value);
    // `data.import` is pinned by two rows (the text and no-text branches) and several
    // methods share a channel, so this is a set comparison, not a count comparison.
    const unpinned = requests.filter((c) => !pinned.has(c) && !(c in UNPINNED_REQUEST));
    expect(unpinned).toEqual([]);
    // A stale excuse is worse than a missing one: it silently stops documenting anything.
    const stale = Object.keys(UNPINNED_REQUEST).filter(
      (c) => pinned.has(c) || !requests.includes(c),
    );
    expect(stale).toEqual([]);
  });

  it('the table is big enough to be the contract, not a sample', () => {
    // Guards against someone "simplifying" the table down to the handful of channels
    // named in the plan and quietly un-guarding the rest. Lowered 115 -> 110 when the
    // five `split.*` request channels were removed from the catalog.
    expect(REQUESTS.length).toBeGreaterThanOrEqual(110);
    expect(new Set(REQUESTS.map((r) => r.name)).size).toBe(REQUESTS.length);
  });
});

// ---------------------------------------------------------------------------
// 2. The dedup allowlist — a mutation must never be answered from cache
// ---------------------------------------------------------------------------
//
// This is a regression guard, not a coverage filler: the previous design DENYLISTED
// mutations, which fails open. `tabs.create()` hashed to `{}` because the payload hash
// ignores absent keys, so holding Ctrl+T (the webview emits `tabs.shortcut="new"` on every
// key-repeat) opened one tab per ~300ms; and `fingerprint.toggleAllowlist` — a toggle —
// lost off-then-on inside the window while the UI showed the wrong state.
describe('the dedup allowlist only ever collapses reads', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    delete win.AegisAndroid;
  });

  // NOTE on the payloads below: `dedupeCache` is MODULE-GLOBAL and outlives an individual
  // test, so a channel the contract table above already called is still inside its window
  // here and would be served from cache for free (0 invokes). Every read in this describe
  // therefore uses a payload no earlier row used, which is also what makes the count
  // assertions mean what they say.

  it('collapses two identical reads inside the window', async () => {
    mockInvoke.mockResolvedValue([]);
    await aegis.history.search('dedup-probe-1');
    await aegis.history.search('dedup-probe-1');
    expect(mockInvoke).toHaveBeenCalledTimes(1);
  });

  it('does NOT collapse `tabs.create` — a repeated new-tab must reach the core every time', async () => {
    await aegis.tabs.create('https://repeat.test/');
    await aegis.tabs.create('https://repeat.test/');
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('does NOT collapse `fingerprint.toggleAllowlist` — a toggle is not idempotent', async () => {
    await aegis.fingerprint.toggleAllowlist('toggle.test');
    await aegis.fingerprint.toggleAllowlist('toggle.test');
    expect(mockInvoke).toHaveBeenCalledTimes(2);
  });

  it('re-issues a read once its window has passed', async () => {
    vi.useFakeTimers();
    try {
      mockInvoke.mockResolvedValue(true);
      await aegis.saved.has('https://dedup.test/probe-2');
      await aegis.saved.has('https://dedup.test/probe-2');
      expect(mockInvoke).toHaveBeenCalledTimes(1);
      // 200ms window for `saved.has`; step past it.
      vi.advanceTimersByTime(201);
      await aegis.saved.has('https://dedup.test/probe-2');
      expect(mockInvoke).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Subscriptions: aegis.on* -> listen('<ns>:<name>')
// ---------------------------------------------------------------------------
//
// Tauri 2 forbids '.' in event names, so `on()` rewrites the catalogued dotted name
// (`tabs.state` -> `tabs:state`) to match what `emit_event` sends from Rust. A mismatch
// here is a subscription that silently never fires, and no other test can see it.
const NOOP = (): void => {};

const EVENTS: { name: string; run: () => () => void; event: string }[] = [
  { name: 'nav.onFailed', run: () => aegis.nav.onFailed(NOOP), event: IPC.evtNavFailed },
  { name: 'nav.onCrashed', run: () => aegis.nav.onCrashed(NOOP), event: IPC.evtNavCrashed },
  { name: 'tabs.onState', run: () => aegis.tabs.onState(NOOP), event: IPC.evtTabsState },
  { name: 'tabs.onShortcut', run: () => aegis.tabs.onShortcut(NOOP), event: IPC.evtTabsShortcut },
  {
    name: 'view.onFullscreen',
    run: () => aegis.view.onFullscreen?.(NOOP) ?? NOOP,
    event: IPC.evtViewFullscreen,
  },
  {
    name: 'history.onChanged',
    run: () => aegis.history.onChanged(NOOP),
    event: IPC.evtHistoryChanged,
  },
  {
    name: 'lists.onUpdateResult',
    run: () => aegis.lists.onUpdateResult(NOOP),
    event: IPC.evtListsUpdateResult,
  },
  {
    name: 'downloads.onChanged',
    run: () => aegis.downloads.onChanged(NOOP),
    event: IPC.evtDownloadsChanged,
  },
  {
    name: 'permissions.onPrompt',
    run: () => aegis.permissions.onPrompt(NOOP),
    event: IPC.evtPermissionsPrompt,
  },
  { name: 'update.onState', run: () => aegis.update.onState(NOOP), event: IPC.evtUpdateState },
  {
    name: 'safety.onInterstitial',
    run: () => aegis.safety.onInterstitial(NOOP),
    event: IPC.evtSafetyInterstitial,
  },
  { name: 'sync.onState', run: () => aegis.sync.onState(NOOP), event: IPC.evtSyncState },
  { name: 'sync.onChanged', run: () => aegis.sync.onChanged(NOOP), event: IPC.evtSyncChanged },
  {
    name: 'sync.onVaultQuarantined',
    run: () => aegis.sync.onVaultQuarantined(NOOP),
    event: IPC.evtSyncVaultQuarantined,
  },
  { name: 'vault.onState', run: () => aegis.vault.onState(NOOP), event: IPC.evtVaultState },
  { name: 'vault.onChanged', run: () => aegis.vault.onChanged(NOOP), event: IPC.evtVaultChanged },
  { name: 'proxy.onState', run: () => aegis.proxy.onState(NOOP), event: IPC.evtProxyState },
  {
    name: 'workspace.onState',
    run: () => aegis.workspace.onState(NOOP),
    event: IPC.evtWorkspaceState,
  },
  {
    name: 'form.onLoginFormDetected',
    run: () => aegis.form.onLoginFormDetected(NOOP),
    event: IPC.evtFormDetectResult,
  },
  { name: 'form.onState', run: () => aegis.form.onState(NOOP), event: IPC.evtFormState },
  {
    name: 'form.onWillSubmit',
    run: () => aegis.form.onWillSubmit(NOOP),
    event: IPC.evtFormWillSubmit,
  },
  // Both of these were UNSUBSCRIBED until 2026-09-27. `picker.picked` in particular
  // had a UI that wanted it (`PickerButton`'s confirmation toast) wired to the RETURN
  // value of `picker.start`, which no platform arm of `start` ever populates with a
  // `rule` — so the toast was unreachable everywhere. It cannot be a return value at
  // all: `start` injects the picking overlay and returns, and the pick happens later
  // when the user clicks an element.
  {
    name: 'picker.onPicked',
    run: () => aegis.picker.onPicked(NOOP),
    event: IPC.evtPickerPicked,
  },
  { name: 'subs.onChanged', run: () => aegis.subs.onChanged(NOOP), event: IPC.evtSubsChanged },
];

/** Events with no `aegis` subscriber, each with the reason. Mirrors the inventory in
 * `shared/ipcCatalog.drift.test.ts` — this file proves the ABSENCE at runtime, that one
 * proves it in the source. */
const UNSUBSCRIBED: Record<string, string> = {
  // `picker.picked` used to be here. It is not a bridge-only event and not a real
  // excuse — it is an event with a UI that needed it and had no way to get it, and is
  // now pinned in EVENTS above as `picker.onPicked`. The rest are bridge-only.
  // Bridge-only events: on Android these are delivered through the `window.__aegis*`
  // callbacks instead of `listen`, so they appear in the Android describe below, not here.
  [IPC.evtNavState]: 'Android: __aegisNavState. Desktop: nav.onState (pinned below).',
  [IPC.evtAdblockBlockedCount]: 'Android: __aegisBlockedCount. Desktop: adblock.onBlockedCount.',
  [IPC.evtFindState]: 'Android: __aegisFindState. Desktop: find.onState.',
  [IPC.evtZoomChanged]: 'Android: __aegisZoomChanged. Desktop: zoom.onChanged.',
};

describe('the event-name contract', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockListen.mockClear();
    delete win.AegisAndroid;
  });

  it('the bridge-only and unsubscribed lists account for every non-Tauri event', () => {
    const tauriSubscribed = new Set<string>([
      ...EVENTS.map((e) => e.event),
      IPC.evtNavState,
      IPC.evtAdblockBlockedCount,
      IPC.evtFindState,
      IPC.evtZoomChanged,
    ]);
    const catalogEvents = Object.entries(IPC)
      .filter(([key]) => key.startsWith('evt'))
      .map(([, value]) => value);
    const unaccounted = catalogEvents.filter((e) => !tauriSubscribed.has(e));
    // Empty, and that is the goal: every catalogued event now has a real subscriber.
    // It was `[IPC.evtPickerPicked]` until 2026-09-27, and a non-empty list here is a
    // build failure, not a warning — an event nobody listens to is a silent defect.
    expect(unaccounted).toEqual([]);
    // And every excuse must name an event that really exists and really is unclaimed.
    for (const [event, reason] of Object.entries(UNSUBSCRIBED)) {
      expect(catalogEvents).toContain(event);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  describe.each(EVENTS)('$name', (row) => {
    it(`listens for ${row.event.replace(/\./g, ':')}`, () => {
      row.run();
      expect(mockListen).toHaveBeenCalledTimes(1);
      expect(mockListen).toHaveBeenCalledWith(row.event.replace(/\./g, ':'), expect.any(Function));
    });
  });

  it('hands the Tauri event payload to the subscriber', () => {
    const cb = vi.fn();
    aegis.tabs.onState(cb as (s: unknown) => void);
    const handler = mockListen.mock.calls[0][1] as (e: { payload: unknown }) => void;
    handler({ payload: { activeId: 3, tabs: [] } });
    expect(cb).toHaveBeenCalledWith({ activeId: 3, tabs: [] });
  });

  it('releases the backend listener exactly once, even when unsubscribed before listen() resolves', async () => {
    const unlisten = vi.fn();
    mockListen.mockResolvedValueOnce(unlisten);
    const off = aegis.tabs.onShortcut(NOOP);
    off();
    // The unlisten handle only exists after `listen`'s promise settles; `cancelled`
    // releases it as soon as it does.
    await Promise.resolve();
    await Promise.resolve();
    expect(unlisten).toHaveBeenCalledTimes(1);
    // A double cleanup (React StrictMode / a remounting effect) must not release twice.
    off();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// 4. The Android bridge short-circuits the Tauri channels
// ---------------------------------------------------------------------------
//
// On Android the content side is a native Kotlin WebView, so there is no Tauri event bus
// and no content webview for Rust to address: nav, find, zoom, chrome-overlay and
// update-restart all go through `window.AegisAndroid` instead. Every one of those is a
// *desktop* branch that jsdom can never take by accident, and a mistake here (issuing the
// Tauri channel as well, or calling the wrong bridge method) is invisible on desktop and
// broken on the phone.
interface Bridge {
  [k: string]: ReturnType<typeof vi.fn>;
}
let bridge: Bridge;

describe('the Android bridge path', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockListen.mockClear();
    bridge = {
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      setContentHidden: vi.fn(),
      openExternal: vi.fn(),
      setBackInterceptActive: vi.fn(),
      setBottomBarHidden: vi.fn(),
      setFullscreen: vi.fn(),
      activateTab: vi.fn(),
      closeTab: vi.fn(),
      discardTab: vi.fn(),
      find: vi.fn(),
      findNext: vi.fn(),
      findPrev: vi.fn(),
      findClose: vi.fn(),
      setZoom: vi.fn(),
      setProxy: vi.fn(),
      clearProxy: vi.fn(),
    };
    win.AegisAndroid = bridge;
    delete win.__aegisNavState;
    delete win.__aegisBlockedCount;
    delete win.__aegisFindState;
    delete win.__aegisZoomChanged;
  });

  afterEach(() => {
    delete win.AegisAndroid;
  });

  const bridged: { name: string; run: () => Promise<unknown>; method: string; args: unknown[] }[] =
    [
      {
        name: 'nav.navigate',
        run: () => aegis.nav.navigate(1, 'https://m.test/'),
        method: 'navigate',
        args: ['https://m.test/'],
      },
      { name: 'nav.back', run: () => aegis.nav.back(1), method: 'back', args: [] },
      { name: 'nav.forward', run: () => aegis.nav.forward(1), method: 'forward', args: [] },
      {
        name: 'nav.reloadOrStop',
        run: () => aegis.nav.reloadOrStop(1),
        method: 'reload',
        args: [],
      },
      // `home` navigates the NATIVE webview to about:blank, not to the user's `homeUrl`:
      // the core cannot reach the content view on Android, so the bridge is the only path.
      { name: 'nav.home', run: () => aegis.nav.home(1), method: 'navigate', args: ['about:blank'] },
      {
        name: 'view.setChromeOverlay',
        run: () => aegis.view.setChromeOverlay(1, true),
        method: 'setContentHidden',
        args: [true],
      },
      {
        name: 'update.restartToInstall',
        run: () => aegis.update.restartToInstall(),
        method: 'openExternal',
        args: ['https://github.com/HappyHobo085/Aegis/releases/latest'],
      },
      {
        name: 'find.start',
        run: () => aegis.find.start(1, 'q', true),
        method: 'find',
        args: ['q', true],
      },
      { name: 'find.next', run: () => aegis.find.next(1), method: 'findNext', args: [] },
      { name: 'find.prev', run: () => aegis.find.prev(1), method: 'findPrev', args: [] },
      { name: 'find.close', run: () => aegis.find.close(1), method: 'findClose', args: [] },
    ];

  describe.each(bridged)('$name', (row) => {
    it(`calls bridge.${row.method} and issues NO Tauri channel`, async () => {
      await row.run();
      expect(bridge[row.method]).toHaveBeenCalledTimes(1);
      expect(bridge[row.method]).toHaveBeenCalledWith(...row.args);
      expect(mockInvoke).not.toHaveBeenCalled();
    });
  });

  it('zoom.get is answered from the module-local cache, with no channel', async () => {
    // 1.0 is the documented default for a view the native side has never reported.
    await expect(aegis.zoom.get(1)).resolves.toStrictEqual({ viewId: 1, factor: 1.0 });
    await aegis.zoom.set(1, 2.0);
    await expect(aegis.zoom.get(1)).resolves.toStrictEqual({ viewId: 1, factor: 2.0 });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('zoom.set clamps the factor, tells native, and pushes the change to subscribers', async () => {
    const cb = vi.fn();
    aegis.zoom.onChanged(cb);
    // `clampZoom` caps at 3.0; 9.0 must not reach native as 900%.
    await expect(aegis.zoom.set(1, 9.0)).resolves.toStrictEqual({ viewId: 1, factor: 3.0 });
    expect(bridge.setZoom).toHaveBeenCalledWith(1, 300);
    expect(cb).toHaveBeenCalledWith({ viewId: 1, factor: 3.0 });
    expect(mockInvoke).not.toHaveBeenCalled();
  });

  it('proxy.setConfig drives the PROCESS-GLOBAL native override AND persists via IPC', async () => {
    // Documented parity difference: ProxyController.setProxyOverride is process-global, so
    // the IPC call is still issued (persistence + `proxy.state`) alongside the bridge.
    await aegis.proxy.setConfig(CFG);
    expect(bridge.setProxy).toHaveBeenCalledWith(
      'http',
      'proxy.test',
      8080,
      'localhost,tauri.localhost',
    );
    expect(mockInvoke).toHaveBeenCalledWith('ipc', {
      channel: IPC.proxySetConfig,
      payload: { config: CFG },
    });
  });

  it('proxy.setConfig with mode "off" clears the native override instead of setting one', async () => {
    await aegis.proxy.setConfig({ ...CFG, mode: 'off' });
    expect(bridge.clearProxy).toHaveBeenCalledTimes(1);
    expect(bridge.setProxy).not.toHaveBeenCalled();
  });

  it('proxy.clear clears the native override and still issues proxy.clear', async () => {
    await aegis.proxy.clear();
    expect(bridge.clearProxy).toHaveBeenCalledTimes(1);
    expect(mockInvoke).toHaveBeenCalledWith('ipc', { channel: IPC.proxyClear, payload: {} });
  });

  it('the exported mobile-only helpers forward to the bridge, and are no-ops without it', () => {
    setBackInterceptActive(true);
    setBottomBarHidden(true);
    setFullscreen(true);
    expect(bridge.setBackInterceptActive).toHaveBeenCalledWith(true);
    expect(bridge.setBottomBarHidden).toHaveBeenCalledWith(true);
    expect(bridge.setFullscreen).toHaveBeenCalledWith(true);
    delete win.AegisAndroid;
    expect(() => {
      setBackInterceptActive(false);
      setBottomBarHidden(false);
      setFullscreen(false);
    }).not.toThrow();
  });

  it('activateTab / closeTab / discardTab forward to the bridge', async () => {
    const mod = await import('./ipcClient');
    mod.activateTab(4, 'https://t.test/', true);
    expect(bridge.activateTab).toHaveBeenCalledWith(4, 'https://t.test/', true);
    mod.closeTab(4);
    expect(bridge.closeTab).toHaveBeenCalledWith(4);
    mod.discardTab(4);
    expect(bridge.discardTab).toHaveBeenCalledWith(4);
  });

  describe('bridge event fan-out', () => {
    it('nav.onState installs __aegisNavState and supports independent unsubscribes', () => {
      const cb1 = vi.fn();
      const cb2 = vi.fn();
      const off1 = aegis.nav.onState(cb1);
      aegis.nav.onState(cb2);
      const payload = {
        viewId: 1,
        url: 'https://x.test/',
        title: '',
        canGoBack: true,
        canGoForward: false,
        isLoading: false,
        crashed: false,
      };
      (win.__aegisNavState as (s: unknown) => void)(payload);
      expect(cb1).toHaveBeenCalledWith(payload);
      expect(cb2).toHaveBeenCalledWith(payload);
      off1();
      (win.__aegisNavState as (s: unknown) => void)(payload);
      expect(cb1).toHaveBeenCalledTimes(1);
      expect(cb2).toHaveBeenCalledTimes(2);
      expect(mockListen).not.toHaveBeenCalled();
    });

    it('adblock.onBlockedCount / find.onState / zoom.onChanged install their push callbacks', () => {
      aegis.adblock.onBlockedCount(vi.fn());
      aegis.find.onState(vi.fn());
      aegis.zoom.onChanged(vi.fn());
      for (const key of ['__aegisBlockedCount', '__aegisFindState', '__aegisZoomChanged']) {
        expect(typeof win[key]).toBe('function');
      }
      expect(mockListen).not.toHaveBeenCalled();
    });
  });
});
