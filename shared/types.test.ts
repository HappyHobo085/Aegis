import { describe, it, expect } from 'vitest';
import { IPC, PRIMARY_VIEW_ID, ALLOWED_NAV_SCHEMES } from './types';
import type { AdblockState, BlockedCount, ListUpdateResult, ListSourceResult } from './types';

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
