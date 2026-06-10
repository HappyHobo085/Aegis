// electron/preload/chromePreload.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';
import type { AegisApi, NavState, BlockedCount } from '../../shared/types';

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
