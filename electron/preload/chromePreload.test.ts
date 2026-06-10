// electron/preload/chromePreload.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';
import type { AegisApi, NavState, BlockedCount, Subscription } from '../../shared/types';

// Capture the bridged API object and the registered ipcRenderer.on listeners.
const h = vi.hoisted(() => ({
  exposed: {} as Record<string, unknown>,
  invoke: undefined as any,
  listeners: new Map<string, Array<(event: any, payload: any) => void>>(),
  removed: [] as Array<{ channel: string; fn: any }>,
}));

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => {
      h.exposed[key] = api;
    },
  },
  ipcRenderer: {
    invoke: (...args: any[]) => h.invoke(...args),
    on: (channel: string, fn: (event: any, payload: any) => void) => {
      const arr = h.listeners.get(channel) ?? [];
      arr.push(fn);
      h.listeners.set(channel, arr);
    },
    removeListener: (channel: string, fn: any) => {
      h.removed.push({ channel, fn });
    },
  },
}));

describe('chromePreload', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  function loadPreload(): AegisApi {
    return import('./chromePreload').then(() => h.exposed.aegis as AegisApi) as unknown as AegisApi;
  }

  it('exposes window.aegis via contextBridge', async () => {
    await import('./chromePreload');
    expect(h.exposed.aegis).toBeDefined();
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.nav.navigate).toBe('function');
    expect(typeof api.view.setContentVisible).toBe('function');
    expect(typeof api.settings.get).toBe('function');
  });

  it('nav.navigate invokes IPC.navNavigate with (viewId, url)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.nav.navigate(PRIMARY_VIEW_ID, 'https://example.com/');
    expect(h.invoke).toHaveBeenCalledWith(IPC.navNavigate, PRIMARY_VIEW_ID, 'https://example.com/');
  });

  it('nav.getState invokes IPC.navGetState and returns the resolved state', async () => {
    const state: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: true, canGoForward: false, isLoading: false, crashed: false,
    };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.nav.getState(PRIMARY_VIEW_ID);
    expect(h.invoke).toHaveBeenCalledWith(IPC.navGetState, PRIMARY_VIEW_ID);
    expect(result).toEqual(state);
  });

  it('settings.set invokes IPC.settingsSet with the partial', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.settings.set({ siteName: 'X' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.settingsSet, { siteName: 'X' });
  });

  it('onState registers an ipcRenderer.on listener and delivers the payload', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.nav.onState(cb);
    const arr = h.listeners.get(IPC.evtNavState)!;
    expect(arr).toHaveLength(1);
    const payload: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: false, canGoForward: false, isLoading: false, crashed: false,
    };
    arr[0]({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('onState returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.nav.onState(cb);
    const registered = h.listeners.get(IPC.evtNavState)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtNavState, fn: registered }]);
  });

  it('onFailed and onCrashed register on their event channels', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    api.nav.onFailed(vi.fn());
    api.nav.onCrashed(vi.fn());
    expect(h.listeners.get(IPC.evtNavFailed)).toHaveLength(1);
    expect(h.listeners.get(IPC.evtNavCrashed)).toHaveLength(1);
  });
});

describe('chromePreload adblock + lists (Phase 1)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes adblock and lists namespaces', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.adblock.setEnabled).toBe('function');
    expect(typeof api.adblock.toggleAllowlist).toBe('function');
    expect(typeof api.adblock.getState).toBe('function');
    expect(typeof api.adblock.onBlockedCount).toBe('function');
    expect(typeof api.lists.updateNow).toBe('function');
  });

  it('adblock.setEnabled invokes IPC.adblockSetEnabled with the flag', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.adblock.setEnabled(false);
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockSetEnabled, false);
  });

  it('adblock.toggleAllowlist invokes IPC.adblockToggleAllowlist with the host', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.adblock.toggleAllowlist('example.com');
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockToggleAllowlist, 'example.com');
  });

  it('adblock.getState invokes IPC.adblockGetState and returns the resolved state', async () => {
    const state = { enabled: true, allowlistedHosts: ['x.test'], sessionBlocked: 9 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.adblock.getState();
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockGetState);
    expect(result).toEqual(state);
  });

  it('lists.updateNow invokes IPC.listsUpdateNow and returns the resolved result', async () => {
    const res = { perSource: [{ listId: 'easylist', ok: true }], lastUpdated: 1 };
    h.invoke = vi.fn(async () => res);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.lists.updateNow();
    expect(h.invoke).toHaveBeenCalledWith(IPC.listsUpdateNow);
    expect(out).toEqual(res);
  });

  it('onBlockedCount registers on IPC.evtAdblockBlockedCount and delivers the payload', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.adblock.onBlockedCount(cb);
    const arr = h.listeners.get(IPC.evtAdblockBlockedCount)!;
    expect(arr).toHaveLength(1);
    const payload: BlockedCount = { viewId: PRIMARY_VIEW_ID, page: 3, session: 12 };
    arr[0]({}, payload);
    expect(cb).toHaveBeenCalledWith(payload);
  });

  it('onBlockedCount returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.adblock.onBlockedCount(cb);
    const registered = h.listeners.get(IPC.evtAdblockBlockedCount)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtAdblockBlockedCount, fn: registered }]);
  });
});

describe('chromePreload favorites + history + saved + inset (Phase 3)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes favorites, history, and saved namespaces + view.setContentInset', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.favorites.list).toBe('function');
    expect(typeof api.favorites.add).toBe('function');
    expect(typeof api.favorites.update).toBe('function');
    expect(typeof api.favorites.remove).toBe('function');
    expect(typeof api.favorites.reorder).toBe('function');
    expect(typeof api.favorites.renameTag).toBe('function');
    expect(typeof api.favorites.deleteTag).toBe('function');
    expect(typeof api.favorites.tagUnion).toBe('function');
    expect(typeof api.history.list).toBe('function');
    expect(typeof api.history.search).toBe('function');
    expect(typeof api.history.remove).toBe('function');
    expect(typeof api.history.clear).toBe('function');
    expect(typeof api.history.onChanged).toBe('function');
    expect(typeof api.saved.list).toBe('function');
    expect(typeof api.saved.add).toBe('function');
    expect(typeof api.saved.remove).toBe('function');
    expect(typeof api.saved.has).toBe('function');
    expect(typeof api.view.setContentInset).toBe('function');
  });

  it('favorites.add invokes IPC.favoritesAdd with the input', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const input = { name: 'A', url: 'https://a.test/', tags: ['x'] };
    await api.favorites.add(input);
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesAdd, input);
  });

  it('favorites.update invokes IPC.favoritesUpdate with (id, partial)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.update(7, { name: 'R' });
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesUpdate, 7, { name: 'R' });
  });

  it('favorites.reorder invokes IPC.favoritesReorder with the id array', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.reorder([3, 1, 2]);
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesReorder, [3, 1, 2]);
  });

  it('favorites.renameTag and deleteTag invoke their channels with args', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.favorites.renameTag('old', 'new');
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesRenameTag, 'old', 'new');
    await api.favorites.deleteTag('old');
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesDeleteTag, 'old');
  });

  it('favorites.tagUnion invokes IPC.favoritesTagUnion and returns the resolved set', async () => {
    h.invoke = vi.fn(async () => ['a', 'b']);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.favorites.tagUnion();
    expect(h.invoke).toHaveBeenCalledWith(IPC.favoritesTagUnion);
    expect(result).toEqual(['a', 'b']);
  });

  it('history.list invokes IPC.historyList with opts', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.list({ limit: 50 });
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyList, { limit: 50 });
  });

  it('history.search invokes IPC.historySearch with the query', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.search('q');
    expect(h.invoke).toHaveBeenCalledWith(IPC.historySearch, 'q');
  });

  it('history.remove and clear invoke their channels', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.history.remove(9);
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyRemove, 9);
    await api.history.clear();
    expect(h.invoke).toHaveBeenCalledWith(IPC.historyClear);
  });

  it('history.onChanged registers on IPC.evtHistoryChanged and delivers (no payload)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    api.history.onChanged(cb);
    const arr = h.listeners.get(IPC.evtHistoryChanged)!;
    expect(arr).toHaveLength(1);
    arr[0]({}, undefined);
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('history.onChanged returns an unsubscriber that removes the listener', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const cb = vi.fn();
    const off = api.history.onChanged(cb);
    const registered = h.listeners.get(IPC.evtHistoryChanged)![0];
    off();
    expect(h.removed).toEqual([{ channel: IPC.evtHistoryChanged, fn: registered }]);
  });

  it('saved.add invokes IPC.savedAdd with the input', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const input = { url: 'https://a.test/', title: 'A' };
    await api.saved.add(input);
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedAdd, input);
  });

  it('saved.has invokes IPC.savedHas with the url and returns the boolean', async () => {
    h.invoke = vi.fn(async () => true);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const result = await api.saved.has('https://a.test/');
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedHas, 'https://a.test/');
    expect(result).toBe(true);
  });

  it('saved.remove invokes IPC.savedRemove with the id', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.saved.remove(4);
    expect(h.invoke).toHaveBeenCalledWith(IPC.savedRemove, 4);
  });

  it('view.setContentInset invokes IPC.viewSetContentInset with (viewId, inset)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.view.setContentInset(PRIMARY_VIEW_ID, { top: 96, left: 280 });
    expect(h.invoke).toHaveBeenCalledWith(IPC.viewSetContentInset, PRIMARY_VIEW_ID, { top: 96, left: 280 });
  });
});

describe('chromePreload subs + customFilters + allowlist (Phase 4)', () => {
  beforeEach(() => {
    h.exposed = {};
    h.invoke = vi.fn(async () => undefined);
    h.listeners = new Map();
    h.removed = [];
    vi.resetModules();
  });

  it('exposes the subs and customFilters namespaces + the adblock allowlist methods', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    expect(typeof api.subs.list).toBe('function');
    expect(typeof api.subs.setEnabled).toBe('function');
    expect(typeof api.subs.add).toBe('function');
    expect(typeof api.subs.remove).toBe('function');
    expect(typeof api.customFilters.get).toBe('function');
    expect(typeof api.customFilters.set).toBe('function');
    expect(typeof api.adblock.removeAllowlist).toBe('function');
    expect(typeof api.adblock.clearAllowlist).toBe('function');
  });

  it('subs.list invokes IPC.subsList and returns the resolved subscriptions', async () => {
    const subs: Subscription[] = [
      { listId: 'easylist', url: 'https://e.test/easylist.txt', enabled: true, lastUpdated: null, etag: null, hash: null },
    ];
    h.invoke = vi.fn(async () => subs);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.subs.list();
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsList);
    expect(out).toEqual(subs);
  });

  it('subs.setEnabled invokes IPC.subsSetEnabled with (listId, enabled)', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.setEnabled('easylist', false);
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsSetEnabled, 'easylist', false);
  });

  it('subs.add invokes IPC.subsAdd with the url', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.add('https://new.test/list.txt');
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsAdd, 'https://new.test/list.txt');
  });

  it('subs.remove invokes IPC.subsRemove with the listId', async () => {
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    await api.subs.remove('easylist');
    expect(h.invoke).toHaveBeenCalledWith(IPC.subsRemove, 'easylist');
  });

  it('customFilters.get invokes IPC.customFiltersGet and returns the resolved text', async () => {
    h.invoke = vi.fn(async () => 'x.com##.ad');
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.customFilters.get();
    expect(h.invoke).toHaveBeenCalledWith(IPC.customFiltersGet);
    expect(out).toBe('x.com##.ad');
  });

  it('customFilters.set invokes IPC.customFiltersSet with the text and returns the stored text', async () => {
    h.invoke = vi.fn(async () => '||ads.test^');
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.customFilters.set('||ads.test^');
    expect(h.invoke).toHaveBeenCalledWith(IPC.customFiltersSet, '||ads.test^');
    expect(out).toBe('||ads.test^');
  });

  it('adblock.removeAllowlist invokes IPC.adblockRemoveAllowlist with the host', async () => {
    const state = { enabled: true, allowlistedHosts: [], sessionBlocked: 1 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.adblock.removeAllowlist('a.test');
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockRemoveAllowlist, 'a.test');
    expect(out).toEqual(state);
  });

  it('adblock.clearAllowlist invokes IPC.adblockClearAllowlist and returns the resolved state', async () => {
    const state = { enabled: true, allowlistedHosts: [], sessionBlocked: 1 };
    h.invoke = vi.fn(async () => state);
    await import('./chromePreload');
    const api = h.exposed.aegis as AegisApi;
    const out = await api.adblock.clearAllowlist();
    expect(h.invoke).toHaveBeenCalledWith(IPC.adblockClearAllowlist);
    expect(out).toEqual(state);
  });
});
