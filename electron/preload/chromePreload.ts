// electron/preload/chromePreload.ts
import { contextBridge, ipcRenderer } from 'electron';
import { IPC } from '../../shared/types';
import type { AegisApi, ViewId, NavState, NavFailed, NavCrashed, Settings } from '../../shared/types';

/** Subscribes cb to an event channel; returns an unsubscriber. */
function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: unknown, payload: T) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: AegisApi = {
  nav: {
    navigate: (viewId: ViewId, url: string) => ipcRenderer.invoke(IPC.navNavigate, viewId, url),
    back: (viewId: ViewId) => ipcRenderer.invoke(IPC.navBack, viewId),
    forward: (viewId: ViewId) => ipcRenderer.invoke(IPC.navForward, viewId),
    reloadOrStop: (viewId: ViewId) => ipcRenderer.invoke(IPC.navReloadOrStop, viewId),
    home: (viewId: ViewId) => ipcRenderer.invoke(IPC.navHome, viewId),
    getState: (viewId: ViewId): Promise<NavState> => ipcRenderer.invoke(IPC.navGetState, viewId),
    onState: (cb: (s: NavState) => void) => subscribe<NavState>(IPC.evtNavState, cb),
    onFailed: (cb: (f: NavFailed) => void) => subscribe<NavFailed>(IPC.evtNavFailed, cb),
    onCrashed: (cb: (c: NavCrashed) => void) => subscribe<NavCrashed>(IPC.evtNavCrashed, cb),
  },
  view: {
    setContentVisible: (viewId: ViewId, visible: boolean) =>
      ipcRenderer.invoke(IPC.viewSetContentVisible, viewId, visible),
  },
  settings: {
    get: (): Promise<Settings> => ipcRenderer.invoke(IPC.settingsGet),
    set: (partial: Partial<Settings>): Promise<Settings> => ipcRenderer.invoke(IPC.settingsSet, partial),
  },
};

contextBridge.exposeInMainWorld('aegis', api);
