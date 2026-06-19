// src/autopilot/screens.ts
// The enumerable surface the autopilot walks. Single source of truth for "every screen".
import { TAB_ORDER, type SettingsTab } from '../components/SettingsModal';

export type SettingsScreenId = `settings:${SettingsTab}`;
export type OverlayScreenId =
  | 'home'
  | 'sidebar:history'
  | 'sidebar:saved'
  | 'downloads'
  | 'favoritesManager'
  | 'shieldPopover'
  | 'fullscreen'
  | 'errorOverlay'
  | 'crashOverlay'
  | 'safetyInterstitial'
  | 'permissionPrompt'
  | 'confirmDialog';
export type ScreenId = OverlayScreenId | SettingsScreenId;

export interface ScreenSpec {
  id: ScreenId;
  label: string;
  /** How the live control surface reaches it (see reach.ts). */
  via: 'overlay' | 'settingsTab' | 'sidebarTab' | 'event' | 'state';
}

export const SETTINGS_SCREENS: ScreenSpec[] = TAB_ORDER.map((t) => ({
  id: `settings:${t}` as SettingsScreenId,
  label: `Settings · ${t}`,
  via: 'settingsTab' as const,
}));

export const SCREENS: ScreenSpec[] = [
  { id: 'home', label: 'Home / toolbar', via: 'state' },
  { id: 'sidebar:history', label: 'Sidebar · History', via: 'sidebarTab' },
  { id: 'sidebar:saved', label: 'Sidebar · Saved', via: 'sidebarTab' },
  { id: 'downloads', label: 'Downloads modal', via: 'overlay' },
  { id: 'favoritesManager', label: 'Favorites manager', via: 'overlay' },
  ...SETTINGS_SCREENS,
  { id: 'shieldPopover', label: 'Ad-block shield popover', via: 'overlay' },
  { id: 'fullscreen', label: 'Fullscreen', via: 'overlay' },
  { id: 'errorOverlay', label: 'Nav error overlay', via: 'event' },
  { id: 'crashOverlay', label: 'Crash overlay', via: 'event' },
  { id: 'safetyInterstitial', label: 'Safety interstitial', via: 'event' },
  { id: 'permissionPrompt', label: 'Permission prompt', via: 'event' },
  { id: 'confirmDialog', label: 'Confirm dialog', via: 'overlay' },
];
