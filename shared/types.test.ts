import { describe, it, expect } from 'vitest';
import { IPC, PRIMARY_VIEW_ID, ALLOWED_NAV_SCHEMES } from './types';
import type {
  AdblockState,
  BlockedCount,
  ListUpdateResult,
  ListSourceResult,
  Favorite,
  HistoryEntry,
  SavedItem,
  ContentInset,
} from './types';

describe('shared/types', () => {
  it('exposes the IPC channel constants', () => {
    expect(IPC.navNavigate).toBe('nav.navigate');
    expect(IPC.navGetState).toBe('nav.getState');
    expect(IPC.viewSetContentVisible).toBe('view.setContentVisible');
    expect(IPC.settingsGet).toBe('settings.get');
    expect(IPC.evtNavState).toBe('nav.state');
    expect(IPC.evtNavFailed).toBe('nav.failed');
    expect(IPC.evtNavCrashed).toBe('nav.crashed');
  });

  it('uses the primary view id and the nav-scheme allowlist', () => {
    expect(PRIMARY_VIEW_ID).toBe(1);
    expect(ALLOWED_NAV_SCHEMES).toEqual(['https:', 'http:']);
  });

  it('exposes the Phase-1 adblock + lists IPC channel constants', () => {
    expect(IPC.adblockSetEnabled).toBe('adblock.setEnabled');
    expect(IPC.adblockToggleAllowlist).toBe('adblock.toggleAllowlist');
    expect(IPC.adblockGetState).toBe('adblock.getState');
    expect(IPC.listsUpdateNow).toBe('lists.updateNow');
    expect(IPC.evtAdblockBlockedCount).toBe('adblock.blockedCount');
  });

  it('admits the Phase-1 data-model shapes', () => {
    const state: AdblockState = { enabled: true, allowlistedHosts: ['example.com'], sessionBlocked: 5 };
    expect(state.allowlistedHosts).toContain('example.com');

    const count: BlockedCount = { viewId: PRIMARY_VIEW_ID, page: 2, session: 9 };
    expect(count.viewId).toBe(PRIMARY_VIEW_ID);

    const src: ListSourceResult = { listId: 'easylist', ok: false, error: 'timeout' };
    const result: ListUpdateResult = { perSource: [src], lastUpdated: 1234 };
    expect(result.perSource[0].ok).toBe(false);
    expect(result.lastUpdated).toBe(1234);
  });
});

describe('shared/types — Phase 3 additions', () => {
  it('exposes the favorites IPC channel constants', () => {
    expect(IPC.favoritesList).toBe('favorites.list');
    expect(IPC.favoritesAdd).toBe('favorites.add');
    expect(IPC.favoritesUpdate).toBe('favorites.update');
    expect(IPC.favoritesRemove).toBe('favorites.remove');
    expect(IPC.favoritesReorder).toBe('favorites.reorder');
    expect(IPC.favoritesRenameTag).toBe('favorites.renameTag');
    expect(IPC.favoritesDeleteTag).toBe('favorites.deleteTag');
    expect(IPC.favoritesTagUnion).toBe('favorites.tagUnion');
  });

  it('exposes the history IPC channel constants (incl. the changed event)', () => {
    expect(IPC.historyList).toBe('history.list');
    expect(IPC.historySearch).toBe('history.search');
    expect(IPC.historyRemove).toBe('history.remove');
    expect(IPC.historyClear).toBe('history.clear');
    expect(IPC.evtHistoryChanged).toBe('history.changed');
  });

  it('exposes the saved-list IPC channel constants', () => {
    expect(IPC.savedList).toBe('saved.list');
    expect(IPC.savedAdd).toBe('saved.add');
    expect(IPC.savedRemove).toBe('saved.remove');
    expect(IPC.savedHas).toBe('saved.has');
  });

  it('exposes the view.setContentInset channel constant', () => {
    expect(IPC.viewSetContentInset).toBe('view.setContentInset');
  });

  it('admits the Phase-3 data-model shapes', () => {
    const fav: Favorite = { id: 1, name: 'Example', url: 'https://example.com/', tags: ['news'], position: 0 };
    expect(fav.tags).toEqual(['news']);

    const entry: HistoryEntry = { id: 2, url: 'https://a.test/', title: 'A', visitedAt: 1234 };
    expect(entry.visitedAt).toBe(1234);

    const saved: SavedItem = { id: 3, url: 'https://b.test/', title: 'B', savedAt: 5678 };
    expect(saved.savedAt).toBe(5678);

    const inset: ContentInset = { top: 96, left: 280 };
    expect(inset).toEqual({ top: 96, left: 280 });
  });
});
