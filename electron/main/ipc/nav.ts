// electron/main/ipc/nav.ts
import { IPC } from '../../../shared/types';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../../shared/types';
import type { ViewController, ViewControllerOpts } from '../viewController';
import type { SettingsRepo } from '../db/settingsRepo';

/**
 * Builds the nav/view IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). viewId is carried by the
 * contract for tab-readiness; Phase 0 has a single ViewController.
 */
export function buildNavHandlers(
  vc: ViewController,
  settingsRepo: SettingsRepo,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.navNavigate]: (_viewId: ViewId, url: string) => vc.navigate(url),
    [IPC.navBack]: (_viewId: ViewId) => vc.back(),
    [IPC.navForward]: (_viewId: ViewId) => vc.forward(),
    [IPC.navReloadOrStop]: (_viewId: ViewId) => vc.reloadOrStop(),
    [IPC.navHome]: (_viewId: ViewId) => vc.navigate(settingsRepo.get().homeUrl),
    [IPC.navGetState]: (_viewId: ViewId): NavState => vc.getState(),
    [IPC.viewSetContentVisible]: (_viewId: ViewId, visible: boolean) => vc.setVisible(visible),
  };
}

/**
 * Builds the main->chrome event forwarders that ViewController invokes. Each
 * forwarder sends the matching push-event channel on the chrome WebContents.
 */
export function buildViewEventForwarders(
  chromeWc: Electron.WebContents,
): Pick<ViewControllerOpts, 'onState' | 'onFailed' | 'onCrashed'> {
  return {
    onState: (s: NavState) => chromeWc.send(IPC.evtNavState, s),
    onFailed: (f: NavFailed) => chromeWc.send(IPC.evtNavFailed, f),
    onCrashed: (c: NavCrashed) => chromeWc.send(IPC.evtNavCrashed, c),
  };
}
