import { describe, it, expect } from 'vitest';
import { IPC, PRIMARY_VIEW_ID, ALLOWED_NAV_SCHEMES } from './types';
import type {
  AdblockState,
  BlockedCount,
  ListUpdateResult,
  ListSourceResult,
  Favorite,
  HistoryEntry,
  SavedItem,
  ContentInset,
  Subscription,
  AegisApi,
  DownloadEntry,
  SitePermission,
  PermissionPrompt,
  ImportMode,
  Settings,
} from './types';

describe('shared/types', () => {
  it('exposes the IPC channel constants', () => {
    expect(IPC.navNavigate).toBe('nav.navigate');
    expect(IPC.navGetState).toBe('nav.getState');
    expect(IPC.viewSetContentVisible).toBe('view.setContentVisible');
    expect(IPC.settingsGet).toBe('settings.get');
    expect(IPC.evtNavState).toBe('nav.state');
    expect(IPC.evtNavFailed).toBe('nav.failed');
    expect(IPC.evtNavCrashed).toBe('nav.crashed');
  });

  it('uses the primary view id and the nav-scheme allowlist', () => {
    expect(PRIMARY_VIEW_ID).toBe(1);
    expect(ALLOWED_NAV_SCHEMES).toEqual(['https:', 'http:']);
  });

  it('exposes the Phase-1 adblock + lists IPC channel constants', () => {
    expect(IPC.adblockSetEnabled).toBe('adblock.setEnabled');
    expect(IPC.adblockToggleAllowlist).toBe('adblock.toggleAllowlist');
    expect(IPC.adblockGetState).toBe('adblock.getState');
    expect(IPC.listsUpdateNow).toBe('lists.updateNow');
    expect(IPC.evtAdblockBlockedCount).toBe('adblock.blockedCount');
  });

  it('admits the Phase-1 data-model shapes', () => {
    const state: AdblockState = {
      enabled: true,
      allowlistedHosts: ['example.com'],
      sessionBlocked: 5,
    };
    expect(state.allowlistedHosts).toContain('example.com');

    const count: BlockedCount = { viewId: PRIMARY_VIEW_ID, page: 2, session: 9 };
    expect(count.viewId).toBe(PRIMARY_VIEW_ID);

    const src: ListSourceResult = { listId: 'easylist', ok: false, error: 'timeout' };
    const result: ListUpdateResult = { perSource: [src], lastUpdated: 1234 };
    expect(result.perSource[0].ok).toBe(false);
    expect(result.lastUpdated).toBe(1234);
  });
});

describe('shared/types — Phase 3 additions', () => {
  it('exposes the favorites IPC channel constants', () => {
    expect(IPC.favoritesList).toBe('favorites.list');
    expect(IPC.favoritesAdd).toBe('favorites.add');
    expect(IPC.favoritesUpdate).toBe('favorites.update');
    expect(IPC.favoritesRemove).toBe('favorites.remove');
    expect(IPC.favoritesReorder).toBe('favorites.reorder');
  });

  it('no longer exposes favorites tag IPC channel constants', () => {
    expect('favoritesRenameTag' in IPC).toBe(false);
    expect('favoritesDeleteTag' in IPC).toBe(false);
    expect('favoritesTagUnion' in IPC).toBe(false);
  });

  it('exposes the history IPC channel constants (incl. the changed event)', () => {
    expect(IPC.historyList).toBe('history.list');
    expect(IPC.historySearch).toBe('history.search');
    expect(IPC.historyRemove).toBe('history.remove');
    expect(IPC.historyClear).toBe('history.clear');
    expect(IPC.evtHistoryChanged).toBe('history.changed');
  });

  it('exposes the saved-list + tag IPC channel constants', () => {
    expect(IPC.savedList).toBe('saved.list');
    expect(IPC.savedAdd).toBe('saved.add');
    expect(IPC.savedRemove).toBe('saved.remove');
    expect(IPC.savedHas).toBe('saved.has');
    expect(IPC.savedUpdate).toBe('saved.update');
    expect(IPC.savedRenameTag).toBe('saved.renameTag');
    expect(IPC.savedDeleteTag).toBe('saved.deleteTag');
    expect(IPC.savedTagUnion).toBe('saved.tagUnion');
  });

  it('exposes the view.setContentInset channel constant', () => {
    expect(IPC.viewSetContentInset).toBe('view.setContentInset');
  });

  it('admits the Phase-3 data-model shapes', () => {
    const fav: Favorite = { id: 1, name: 'Example', url: 'https://example.com/', position: 0 };
    expect(fav.position).toBe(0);

    const entry: HistoryEntry = { id: 2, url: 'https://a.test/', title: 'A', visitedAt: 1234 };
    expect(entry.visitedAt).toBe(1234);

    const saved: SavedItem = {
      id: 3,
      url: 'https://b.test/',
      title: 'B',
      tags: ['news'],
      savedAt: 5678,
    };
    expect(saved.tags).toEqual(['news']);
    expect(saved.savedAt).toBe(5678);

    const inset: ContentInset = { top: 96, left: 280 };
    expect(inset).toEqual({ top: 96, left: 280 });
  });

  it('types the favorites AegisApi members without tag methods (compile-only shape check)', () => {
    type FavoritesApi = AegisApi['favorites'];
    const favoritesShape: Record<keyof FavoritesApi, true> = {
      list: true,
      add: true,
      update: true,
      remove: true,
      reorder: true,
    };
    expect(Object.keys(favoritesShape).sort()).toEqual([
      'add',
      'list',
      'remove',
      'reorder',
      'update',
    ]);
  });

  it('types the saved AegisApi members incl. tag methods (compile-only shape check)', () => {
    type SavedApi = AegisApi['saved'];
    const savedShape: Record<keyof SavedApi, true> = {
      list: true,
      add: true,
      remove: true,
      has: true,
      update: true,
      renameTag: true,
      deleteTag: true,
      tagUnion: true,
    };
    expect(Object.keys(savedShape).sort()).toEqual([
      'add',
      'deleteTag',
      'has',
      'list',
      'remove',
      'renameTag',
      'tagUnion',
      'update',
    ]);
  });
});

describe('shared/types — Phase 4 additions', () => {
  it('exposes the subscriptions IPC channel constants', () => {
    expect(IPC.subsList).toBe('subs.list');
    expect(IPC.subsSetEnabled).toBe('subs.setEnabled');
    expect(IPC.subsAdd).toBe('subs.add');
    expect(IPC.subsRemove).toBe('subs.remove');
  });

  it('exposes the custom-filters IPC channel constants', () => {
    expect(IPC.customFiltersGet).toBe('customFilters.get');
    expect(IPC.customFiltersSet).toBe('customFilters.set');
  });

  it('exposes the allowlist remove/clear IPC channel constants', () => {
    expect(IPC.adblockRemoveAllowlist).toBe('adblock.removeAllowlist');
    expect(IPC.adblockClearAllowlist).toBe('adblock.clearAllowlist');
  });

  it('re-exports the Subscription shape', () => {
    const sub: Subscription = {
      listId: 'easylist',
      url: 'https://example.test/easylist.txt',
      enabled: true,
      lastUpdated: 123,
      etag: null,
      hash: 'abc',
    };
    expect(sub.listId).toBe('easylist');
    expect(sub.enabled).toBe(true);
  });

  it('types the Phase-4 AegisApi members (compile-only shape check)', () => {
    type SubsApi = AegisApi['subs'];
    type CustomFiltersApi = AegisApi['customFilters'];
    const subsShape: Record<keyof SubsApi, true> = {
      list: true,
      setEnabled: true,
      add: true,
      remove: true,
    };
    const cfShape: Record<keyof CustomFiltersApi, true> = { get: true, set: true };
    expect(Object.keys(subsShape).sort()).toEqual(['add', 'list', 'remove', 'setEnabled']);
    expect(Object.keys(cfShape).sort()).toEqual(['get', 'set']);
  });
});

describe('shared/types — tabs (multi-tab) additions', () => {
  it('exposes every tabs channel + the state event', () => {
    expect(IPC.tabsCreate).toBe('tabs.create');
    expect(IPC.tabsClose).toBe('tabs.close');
    expect(IPC.tabsActivate).toBe('tabs.activate');
    expect(IPC.tabsReorder).toBe('tabs.reorder');
    expect(IPC.tabsSetPinned).toBe('tabs.setPinned');
    expect(IPC.tabsReopenClosed).toBe('tabs.reopenClosed');
    expect(IPC.tabsList).toBe('tabs.list');
    expect(IPC.evtTabsState).toBe('tabs.state');
  });
});

describe('shared/types — Phase 5 additions', () => {
  it('exposes the downloads IPC channel constants (incl. the changed event)', () => {
    expect(IPC.downloadsList).toBe('downloads.list');
    expect(IPC.downloadsRemove).toBe('downloads.remove');
    expect(IPC.downloadsClear).toBe('downloads.clear');
    expect(IPC.downloadsOpenFile).toBe('downloads.openFile');
    expect(IPC.downloadsShowInFolder).toBe('downloads.showInFolder');
    expect(IPC.downloadsCancel).toBe('downloads.cancel');
    expect(IPC.evtDownloadsChanged).toBe('downloads.changed');
  });

  it('exposes the permissions IPC channel constants (incl. the prompt event)', () => {
    expect(IPC.permissionsList).toBe('permissions.list');
    expect(IPC.permissionsRemove).toBe('permissions.remove');
    expect(IPC.permissionsClear).toBe('permissions.clear');
    expect(IPC.permissionsResolve).toBe('permissions.resolve');
    expect(IPC.evtPermissionsPrompt).toBe('permissions.prompt');
  });

  it('exposes the data + picker IPC channel constants', () => {
    expect(IPC.dataExport).toBe('data.export');
    expect(IPC.dataImport).toBe('data.import');
    expect(IPC.pickerStart).toBe('picker.start');
  });

  it('admits the Phase-5 data-model shapes', () => {
    const dl: DownloadEntry = {
      id: 1,
      url: 'https://a.test/f.zip',
      filename: 'f.zip',
      savePath: '/home/u/Downloads/f.zip',
      state: 'progressing',
      receivedBytes: 10,
      totalBytes: 100,
      startedAt: 1234,
    };
    expect(dl.state).toBe('progressing');

    const perm: SitePermission = {
      origin: 'https://a.test',
      permission: 'geolocation',
      decision: 'allow',
    };
    expect(perm.decision).toBe('allow');

    const prompt: PermissionPrompt = {
      requestId: 7,
      origin: 'https://a.test',
      permission: 'notifications',
    };
    expect(prompt.requestId).toBe(7);

    const mode: ImportMode = 'replace';
    expect(mode).toBe('replace');
  });

  it('adds downloadDir to Settings', () => {
    const partial: Partial<Settings> = { downloadDir: '/tmp/dl' };
    expect(partial.downloadDir).toBe('/tmp/dl');
  });

  it('types the Phase-5 AegisApi members (compile-only shape check)', () => {
    type DownloadsApi = AegisApi['downloads'];
    type PermissionsApi = AegisApi['permissions'];
    type DataApi = AegisApi['data'];
    type PickerApi = AegisApi['picker'];
    const downloadsShape: Record<keyof DownloadsApi, true> = {
      list: true,
      remove: true,
      clear: true,
      openFile: true,
      showInFolder: true,
      cancel: true,
      onChanged: true,
    };
    const permissionsShape: Record<keyof PermissionsApi, true> = {
      list: true,
      remove: true,
      clear: true,
      resolve: true,
      onPrompt: true,
    };
    const dataShape: Record<keyof DataApi, true> = { export: true, import: true };
    const pickerShape: Record<keyof PickerApi, true> = { start: true };
    expect(Object.keys(downloadsShape).sort()).toEqual([
      'cancel',
      'clear',
      'list',
      'onChanged',
      'openFile',
      'remove',
      'showInFolder',
    ]);
    expect(Object.keys(permissionsShape).sort()).toEqual([
      'clear',
      'list',
      'onPrompt',
      'remove',
      'resolve',
    ]);
    expect(Object.keys(dataShape).sort()).toEqual(['export', 'import']);
    expect(Object.keys(pickerShape)).toEqual(['start']);
  });
});

describe('shared/types — IPC channel-name invariants (Foundation)', () => {
  const entries = Object.entries(IPC) as [string, string][];

  it('every name is dot-separated (namespace.action) with no colon', () => {
    // Logical names are dotted; the transport rewrites event `.`→`:` (lib.rs
    // emit_event / tauriInvoke.ts). A raw colon here would be a name that can
    // never round-trip, and a missing dot breaks the namespace dispatch convention.
    for (const [key, value] of entries) {
      expect(typeof value, key).toBe('string');
      expect(value, `${key} = ${value}`).toMatch(/^[a-z][a-zA-Z]*\.[a-zA-Z]+$/);
    }
  });

  it('every name is unique (no dispatch collision)', () => {
    const values = entries.map(([, v]) => v);
    expect(new Set(values).size).toBe(values.length);
  });
});
