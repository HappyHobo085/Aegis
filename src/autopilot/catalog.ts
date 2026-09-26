// src/autopilot/catalog.ts
// Single source of truth for "every feature". Each entry exercises real IPC
// (live: real core; vitest: mock) and declares the channels it covers so the
// drift guard fails when a feature is added without coverage.
import type { AegisApi } from '../../shared/types';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';
import { AdaptiveTimeout } from './timeout';

export interface FeatureCheck {
  id: string;
  domain: string;
  title: string;
  channels: string[];
  exercise(api: AegisApi): Promise<void>;
}

// There is deliberately NO `verify(api)` round-trip field any more.
//
// It used to exist here ("does an action, asserts the effect, restores state") and 19
// entries implemented it. It was called by NOTHING: `tour.test.tsx` only ever calls
// `exercise`, and the "live run" its doc comment referred to (`run.ts`, gated on
// `RunDeps.live`) does not exist in this repo — the root `AGENTS.md` says so explicitly.
// So ~470 lines of real round-trip logic were unreachable, while the docs and the
// "add a `verify(api)` round-trip" instruction in the root `AGENTS.md` described them as
// coverage. A guard that reads as coverage but never runs is worse than no guard: it
// makes the drift report look complete.
//
// They could not simply have been moved into the vitest tour either, because they are
// structurally live-only:
//   - `find` waited on a `find.state` event that the mock's `onState` never invokes, so
//     it would burn its 8s deadline and then throw by design.
//   - `sync` and `vault` asserted *state transitions* (enableFromPhrase → listDevices →
//     removeDevice → disable; create → unlock → add → list → search → update → remove).
//     `aegisMock` is non-stateful — it returns a fixed value regardless of arguments — so
//     those assertions could only ever pass vacuously.
// Deleting them is the honest outcome, and the coverage they claimed is now described
// where it actually lives: the interaction tour (`src/autopilot/interactions/`, which
// drives the real UI) and the Rust unit tests. Gaps that neither covers are named
// explicitly in UNTESTED_CHANNELS below.

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
      IPC.tabsRecordNav,
    ],
    exercise: async (a) => {
      assertObject(await a.tabs.create('https://example.org/', true));
      await a.tabs.reorder([V]);
      await a.tabs.setPinned(V, true);
      await a.tabs.setPinned(V, false);
      await a.tabs.setTitle(V, 'AP');
      await a.tabs.recordNav(V, 'https://example.org/', 'Example');
      await a.tabs.activate(V);
      await a.tabs.reopenClosed();
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
      assertArray(await a.favorites.update(1, { name: 'Updated' }));
      assertArray(await a.favorites.reorder([]));
    },
  },
  // history — entries are written by the core on real navigation (no direct add channel),
  // so `exercise` stays a read-only probe. A navigate → assert-row → delete round-trip
  // needs a real webview and is NOT done here; see UNTESTED_CHANNELS for the channels
  // that leaves uncovered.
  {
    id: 'history.crud',
    domain: 'history',
    title: 'History list/search/remove/clear',
    channels: [IPC.historyList, IPC.historySearch, IPC.historyRemove, IPC.historyClear],
    exercise: async (a) => {
      assertArray(await a.history.list({}));
      assertArray(await a.history.search('a'));
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
  },
  // lists — `exercise` does not trigger a real network fetch (too slow/fragile for a
  // mocked tour); `subs.rs`'s own Rust unit tests cover the fetch.
  {
    id: 'lists.updateNow',
    domain: 'lists',
    title: 'Update filter lists',
    channels: [IPC.listsUpdateNow],
    exercise: async (a) => {
      // Non-blocking now: it starts a background refresh and resolves to void (the
      // per-source result arrives via lists.updateResult). Just confirm it doesn't throw.
      await a.lists.updateNow();
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
    // READ-ONLY probe: assert the built-in defaults are seeded + flagged. The
    // setEnabled round-trip lives in the `settings.filterLists.toggleSub` interaction
    // (a separate tour phase) + the Rust unit tests — deliberately NOT here, because
    // setEnabled triggers a content-filter reinstall (install_adblock re-converts every
    // list), which is far too slow and destructive for a mocked tour.
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
      await a.update.restartToInstall();
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
      IPC.syncUnlock,
      IPC.syncDisable,
      IPC.syncNow,
      IPC.syncTestConnection,
      IPC.syncGetRecoveryPhrase,
      IPC.syncListDevices,
      IPC.syncRemoveDevice,
    ],
    exercise: async (a) => {
      assertObject(await a.sync.getState());
      await a.sync.disable({});
      await a.sync.testConnection('https://example.com');
      await a.sync.getRecoveryPhrase({ confirm: false });
      const devices = await a.sync.listDevices();
      assertArray(devices);
      // Note: `removeDevice` is deliberately not called — the mock has no devices to
      // remove. It is in UNTESTED_CHANNELS, and `sync-server`'s Rust unit tests cover
      // the revocation/ownership rules that make it meaningful.
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
    // find mutates webview search state, so `exercise` only drives start→next→prev→close
    // as a smoke test. The real round-trip (navigate to a page with known text, subscribe
    // to find.state, start, wait for the first match event, then close) is NOT done here:
    // it needs a real webview plus event delivery, and the mock's `onState` is a `vi.fn`
    // that never invokes the callback, so it would just burn its deadline and throw.
  },
  // vault (Phase A+B — password manager, chrome-only with autofill). `exercise` calls only
  // the read-only getState: creating and unlocking a vault is a destructive, password-
  // bearing operation that has no meaning against a mock. The mutating channels are
  // listed in UNTESTED_CHANNELS and are driven at the UI level by the interaction tour
  // (interactions/vault.ts: create.submit, unlock.submit, row.delete, …); the seal/unlock/
  // merge logic itself is covered by vault.rs's own unit tests.
  {
    id: 'vault.crud',
    domain: 'vault',
    title: 'Vault create/unlock/add/list/search/update/remove/lock',
    channels: [
      IPC.vaultGetState,
      IPC.vaultCreate,
      IPC.vaultUnlock,
      IPC.vaultLock,
      IPC.vaultList,
      IPC.vaultAdd,
      IPC.vaultUpdate,
      IPC.vaultRemove,
      IPC.vaultSearch,
      IPC.vaultAutofill,
      IPC.vaultAutofillSuggestions,
    ],
    exercise: async (a) => {
      assertObject(await a.vault.getState());
    },
  },
  // vault autofill suggestions (Phase B)
  {
    id: 'vault.autofillSuggestions',
    domain: 'vault',
    title: 'Vault autofill suggestions by domain',
    // CHANNEL-LEVEL ONLY. The Rust handlers exist, but nothing in the chrome calls them yet:
    // the `AutofillBadge` → `useVaultDomainSuggestions` → `useVaultAutofill` chain was deleted
    // as dead, unmounted code, and the "Passwords" tab copy no longer promises autofill. This
    // entry is the coverage for the IPC contract, not a claim that a UI affordance exists.
    channels: [IPC.vaultAutofillSuggestions],
    exercise: async (a) => {
      assertArray(await a.vault.autofillSuggestions('example.com'));
    },
  },
  // form detection
  {
    id: 'form.detectLoginForm',
    domain: 'form',
    title: 'Form detection for login forms',
    // CHANNEL-LEVEL ONLY. `useLoginFormDetector` — the only caller, and the source of an
    // unconditional 2 s `form.detectLoginForm` poll — was deleted along with the dead
    // `AutofillBadge` subtree it existed to feed. No UI surface calls this today.
    //
    // The core REFUSES this channel rather than answering: a content webview has no Tauri
    // capability and `withGlobalTauri` is off, so the page cannot emit a result back. The old
    // implementation burned a 5 s main-thread timeout and then returned `hasLoginForm: false`,
    // which is indistinguishable from a real negative. See `src-tauri/src/form.rs`. So this
    // exercise asserts the refusal rather than a boolean — asserting `hasLoginForm === false`
    // here is what let the broken version pass.
    channels: [IPC.formDetectLoginForm, IPC.evtFormDetectResult],
    exercise: async (a) => {
      await expect(a.form.detectLoginForm()).rejects.toThrow(/not implemented/);
      // The event side has no producer on any platform either, but subscribing is still the
      // contract the chrome relies on, so check it yields a working unsubscribe.
      const unsubscribe = a.form.onLoginFormDetected(() => {});
      expect(typeof unsubscribe).toBe('function');
      unsubscribe();
    },
  },
  // fingerprint allowlist
  {
    id: 'fingerprint.allowlist',
    domain: 'fingerprint',
    title: 'Fingerprint per-site allowlist',
    channels: [
      IPC.fingerprintGetState,
      IPC.fingerprintToggleAllowlist,
      IPC.fingerprintRemoveAllowlist,
      IPC.fingerprintClearAllowlist,
    ],
    exercise: async (a) => {
      assertObject(await a.fingerprint.getState());
      assertObject(await a.fingerprint.toggleAllowlist('ap-fp.test'));
      assertObject(await a.fingerprint.removeAllowlist('ap-fp.test'));
      assertObject(await a.fingerprint.clearAllowlist());
    },
  },
  // proxy — IPC seam + native apply (Tasks 2-6); coverage added by Task 8.
  {
    id: 'proxy.state',
    domain: 'proxy',
    title: 'Proxy getState/setConfig/clear/testConnection',
    channels: [
      IPC.proxyGetState,
      IPC.proxySetConfig,
      IPC.proxyClear,
      IPC.proxyTestConnection,
      IPC.evtProxyState,
    ],
    exercise: async (a) => {
      assertObject(await a.proxy.getState());
      assertObject(
        await a.proxy.setConfig({
          mode: 'off',
          scheme: 'http',
          host: '',
          port: 8080,
          bypassHosts: [],
        }),
      );
      assertObject(await a.proxy.clear());
      assertObject(
        await a.proxy.testConnection({
          mode: 'proxy',
          scheme: 'http',
          host: '127.0.0.1',
          port: 8080,
          bypassHosts: [],
        }),
      );
    },
  },
  // workspaces
  {
    id: 'workspace.crud',
    domain: 'workspace',
    title: 'Workspace CRUD',
    channels: [
      IPC.workspaceList,
      IPC.workspaceCreate,
      IPC.workspaceSwitch,
      IPC.workspaceRename,
      IPC.workspaceSetColor,
      IPC.workspaceRemove,
      IPC.workspaceReorder,
    ],
    exercise: async (a) => {
      const listResult = await a.workspace.list();
      // workspace.list always replies with the full WorkspaceState
      assertObject(listResult);
      const ws = await a.workspace.create('Test Workspace', '#3b82f6');
      assertObject(ws);
      await a.workspace.rename(ws.id, 'Renamed');
      await a.workspace.setColor(ws.id, '#10b981');
      await a.workspace.switch(ws.id);
      await a.workspace.reorder([ws.id, 'default']);
      await a.workspace.remove(ws.id);
    },
  },
  // split view
  {
    id: 'split.crud',
    domain: 'split',
    title: 'Split view getState/enter/exit/resize/focus',
    channels: [IPC.splitGetState, IPC.splitEnter, IPC.splitExit, IPC.splitResize, IPC.splitFocus],
    exercise: async (a) => {
      // exercise exercises the channels but does not assert success — the Rust
      // side may reject the call if fewer than 2 tabs exist (vitest mock).
      await a.split.getState().catch(() => {});
      await a.split.enter([1, 2]).catch(() => {});
      await a.split.resize(1, 600, 800).catch(() => {});
      await a.split.focus(1).catch(() => {});
      await a.split.exit().catch(() => {});
    },
  },
];

// Channels whose `exercise` body intentionally does NOT call them (destructive,
// OS/file/window-bound, or fire-and-forget).
//
// Two tiers, and the difference matters when reading a coverage report:
//
//  1. Covered elsewhere — the interaction tour (`src/autopilot/interactions/`) drives the
//     real UI for these, and/or the owning Rust module has its own unit tests. E.g.
//     favorites/saved update+remove, subs setEnabled, the vault mutators, find.
//  2. Genuinely unverified — cannot be round-tripped without real OS/file/network/
//     interactive state (a real download, permission prompt, malware interstitial, a live
//     sync server, or an app restart). Nothing automated exercises these end to end.
//
// There is no third tier that used to be here. These channels were previously described
// as "round-tripped by the live `verify()` functions", but no such run exists — see the
// note above the `FeatureCheck` interface. Do not add coverage claims here that no
// executing test backs.
//
// This set is DOCUMENTATION, not an escape hatch: `coverage.test.ts` asserts every member
// here ALSO appears in some catalog entry's `channels`, so a channel can never skip the
// catalog by being listed here alone. But that guard only checks the channel is *named* —
// it cannot check that the entry's exercise, or a sibling test, does anything meaningful.
export const UNTESTED_CHANNELS = new Set<string>([
  // file/OS-bound — would mutate the host if called in vitest, and no automated test
  // exercises them end to end:
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
  IPC.syncUnlock,
  IPC.syncDisable,
  IPC.syncNow,
  IPC.syncTestConnection,
  IPC.syncGetRecoveryPhrase,
  IPC.syncRemoveDevice,
  // vault — not called by the vault.crud exercise() body (which calls only the read-only
  // getState). Covered at the UI level by the interaction tour (interactions/vault.ts:
  // create.submit → vaultCreate, unlock.submit → vaultUnlock, row.delete → vaultRemove, …);
  // the seal/unlock/merge logic is covered by vault.rs's unit tests. Listed here only
  // because exercise() skips them:
  IPC.vaultCreate,
  IPC.vaultUnlock,
  IPC.vaultLock,
  IPC.vaultAdd,
  IPC.vaultUpdate,
  IPC.vaultRemove,
  IPC.vaultList,
  IPC.vaultSearch,
  // Phase B — autofill channels exist on the JS side; no Rust handler yet.
  IPC.vaultAutofill,
  IPC.vaultAutofillSuggestions,
]);
