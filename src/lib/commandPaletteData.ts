// src/lib/commandPaletteData.ts
//
// Data-gathering module for the command palette.
// Each function queries the relevant IPC source and returns fuzzy-searchable results.

import { aegis } from './ipcClient';
import { TAB_ORDER } from '../components/SettingsModal';
import type { SettingsTab } from '../components/SettingsModal';
import type { ViewId } from '../../shared/types';
import { fuzzyMatch } from './fuzzySearch';

export interface PaletteResult {
  id: string;
  title: string;
  subtitle?: string;
  category: 'tabs' | 'bookmarks' | 'history' | 'actions' | 'settings';
  action: () => void | Promise<void>;
  icon?: string;
}

/**
 * The view the palette should act on: the currently active tab.
 *
 * Every navigation command used to hardcode `PRIMARY_VIEW_ID` (1), which meant on a multi-tab
 * session "Go back" / "Reload" / "Home" / a bookmark silently drove tab 1 while the tab the user
 * was looking at appeared to ignore the command. Resolve the real active id at invoke time —
 * NOT at palette-build time — so the command always targets whatever is focused when it runs.
 */
async function activeViewId(): Promise<number> {
  const tabs = await aegis.tabs.list();
  return tabs.activeId;
}

// ---------------------------------------------------------------------------
// Tab results
// ---------------------------------------------------------------------------

export async function getTabResults(query: string): Promise<PaletteResult[]> {
  const state = await aegis.tabs.list();
  const results: PaletteResult[] = [];
  for (const tab of state.tabs) {
    const label = tab.title || tab.url || `Tab ${tab.id}`;
    const match = fuzzyMatch(query, label);
    if (match !== null) {
      results.push({
        id: `tab:${tab.id}`,
        title: label,
        subtitle: tab.url,
        category: 'tabs',
        action: () => {
          void aegis.tabs.activate(tab.id);
        },
        icon: tab.private ? '🕵️' : '📄',
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Bookmark results
// ---------------------------------------------------------------------------

export async function getBookmarkResults(query: string): Promise<PaletteResult[]> {
  const favs = await aegis.favorites.list();
  const results: PaletteResult[] = [];
  for (const fav of favs) {
    const match = fuzzyMatch(query, fav.name);
    if (match !== null) {
      results.push({
        id: `bookmark:${fav.id}`,
        title: fav.name,
        subtitle: fav.url,
        category: 'bookmarks',
        action: async () => {
          await aegis.nav.navigate(await activeViewId(), fav.url);
        },
        icon: '⭐',
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// History results
// ---------------------------------------------------------------------------

export async function getHistoryResults(query: string): Promise<PaletteResult[]> {
  const entries = await aegis.history.list({ limit: 200 });
  const results: PaletteResult[] = [];
  for (const entry of entries) {
    const label = entry.title || entry.url;
    const match = fuzzyMatch(query, label);
    if (match !== null) {
      results.push({
        id: `history:${entry.id}`,
        title: label,
        subtitle: entry.url,
        category: 'history',
        action: async () => {
          await aegis.nav.navigate(await activeViewId(), entry.url);
        },
        icon: '🕐',
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Action results (static, always available)
// ---------------------------------------------------------------------------

/// `viewId` is the ACTIVE tab, passed in rather than read from a module global because this
/// file is deliberately pure (see the comment in App.tsx). The palette's ad-block action
/// reads only the global `enabled` flag, but `adblock.getState` also reports the view's
/// `pageBlocked` and is deduped by payload — so it must be told which view it is asking
/// about rather than send a payload-less call that shares one cache key with every other
/// caller.
export function getActionResults(query: string, viewId: ViewId): PaletteResult[] {
  const actions: PaletteResult[] = [
    // Tab actions
    {
      id: 'action.newTab',
      title: 'New tab',
      subtitle: 'Open a new tab',
      category: 'actions',
      action: () => aegis.tabs.create(),
      icon: '➕',
    },
    {
      id: 'action.newPrivateTab',
      title: 'New private tab',
      subtitle: 'Open a new incognito tab',
      category: 'actions',
      action: () => aegis.tabs.create(undefined, false, true),
      icon: '🕵️',
    },

    // Navigation actions
    {
      id: 'action.back',
      title: 'Go back',
      subtitle: 'Navigate to the previous page',
      category: 'actions',
      action: async () => {
        await aegis.nav.back(await activeViewId());
      },
      icon: '◀',
    },
    {
      id: 'action.forward',
      title: 'Go forward',
      subtitle: 'Navigate to the next page',
      category: 'actions',
      action: async () => {
        await aegis.nav.forward(await activeViewId());
      },
      icon: '▶',
    },
    {
      id: 'action.reload',
      title: 'Reload',
      subtitle: 'Refresh the current page',
      category: 'actions',
      action: async () => {
        await aegis.nav.reloadOrStop(await activeViewId());
      },
      icon: '🔄',
    },
    {
      id: 'action.home',
      title: 'Home',
      subtitle: 'Navigate to the home page',
      category: 'actions',
      action: async () => {
        await aegis.nav.home(await activeViewId());
      },
      icon: '🏠',
    },

    // Zoom actions
    {
      id: 'action.zoomIn',
      title: 'Zoom in',
      subtitle: 'Increase page zoom level',
      category: 'actions',
      action: async () => {
        const tabs = await aegis.tabs.list();
        const activeId = tabs.activeId;
        const state = await aegis.zoom.get(activeId);
        await aegis.zoom.set(activeId, state.factor + 0.1);
      },
      icon: '🔍',
    },
    {
      id: 'action.zoomOut',
      title: 'Zoom out',
      subtitle: 'Decrease page zoom level',
      category: 'actions',
      action: async () => {
        const tabs = await aegis.tabs.list();
        const activeId = tabs.activeId;
        const state = await aegis.zoom.get(activeId);
        await aegis.zoom.set(activeId, state.factor - 0.1);
      },
      icon: '➖',
    },
    {
      id: 'action.zoomReset',
      title: 'Reset zoom',
      subtitle: 'Reset zoom to 100%',
      category: 'actions',
      action: async () => {
        const tabs = await aegis.tabs.list();
        const activeId = tabs.activeId;
        await aegis.zoom.reset(activeId);
      },
      icon: '💯',
    },

    // Find
    {
      id: 'action.findInPage',
      title: 'Find in page',
      subtitle: 'Search for text on this page',
      category: 'actions',
      action: () => {
        // Dispatch a keyboard event that App.tsx listens for (Ctrl+F)
        window.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true }),
        );
      },
      icon: '🔎',
    },

    // Ad-block toggle
    {
      id: 'action.toggleAdblock',
      title: 'Toggle ad-block',
      subtitle: 'Enable or disable ad blocking',
      category: 'actions',
      action: async () => {
        const state = await aegis.adblock.getState(viewId);
        await aegis.adblock.setEnabled(!state.enabled);
      },
      icon: '🛡️',
    },

    // Sidebar toggle
    {
      id: 'action.toggleSidebar',
      title: 'Toggle sidebar',
      subtitle: 'Show or hide the sidebar',
      category: 'actions',
      action: () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleSidebar'));
      },
      icon: '📋',
    },

    // Favorites bar toggle
    {
      id: 'action.toggleFavoritesBar',
      title: 'Toggle favorites bar',
      subtitle: 'Show or hide the favorites bar',
      category: 'actions',
      action: () => {
        window.dispatchEvent(new CustomEvent('aegis:toggleFavoritesBar'));
      },
      icon: '⭐',
    },

    // Open the sidebar on a SPECIFIC tab. `aegis:toggleSidebar` alone can only ever land on
    // whatever tab the sidebar was last showing, and the shell's own default is 'saved' —
    // so "I want History" was unreachable from the keyboard, and App's
    // `setSidebarInitialTab` had no call site at all. This is the seam that reaches it.
    {
      id: 'action.openSidebarHistory',
      title: 'Open history',
      subtitle: 'Open the sidebar on History',
      category: 'actions',
      action: () => {
        window.dispatchEvent(new CustomEvent('aegis:openSidebar', { detail: { tab: 'history' } }));
      },
      icon: '🕘',
    },
    {
      id: 'action.openSidebarSaved',
      title: 'Open saved pages',
      subtitle: 'Open the sidebar on Saved',
      category: 'actions',
      action: () => {
        window.dispatchEvent(new CustomEvent('aegis:openSidebar', { detail: { tab: 'saved' } }));
      },
      icon: '🔖',
    },
  ];

  return actions.filter(
    (a) => fuzzyMatch(query, a.title) !== null || fuzzyMatch(query, a.subtitle ?? '') !== null,
  );
}

// ---------------------------------------------------------------------------
// Settings results (derived from SettingsModal TAB_ORDER)
// ---------------------------------------------------------------------------

const SETTINGS_LABELS: Record<SettingsTab, string> = {
  appearance: 'Appearance',
  search: 'Search',
  home: 'Home',
  tabs: 'Tabs',
  filterLists: 'Filter Lists',
  myFilters: 'My Filters',
  allowlist: 'Allowlist',
  downloads: 'Downloads',
  sitePermissions: 'Site permissions',
  security: 'Overview',
  https: 'HTTPS',
  webrtc: 'WebRTC',
  fingerprint: 'Fingerprinting',
  proxy: 'Proxy',
  vault: 'Passwords',
  sync: 'Sync',
  data: 'Data',
};

const SETTINGS_ICONS: Record<SettingsTab, string> = {
  appearance: '🎨',
  search: '🔍',
  home: '🏠',
  tabs: '📑',
  filterLists: '📜',
  myFilters: '✍️',
  allowlist: '✅',
  downloads: '⬇️',
  sitePermissions: '🔒',
  security: '🛡️',
  https: '🔗',
  webrtc: '📡',
  fingerprint: '🧬',
  proxy: '🌐',
  vault: '🔑',
  sync: '🔄',
  data: '💾',
};

const SETTINGS_SUBTITLES: Record<SettingsTab, string> = {
  appearance: 'Theme, accent, and visual preferences',
  search: 'Default search behavior',
  home: 'Home page and start destination',
  tabs: 'Tab behavior and private browsing',
  filterLists: 'Built-in and subscribed block lists',
  myFilters: 'Custom blocking rules',
  allowlist: 'Sites exempt from ad blocking',
  downloads: 'File download behavior',
  sitePermissions: 'Camera, microphone, and site access',
  security: 'Your overall protection status',
  https: 'Force a secure connection',
  webrtc: 'Local IP leak protection',
  fingerprint: 'Anti-fingerprinting noise',
  proxy: 'Network proxy routing',
  vault: 'Saved passwords and vault lock',
  sync: 'Encrypted sync across devices',
  data: 'Import, export, and local data controls',
};

export function getSettingsResults(query: string): PaletteResult[] {
  const results: PaletteResult[] = [];
  for (const tab of TAB_ORDER) {
    const label = SETTINGS_LABELS[tab];
    const match = fuzzyMatch(query, label);
    if (match !== null) {
      results.push({
        id: `settings:${tab}`,
        title: label,
        subtitle: SETTINGS_SUBTITLES[tab],
        category: 'settings',
        action: () => {
          window.dispatchEvent(new CustomEvent('aegis:openSettings', { detail: { tab } }));
        },
        icon: SETTINGS_ICONS[tab],
      });
    }
  }
  return results;
}
