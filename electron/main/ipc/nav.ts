// electron/main/ipc/nav.ts
import { IPC } from '../../../shared/types';
import type { NavState, NavFailed, NavCrashed, ViewId } from '../../../shared/types';
import type { ViewController, ViewControllerOpts } from '../viewController';
import type { SettingsRepo } from '../db/settingsRepo';
import type { SafetyController } from '../safety/SafetyController';

/**
 * Builds the nav/view IPC handler map (channel -> handler). Handlers receive the
 * invoke args WITHOUT the event (the guard strips it). viewId is carried by the
 * contract for tab-readiness; Phase 0 has a single ViewController.
 */
export function buildNavHandlers(
  vc: ViewController,
  settingsRepo: SettingsRepo,
  safety: SafetyController,
): Record<string, (...a: any[]) => any> {
  return {
    [IPC.navNavigate]: (_viewId: ViewId, url: string) => safety.navigate(url),
    [IPC.navBack]: (_viewId: ViewId) => vc.back(),
    [IPC.navForward]: (_viewId: ViewId) => vc.forward(),
    [IPC.navReloadOrStop]: (_viewId: ViewId) => vc.reloadOrStop(),
    [IPC.navHome]: (_viewId: ViewId) => safety.navigate(settingsRepo.get().homeUrl),
    [IPC.navGetState]: (_viewId: ViewId): NavState => vc.getState(),
    [IPC.viewSetContentVisible]: (_viewId: ViewId, visible: boolean) => vc.setVisible(visible),
  };
}

/**
 * Builds the main->chrome event forwarders that ViewController invokes (onState/
 * onFailed/onCrashed), plus onHistoryChanged which the HistoryRecorder's onChanged
 * is wired to in boot so an open history panel can refresh. Each forwarder sends the
 * matching push-event channel on the chrome WebContents.
 */
export function buildViewEventForwarders(
  chromeWc: Electron.WebContents,
): Pick<ViewControllerOpts, 'onState' | 'onFailed' | 'onCrashed'> & {
  onHistoryChanged: () => void;
} {
  return {
    onState: (s: NavState) => chromeWc.send(IPC.evtNavState, s),
    onFailed: (f: NavFailed) => chromeWc.send(IPC.evtNavFailed, f),
    onCrashed: (c: NavCrashed) => chromeWc.send(IPC.evtNavCrashed, c),
    onHistoryChanged: () => chromeWc.send(IPC.evtHistoryChanged),
  };
}
