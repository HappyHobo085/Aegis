// electron/main/ipc/nav.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC, PRIMARY_VIEW_ID } from '../../../shared/types';
import type { NavState, NavFailed, NavCrashed, Settings } from '../../../shared/types';
import { buildNavHandlers, buildViewEventForwarders } from './nav';

function makeVc() {
  return {
    navigate: vi.fn(),
    back: vi.fn(),
    forward: vi.fn(),
    reloadOrStop: vi.fn(),
    getState: vi.fn((): NavState => ({
      viewId: PRIMARY_VIEW_ID,
      url: 'https://example.com/',
      title: 'Example',
      canGoBack: false,
      canGoForward: false,
      isLoading: false,
      crashed: false,
    })),
    setVisible: vi.fn(),
  };
}

function makeRepo(homeUrl: string) {
  const settings = { homeUrl } as Settings;
  return { get: vi.fn(() => settings) };
}

describe('buildNavHandlers', () => {
  it('navNavigate forwards (viewId,url) to vc.navigate(url)', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.navNavigate](PRIMARY_VIEW_ID, 'https://example.com/');
    expect(vc.navigate).toHaveBeenCalledWith('https://example.com/');
  });

  it('navBack / navForward / navReloadOrStop call the matching vc method', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.navBack](PRIMARY_VIEW_ID);
    handlers[IPC.navForward](PRIMARY_VIEW_ID);
    handlers[IPC.navReloadOrStop](PRIMARY_VIEW_ID);
    expect(vc.back).toHaveBeenCalledTimes(1);
    expect(vc.forward).toHaveBeenCalledTimes(1);
    expect(vc.reloadOrStop).toHaveBeenCalledTimes(1);
  });

  it('navHome reads homeUrl from the repo at call time and navigates it', () => {
    const vc = makeVc();
    const repo = makeRepo('https://duck.example/');
    const handlers = buildNavHandlers(vc as any, repo as any);
    handlers[IPC.navHome](PRIMARY_VIEW_ID);
    expect(repo.get).toHaveBeenCalled();
    expect(vc.navigate).toHaveBeenCalledWith('https://duck.example/');
  });

  it('navGetState returns vc.getState()', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    const state = handlers[IPC.navGetState](PRIMARY_VIEW_ID);
    expect(state.url).toBe('https://example.com/');
    expect(vc.getState).toHaveBeenCalledTimes(1);
  });

  it('viewSetContentVisible forwards (viewId,visible) to vc.setVisible(visible)', () => {
    const vc = makeVc();
    const handlers = buildNavHandlers(vc as any, makeRepo('https://home/') as any);
    handlers[IPC.viewSetContentVisible](PRIMARY_VIEW_ID, false);
    expect(vc.setVisible).toHaveBeenCalledWith(false);
  });
});

describe('buildViewEventForwarders', () => {
  it('onState/onFailed/onCrashed send the matching event channel on the chrome wc', () => {
    const send = vi.fn();
    const chromeWc = { send } as any;
    const fwd = buildViewEventForwarders(chromeWc);

    const s: NavState = {
      viewId: PRIMARY_VIEW_ID, url: 'https://e/', title: 't',
      canGoBack: false, canGoForward: false, isLoading: false, crashed: false,
    };
    const f: NavFailed = {
      viewId: PRIMARY_VIEW_ID, errorCode: -202, errorDescription: 'CERT',
      validatedURL: 'https://e/', kind: 'cert',
    };
    const c: NavCrashed = { viewId: PRIMARY_VIEW_ID, reason: 'crashed' };

    fwd.onState(s);
    fwd.onFailed(f);
    fwd.onCrashed(c);

    expect(send).toHaveBeenCalledWith(IPC.evtNavState, s);
    expect(send).toHaveBeenCalledWith(IPC.evtNavFailed, f);
    expect(send).toHaveBeenCalledWith(IPC.evtNavCrashed, c);
  });
});

describe('buildViewEventForwarders — history.changed', () => {
  it('exposes onHistoryChanged that sends IPC.evtHistoryChanged with no payload', () => {
    const send = vi.fn();
    const chromeWc = { send } as unknown as Electron.WebContents;
    const fwd = buildViewEventForwarders(chromeWc);
    expect(typeof fwd.onHistoryChanged).toBe('function');
    fwd.onHistoryChanged();
    expect(send).toHaveBeenCalledWith(IPC.evtHistoryChanged);
  });
});
