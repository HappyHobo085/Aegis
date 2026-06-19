// src/autopilot/reach.ts
import { flushSync } from 'react-dom';
import type { AutopilotControl } from './control';
import type { ScreenSpec, ScreenId } from './screens';
import { IPC, PRIMARY_VIEW_ID } from '../../shared/types';

export interface ReachDeps {
  emitEvent(channel: string, payload: unknown): void | Promise<void>;
}

const V = PRIMARY_VIEW_ID;

/** Click a tab/button by its visible text (Settings + sidebar sub-tabs). */
export function clickTabByLabel(label: string): boolean {
  const els = Array.from(document.querySelectorAll('button,[role="tab"]')) as HTMLElement[];
  const el = els.find((e) => e.textContent?.trim() === label);
  if (el) { el.click(); return true; }
  return false;
}

const SETTINGS_TAB_LABEL: Record<string, string> = {
  appearance: 'Appearance', search: 'Search', home: 'Home', tabs: 'Tabs',
  filterLists: 'Filter Lists', myFilters: 'My Filters', allowlist: 'Allowlist',
  downloads: 'Downloads', sitePermissions: 'Site permissions', security: 'Security',
  sync: 'Sync', data: 'Data',
};

// Payloads aligned to the real interfaces in shared/types.ts:
//   NavFailed    → { viewId, errorCode, errorDescription, validatedURL, kind }
//   NavCrashed   → { viewId, reason }
//   PermissionPrompt → { requestId: number, origin, permission }
//   SafetyInterstitialPayload → { url, reason: 'https-failed' | 'malware' }
//   RedirectBlocked → { viewId, from, to }
const EVENT_PAYLOAD: Partial<Record<ScreenId, { channel: string; payload: unknown }>> = {
  errorOverlay: {
    channel: IPC.evtNavFailed,
    payload: { viewId: V, errorCode: -105, errorDescription: 'NAME_NOT_RESOLVED', validatedURL: 'https://invalid.invalid/', kind: 'load' as const },
  },
  crashOverlay: {
    channel: IPC.evtNavCrashed,
    payload: { viewId: V, reason: 'crashed' },
  },
  permissionPrompt: {
    channel: IPC.evtPermissionsPrompt,
    payload: { requestId: 1, origin: 'https://example.com', permission: 'geolocation' },
  },
  safetyInterstitial: {
    channel: IPC.evtSafetyInterstitial,
    payload: { url: 'https://malware.test/', reason: 'malware' as const },
  },
  redirectBar: {
    channel: IPC.evtRedirectBlocked,
    payload: { viewId: V, from: 'https://publisher.test/', to: 'https://malvertising.test/landing' },
  },
};

export async function reachScreen(control: AutopilotControl, screen: ScreenSpec, deps: ReachDeps): Promise<void> {
  switch (screen.via) {
    case 'state':
      control.closeSettings(); control.closeDownloads(); control.closeManager();
      control.setSidebar(false); control.setShield(false); control.exitFullscreen();
      break;
    case 'overlay':
      if (screen.id === 'downloads') control.openDownloads();
      else if (screen.id === 'favoritesManager') control.openManager();
      else if (screen.id === 'shieldPopover') control.setShield(true);
      else if (screen.id === 'fullscreen') control.enterFullscreen();
      else if (screen.id === 'confirmDialog') control.openConfirm('Autopilot confirm?');
      break;
    case 'sidebarTab':
      // Use flushSync to open the sidebar synchronously so the tab buttons are in the
      // DOM before clickTabByLabel queries them.  Without flushSync, React 18 defers
      // the setSidebar(true) state update to after the current async-act boundary, and
      // the subsequent clickTabByLabel call finds no buttons.
      flushSync(() => control.setSidebar(true));
      clickTabByLabel(screen.id === 'sidebar:history' ? 'History' : 'Saved');
      break;
    case 'settingsTab': {
      control.openSettings();
      await tick();
      const tab = screen.id.slice('settings:'.length);
      clickTabByLabel(SETTINGS_TAB_LABEL[tab] ?? tab);
      break;
    }
    case 'event': {
      const e = EVENT_PAYLOAD[screen.id];
      if (e) await deps.emitEvent(e.channel, e.payload);
      break;
    }
  }
  await tick();
}

export async function leaveScreen(control: AutopilotControl, screen: ScreenSpec, deps?: ReachDeps): Promise<void> {
  if (screen.via === 'settingsTab') control.closeSettings();
  else if (screen.id === 'downloads') control.closeDownloads();
  else if (screen.id === 'favoritesManager') control.closeManager();
  else if (screen.id === 'shieldPopover') control.setShield(false);
  else if (screen.id === 'fullscreen') control.exitFullscreen();
  else if (screen.id === 'sidebar:history' || screen.id === 'sidebar:saved') control.setSidebar(false);
  else if (screen.id === 'errorOverlay') control.clearError();
  else if (screen.id === 'crashOverlay') control.clearCrash();
  else if (screen.id === 'confirmDialog') clickTabByLabel('Cancel');
  // Event-driven overlays were shown by emitting an event; dismiss them by emitting the
  // SAME event with null (the safety/permission hooks set their state = payload, so null
  // clears it). Otherwise they linger as a full overlay and cancel later content nav.
  else if (screen.id === 'safetyInterstitial') await deps?.emitEvent(IPC.evtSafetyInterstitial, null);
  else if (screen.id === 'permissionPrompt') await deps?.emitEvent(IPC.evtPermissionsPrompt, null);
  // The redirect bar is an infobar (it can't take a null event — its handler reads
  // r.viewId), so dismiss it the way a user does: click its X. (Harmless if it lingers —
  // it shrinks the content inset, it doesn't cover the page like a full overlay.)
  else if (screen.id === 'redirectBar') (document.querySelector('.redirect-bar__dismiss') as HTMLElement | null)?.click();
  await tick();
}

function tick(): Promise<void> {
  return new Promise((r) => setTimeout(r, 0));
}
