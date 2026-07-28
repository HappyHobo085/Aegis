// src/lib/commandPaletteData.ts
//
// Data-gathering module for the command palette.
// Each function queries the relevant IPC source and returns fuzzy-searchable results.

import { aegis } from './ipcClient';
import { TAB_ORDER } from '../components/SettingsModal';
import type { SettingsTab } from '../components/SettingsModal';
import { fuzzyMatch } from './fuzzySearch';

export interface PaletteResult {
  id: string;
  title: string;
  subtitle?: string;
  category: 'tabs' | 'bookmarks' | 'history' | 'actions' | 'settings';
  action: () => void | Promise<void>;
  icon?: string;
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
        action: () => aegis.nav.navigate(1, fav.url),
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
        action: () => aegis.nav.navigate(1, entry.url),
        icon: '🕐',
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Action results (static, always available)
// ---------------------------------------------------------------------------

export function getActionResults(query: string): PaletteResult[] {
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
      action: () => aegis.nav.back(1),
      icon: '◀',
    },
    {
      id: 'action.forward',
      title: 'Go forward',
      subtitle: 'Navigate to the next page',
      category: 'actions',
      action: () => aegis.nav.forward(1),
      icon: '▶',
    },
    {
      id: 'action.reload',
      title: 'Reload',
      subtitle: 'Refresh the current page',
      category: 'actions',
      action: () => aegis.nav.reloadOrStop(1),
      icon: '🔄',
    },
    {
      id: 'action.home',
      title: 'Home',
      subtitle: 'Navigate to the home page',
      category: 'actions',
      action: () => aegis.nav.home(1),
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
        const state = await aegis.adblock.getState();
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
  security: 'Security',
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
  security: 'Safety, WebRTC, and fingerprinting',
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
