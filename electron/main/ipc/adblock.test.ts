// electron/main/ipc/adblock.test.ts
import { describe, it, expect, vi } from 'vitest';
import { IPC } from '../../../shared/types';
import type { AdblockState } from '../../../shared/types';
import { buildAdblockHandlers } from './adblock';

function makeController(state: AdblockState) {
  return {
    setEnabled: vi.fn((enabled: boolean): AdblockState => ({ ...state, enabled })),
    toggleAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: [...state.allowlistedHosts, host],
    })),
    getState: vi.fn((): AdblockState => state),
    removeAllowlist: vi.fn((host: string): AdblockState => ({
      ...state,
      allowlistedHosts: state.allowlistedHosts.filter((h) => h !== host),
    })),
    clearAllowlist: vi.fn((): AdblockState => ({ ...state, allowlistedHosts: [] })),
  };
}

describe('buildAdblockHandlers', () => {
  const base: AdblockState = { enabled: true, allowlistedHosts: [], sessionBlocked: 5 };

  it('registers exactly the five adblock channels', () => {
    const handlers = buildAdblockHandlers(makeController(base) as any);
    expect(Object.keys(handlers).sort()).toEqual(
      [
        IPC.adblockSetEnabled,
        IPC.adblockToggleAllowlist,
        IPC.adblockGetState,
        IPC.adblockRemoveAllowlist,
        IPC.adblockClearAllowlist,
      ].sort(),
    );
  });

  it('adblockSetEnabled forwards the flag to controller.setEnabled and returns the state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockSetEnabled](false);
    expect(c.setEnabled).toHaveBeenCalledWith(false);
    expect(result).toEqual({ ...base, enabled: false });
  });

  it('adblockToggleAllowlist forwards the host and returns the new state', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockToggleAllowlist]('example.com');
    expect(c.toggleAllowlist).toHaveBeenCalledWith('example.com');
    expect(result.allowlistedHosts).toContain('example.com');
  });

  it('adblockGetState returns controller.getState()', () => {
    const c = makeController(base);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockGetState]();
    expect(c.getState).toHaveBeenCalledTimes(1);
    expect(result).toEqual(base);
  });

  it('adblockRemoveAllowlist forwards the host and returns the new state', () => {
    const seeded: AdblockState = { enabled: true, allowlistedHosts: ['a.test', 'b.test'], sessionBlocked: 5 };
    const c = makeController(seeded);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockRemoveAllowlist]('a.test');
    expect(c.removeAllowlist).toHaveBeenCalledWith('a.test');
    expect(result.allowlistedHosts).toEqual(['b.test']);
  });

  it('adblockClearAllowlist clears and returns the new state', () => {
    const seeded: AdblockState = { enabled: true, allowlistedHosts: ['a.test'], sessionBlocked: 5 };
    const c = makeController(seeded);
    const handlers = buildAdblockHandlers(c as any);
    const result = handlers[IPC.adblockClearAllowlist]();
    expect(c.clearAllowlist).toHaveBeenCalledTimes(1);
    expect(result.allowlistedHosts).toEqual([]);
  });
});
